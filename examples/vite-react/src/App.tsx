import {
  checkRegistration,
  type Draft,
  type Field,
  formatIST,
  formatMoney,
  isEventKitError,
  memberFields,
  parseLink,
  teamFields,
  toAnswers,
} from '@eventkit/sdk';
import { useMe, usePortalInfo, usePortalMutation, useSecretLink } from '@eventkit/sdk/react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

/**
 * A club's own event portal in about 200 lines, on @eventkit/sdk. No router:
 * the address decides the page (/register/{token}, /me/{token}, or /me after
 * the personal link was opened).
 */
export function App() {
  const info = usePortalInfo();
  if (!info.data) return <main style={page}>{info.error ? info.error.message : 'Loading…'}</main>;
  const link = parseLink(location.pathname, info.data.paths);
  const onMe = link?.kind === 'me' || location.pathname === '/me';
  const { event } = info.data;
  return (
    <main style={page}>
      <h1>{event.name}</h1>
      <p>
        {formatIST(event.startAt)} · {event.venue} · by {event.hostedBy}
      </p>
      {link?.kind === 'register' ? <Register linkToken={link.token} /> : onMe ? <Me /> : <Home />}
    </main>
  );
}

const page = { maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui', padding: '0 1rem' };

function Home() {
  const { event, registrationOpen } = usePortalInfo().data!;
  return (
    <p>
      {registrationOpen
        ? `Registration is open until ${formatIST(event.registrationDeadline)}. Ask the organisers for the registration link.`
        : 'Registration is not open.'}
    </p>
  );
}

type Member = { name: string; email: string; phone: string; answers: Draft };
const blank = (): Member => ({ name: '', email: '', phone: '', answers: {} });

/** The leader registers the whole team at once. No accounts. */
function Register({ linkToken }: { linkToken: string }) {
  const info = usePortalInfo().data!;
  const { event, fields, teamRules } = info;
  const [name, setName] = useState('');
  const [teamAnswers, setTeamAnswers] = useState<Draft>({});
  const [members, setMembers] = useState<Member[]>(() =>
    Array.from({ length: event.minTeamSize }, blank),
  );
  const [receipt, setReceipt] = useState<File | null>(null);
  const register = usePortalMutation((portal, input: Parameters<typeof portal.register>[0]) =>
    portal.register(input),
  );

  const draft = {
    team: { name, answers: toAnswers(teamFields(fields), teamAnswers) },
    members: members.map((m) => ({ ...m, answers: toAnswers(memberFields(fields), m.answers) })),
  };
  const check = checkRegistration(
    { team: { name }, members: members.map((m) => ({ ...m, answers: m.answers })) },
    event,
    fields,
    teamRules,
  );
  const paysNow = event.paymentMode === 'at_registration' && event.registrationFee !== null;
  const set = (i: number, patch: Partial<Member>) =>
    setMembers(members.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  if (register.data) {
    return (
      <section>
        <h2>{register.data.team.name} is registered</h2>
        <p>Save these now: each person's link is shown only once. Send each one to its owner.</p>
        {register.data.members.map((m) => (
          <article key={m.registrationId} style={{ borderTop: '1px solid #ccc', padding: 8 }}>
            <strong>
              {m.name} · {m.participantCode}
            </strong>
            <QRCodeSVG value={m.qrToken} size={120} title={`${m.name}'s check-in QR code`} />
            <p>
              Personal link: <code>{m.link.url ?? m.link.token}</code>
            </p>
          </article>
        ))}
      </section>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        register.mutate({ linkToken, ...draft, ...(receipt ? { receipt } : {}) });
      }}
      style={{ display: 'grid', gap: 8 }}
    >
      <h2>Register your team</h2>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" />
      <FieldInputs fields={teamFields(fields)} value={teamAnswers} onChange={setTeamAnswers} />
      {members.map((m, i) => (
        <fieldset key={i}>
          <legend>{i === 0 ? 'You (team leader)' : `Member ${i + 1}`}</legend>
          <input
            value={m.name}
            onChange={(e) => set(i, { name: e.target.value })}
            placeholder="Name"
          />
          <input
            type="email"
            value={m.email}
            onChange={(e) => set(i, { email: e.target.value })}
            placeholder="Email"
          />
          <input
            value={m.phone}
            onChange={(e) => set(i, { phone: e.target.value })}
            placeholder="Phone"
          />
          <FieldInputs
            fields={memberFields(fields)}
            value={m.answers}
            onChange={(answers) => set(i, { answers })}
          />
        </fieldset>
      ))}
      {members.length < event.maxTeamSize && (
        <button type="button" onClick={() => setMembers([...members, blank()])}>
          Add a member
        </button>
      )}
      {paysNow && (
        <label>
          Pay {formatMoney(event.registrationFee! * members.length, event.currency)} to the UPI QR
          {info.paymentQrUrl && <img src={info.paymentQrUrl} alt="UPI QR" width={160} />}
          then upload the receipt:{' '}
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
      {check.reasons.map((r) => (
        <p key={r}>{r}</p>
      ))}
      {register.error && <p role="alert">{register.error.message}</p>}
      <button disabled={!check.ok || (paysNow && !receipt) || register.isPending}>Register</button>
    </form>
  );
}

function FieldInputs(props: { fields: Field[]; value: Draft; onChange: (d: Draft) => void }) {
  return props.fields.map((f) => {
    const v = props.value[f.id] ?? '';
    const change = (x: string) => props.onChange({ ...props.value, [f.id]: x });
    return f.type === 'choice' ? (
      <select key={f.id} value={v} onChange={(e) => change(e.target.value)}>
        <option value="">{f.label}</option>
        {f.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    ) : (
      <input key={f.id} value={v} onChange={(e) => change(e.target.value)} placeholder={f.label} />
    );
  });
}

/** The personal-link page: opens the link once, then shows status, QR and RSVP. */
function Me() {
  const { paths } = usePortalInfo().data!;
  const link = useSecretLink(paths);
  const me = useMe();
  const rsvp = usePortalMutation((portal) => portal.me.rsvp());
  const reset = usePortalMutation((portal) => portal.me.resetLink());
  if (link.status === 'error') {
    return (
      <p role="alert">
        {isEventKitError(link.error, 'LINK_NOT_FOUND')
          ? 'This link was replaced. Use your newest link, or ask your team leader for a new one.'
          : 'Could not open your link.'}
      </p>
    );
  }
  if (!me.data) return <p>Opening your link…</p>;
  const { name, participantCode, status, qrToken, team } = me.data;
  return (
    <section>
      <h2>
        {name} · {participantCode}
      </h2>
      <p>
        Team {team.name}. Your status: {status}.
      </p>
      {status === 'confirmed' && (
        <button onClick={() => rsvp.mutate(undefined)}>I will attend</button>
      )}
      {['confirmed', 'attending', 'checked_in'].includes(status) && (
        <QRCodeSVG value={qrToken} size={200} title="Your check-in QR code" />
      )}
      <p>
        <button onClick={() => reset.mutate(undefined)}>My link leaked: give me a new one</button>
        {reset.data && (
          <>
            {' '}
            New link: <code>{reset.data.url ?? reset.data.token}</code>
          </>
        )}
      </p>
    </section>
  );
}
