import { describe, expect, it } from 'vitest';
import {
  decodeSession,
  memorySession,
  Session,
  amountDue,
  checkRegistration,
  checkTeamRules,
  formatDateIST,
  formatIST,
  formatMoney,
  fromISTInput,
  linkFor,
  memberFields,
  missingRequired,
  paiseToRupees,
  rupeesToPaise,
  type Schemas,
  teamDisplayStatus,
  teamFields,
  toAnswers,
  toDraft,
} from '../src';

const field = (over: Partial<Schemas['EventField']>): Schemas['EventField'] =>
  ({
    id: 'f',
    scope: 'member',
    filledBy: 'member',
    label: 'F',
    help: null,
    type: 'short_text',
    options: [],
    required: false,
    unique: false,
    pattern: null,
    position: 0,
    ...over,
  }) as Schemas['EventField'];

function team(over: Partial<Schemas['Team']> = {}): Schemas['Team'] {
  return {
    id: 't',
    name: 'T',
    leaderRegistrationId: 'r1',
    createdAt: '',
    status: 'registered',
    belowMinimum: false,
    answers: {},
    members: [],
    payment: { mode: 'none', amountDue: null, currency: null, deadline: null, proofs: [] },
    ...over,
  } as Schemas['Team'];
}

describe('dates and money', () => {
  it('shows IST and converts form inputs', () => {
    expect(formatIST('2026-10-31T03:30:00.000Z')).toBe('31 Oct 2026, 9:00 am IST');
    expect(formatDateIST('2026-10-31T20:00:00.000Z')).toBe('1 Nov 2026');
    expect(fromISTInput('2026-10-31T09:00')).toBe('2026-10-31T03:30:00.000Z');
  });
  it('formats paise', () => {
    expect(formatMoney(50000, 'INR')).toBe('₹500');
    expect(formatMoney(50050)).toBe('₹500.50');
    expect(formatMoney(100, null)).toBe('₹1');
    expect(rupeesToPaise(5.5)).toBe(550);
    expect(paiseToRupees(550)).toBe(5.5);
    expect(amountDue({ paymentMode: 'at_registration', registrationFee: 50000 }, 3)).toBe(150000);
    expect(amountDue({ paymentMode: 'none', registrationFee: 50000 }, 3)).toBe(0);
    expect(amountDue({ paymentMode: 'after_shortlist', registrationFee: null }, 3)).toBe(0);
  });
});

describe('fields and rules', () => {
  const fields = [
    field({ id: 'title', scope: 'team', required: true, label: 'Title' }),
    field({ id: 'dept', type: 'choice' }),
    field({ id: 'age', type: 'number', required: true, label: 'Age' }),
  ];
  it('splits fields and turns drafts into answers', () => {
    expect(teamFields(fields).map((f) => f.id)).toEqual(['title']);
    expect(memberFields(fields).map((f) => f.id)).toEqual(['dept', 'age']);
    expect(toAnswers(fields, { age: ' 19 ', dept: '', title: 'X' })).toEqual({
      age: 19,
      dept: null,
      title: 'X',
    });
    expect(toDraft({ age: 19 })).toEqual({ age: '19' });
    expect(toDraft(undefined)).toEqual({});
    expect(missingRequired(fields, { title: ' ' }).map((f) => f.id)).toEqual(['title', 'age']);
  });
  it('checks team rules', () => {
    const rule = {
      id: 'r',
      fieldId: 'dept',
      fieldLabel: 'Dept',
      value: 'CSE',
      minCount: 2,
      description: 'At least 2 members with Dept: CSE',
    };
    expect(checkTeamRules([rule], [{ dept: 'CSE' }, { dept: 'ECE' }])).toEqual([
      { rule, count: 1, met: false },
    ]);
  });
  it('checkRegistration explains everything that blocks sending the form', () => {
    const rule = {
      id: 'r',
      fieldId: 'dept',
      fieldLabel: 'Dept',
      value: 'CSE',
      minCount: 2,
      description: 'At least 2 members with Dept: CSE',
    };
    const asha = { name: 'Asha', email: 'a@x.co', phone: '+91 9', answers: { dept: 'CSE' } };
    const blocked = checkRegistration(
      {
        team: { name: ' ' },
        members: [asha, { ...asha, name: '', answers: { dept: 'ECE' } }],
      },
      { minTeamSize: 3, maxTeamSize: 4 },
      fields,
      [rule],
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons).toEqual([
      'Give the team a name.',
      'A team needs 3–4 members; this one has 2.',
      'Member 2: name, email and phone are needed.',
      'a@x.co appears twice.',
      'At least 2 members with Dept: CSE (has 1).',
      'Missing details: Title; Asha: Age; Member 2: Age.',
    ]);
    expect(blocked.missing).toHaveLength(3);
    const fine = checkRegistration(
      {
        team: { name: 'T', answers: { title: 'X' } },
        members: [{ ...asha, answers: undefined as never }],
      },
      { minTeamSize: 1, maxTeamSize: 4 },
      [fields[0]!],
      [],
    );
    expect(fine).toMatchObject({ ok: true, reasons: [] });
  });
});

describe('status and links', () => {
  it('reads a pending receipt as confirmation pending', () => {
    const proof = { status: 'pending' } as never;
    expect(teamDisplayStatus(team())).toBe('registered');
    expect(
      teamDisplayStatus(
        team({
          status: 'registered',
          payment: { ...team().payment, proofs: [proof] },
        }),
      ),
    ).toBe('confirmation_pending');
    expect(
      teamDisplayStatus(
        team({
          status: 'confirmed',
          payment: { ...team().payment, proofs: [proof] },
        }),
      ),
    ).toBe('confirmed');
  });
  it('builds share links', () => {
    expect(linkFor('https://club.site/join/{token}?ref=1', 'a b')).toBe(
      'https://club.site/join/a%20b?ref=1',
    );
    expect(linkFor('https://club.site/t/', 'tok')).toBe('https://club.site/t/tok');
  });
});

describe('decodeSession', () => {
  const jwt = (claims: object) =>
    `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
  it('reads the kind, id, event and expiry', () => {
    expect(decodeSession(jwt({ sub: 'r1', kind: 'participant', eventId: 'e1', exp: 10 }))).toEqual({
      kind: 'participant',
      id: 'r1',
      eventId: 'e1',
      expiresAt: new Date(10_000),
    });
    expect(decodeSession(jwt({ sub: 'u1', kind: 'client' }))).toEqual({
      kind: 'client',
      id: 'u1',
      eventId: null,
      expiresAt: null,
    });
    expect(
      new Session(memorySession(jwt({ sub: 'u', kind: 'staff', eventId: 'e' }))).who?.kind,
    ).toBe('staff');
  });
  it('is null for anything else', () => {
    for (const t of [
      null,
      '',
      'abc',
      'a.!!!.c',
      jwt({ kind: 'staff' }),
      jwt({ sub: 'x', kind: 'admin' }),
    ]) {
      expect(decodeSession(t)).toBeNull();
    }
  });
});
