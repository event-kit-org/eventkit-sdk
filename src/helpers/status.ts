import type { Schemas } from '../types';
import {
  type Answers,
  checkTeamRules,
  type Field,
  memberFields,
  missingRequired,
  type RuleCheck,
  teamFields,
  type TeamRule,
  toDraft,
} from './fields';

export type DisplayStatus = Schemas['RegistrationStatus'] | 'confirmation_pending';

/** A team's status as people read it: a receipt waiting for review is "confirmation pending". */
export function teamDisplayStatus(team: Schemas['Team']): DisplayStatus {
  const latest = team.payment.proofs[0]?.status ?? null;
  if ((team.status === 'registered' || team.status === 'shortlisted') && latest === 'pending') {
    return 'confirmation_pending';
  }
  return team.status;
}

/** What a registration form holds before it is sent (`portal.register`'s input). */
export interface RegistrationDraft {
  team: { name: string; answers?: Answers };
  members: { name: string; email: string; phone: string; answers?: Answers }[];
}

export interface RegistrationCheck {
  ok: boolean;
  /** Human-readable reasons the team can't register yet. */
  reasons: string[];
  rules: RuleCheck[];
  missing: string[];
}

/**
 * Checks a registration form before sending it: team size, repeated emails,
 * required details and the event's team rules, with reasons people can read.
 * The API checks all of this again (and capacity, the window and uniqueness).
 */
export function checkRegistration(
  draft: RegistrationDraft,
  event: Pick<Schemas['PortalInfo']['event'], 'minTeamSize' | 'maxTeamSize'>,
  fields: Field[],
  rules: TeamRule[],
): RegistrationCheck {
  const reasons: string[] = [];
  const count = draft.members.length;
  if (!draft.team.name.trim()) reasons.push('Give the team a name.');
  if (count < event.minTeamSize || count > event.maxTeamSize) {
    reasons.push(
      `A team needs ${event.minTeamSize}–${event.maxTeamSize} members; this one has ${count}.`,
    );
  }
  for (const [i, m] of draft.members.entries()) {
    if (!m.name.trim() || !m.email.trim() || !m.phone.trim()) {
      reasons.push(`Member ${i + 1}: name, email and phone are needed.`);
    }
  }
  const emails = draft.members.map((m) => m.email.trim().toLowerCase()).filter(Boolean);
  const repeated = emails.find((e, i) => emails.indexOf(e) !== i);
  if (repeated) reasons.push(`${repeated} appears twice.`);

  const ruleChecks = checkTeamRules(
    rules,
    draft.members.map((m) => m.answers ?? {}),
  );
  for (const c of ruleChecks.filter((r) => !r.met)) {
    reasons.push(`${c.rule.description} (has ${c.count}).`);
  }
  const missing = [
    ...missingRequired(teamFields(fields), toDraft(draft.team.answers)).map((f) => f.label),
    ...draft.members.flatMap((m, i) =>
      missingRequired(memberFields(fields), toDraft(m.answers)).map(
        (f) => `${m.name.trim() || `Member ${i + 1}`}: ${f.label}`,
      ),
    ),
  ];
  if (missing.length > 0) reasons.push(`Missing details: ${missing.join('; ')}.`);
  return { ok: reasons.length === 0, reasons, rules: ruleChecks, missing };
}

/** A shareable link: `{token}` in the template is replaced, else the token is appended. */
export function linkFor(template: string, token: string): string {
  return template.includes('{token}')
    ? template.replace('{token}', encodeURIComponent(token))
    : `${template.replace(/\/+$/, '')}/${encodeURIComponent(token)}`;
}
