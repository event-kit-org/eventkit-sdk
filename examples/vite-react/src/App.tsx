import {
  canRegister,
  formatIST,
  formatMoney,
  isEventKitError,
  linkFor,
  teamDisplayStatus,
} from '@eventkit/sdk';
import {
  useEvent,
  useEventKit,
  useEventMutation,
  useFields,
  useMyRegistration,
  useMyTeam,
  useSession,
  useTeamRules,
} from '@eventkit/sdk/react';
import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useState } from 'react';

const LINK = import.meta.env.VITE_PARTICIPANT_LINK_TOKEN as string;

/** A club's own registration site in about 150 lines, on @eventkit/sdk. */
export function App() {
  const { isSignedIn } = useSession();
  return (
    <main
      style={{ maxWidth: 560, margin: '2rem auto', fontFamily: 'system-ui', padding: '0 1rem' }}
    >
      {isSignedIn ? <Dashboard /> : <SignIn />}
    </main>
  );
}

function SignIn() {
  const ek = useEventKit();
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email'));
    const password = String(f.get('password'));
    try {
      if (mode === 'signup') await ek.auth.signup({ email, password, name: String(f.get('name')) });
      else await ek.auth.login({ email, password });
    } catch (err) {
      setError(isEventKitError(err) ? err.message : 'Something went wrong.');
    }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 8 }}>
      <h1>{mode === 'signup' ? 'Create your account' : 'Log in'}</h1>
      {mode === 'signup' && <input name="name" placeholder="Name" required />}
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Password (8+ characters)" required />
      {error && <p role="alert">{error}</p>}
      <button type="submit">{mode === 'signup' ? 'Sign up' : 'Log in'}</button>
      <button type="button" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
        {mode === 'signup' ? 'I have an account' : 'Create an account instead'}
      </button>
    </form>
  );
}

function Dashboard() {
  const ek = useEventKit();
  const event = useEvent();
  const team = useMyTeam();
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>{event.data?.event.name ?? 'Loading…'}</h1>
        <button onClick={() => ek.auth.logout()}>Log out</button>
      </header>
      {event.data && (
        <p>
          {formatIST(event.data.event.startAt)} · {event.data.event.venue}
        </p>
      )}
      {team.isError && isEventKitError(team.error, 'NO_TEAM', 'EVENT_NOT_FOUND') ? (
        <StartTeam />
      ) : null}
      {team.data && <Team />}
      <Registration />
    </>
  );
}

function StartTeam() {
  const ek = useEventKit();
  const [name, setName] = useState('');
  const start = useEventMutation(() => ek.invites.startTeam(LINK, { name }));
  return (
    <section>
      <h2>Start a team</h2>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" />
      <button disabled={!name || start.isPending} onClick={() => start.mutate(undefined)}>
        Create team
      </button>
      {start.error && <p role="alert">{start.error.message}</p>}
    </section>
  );
}

function Team() {
  const team = useMyTeam().data!;
  const event = useEvent().data!.event;
  const fields = useFields().data ?? [];
  const rules = useTeamRules().data ?? [];
  const [email, setEmail] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const invite = useEventMutation((e, to: string) => e.myTeam.invite(to));
  const register = useEventMutation((e) => e.myTeam.register(receipt ? { receipt } : {}));
  const check = canRegister(team, event, fields, rules);
  const paysNow = event.paymentMode === 'at_registration';
  return (
    <section>
      <h2>
        {team.name} · {teamDisplayStatus(team)}
      </h2>
      <ul>
        {team.members.map((m) => (
          <li key={m.membershipId}>
            {m.user.name} ({m.status})
          </li>
        ))}
      </ul>
      {team.stage === 'forming' && (
        <>
          <p>
            Team link: <code>{linkFor(`${location.origin}/join/{token}`, team.joinToken)}</code>
          </p>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Teammate's email"
          />
          <button disabled={!email} onClick={() => invite.mutate(email)}>
            Invite
          </button>
          {invite.error && <p role="alert">{invite.error.message}</p>}
          <h3>Register</h3>
          {check.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
          {paysNow && team.payment.amountDue !== null && (
            <label>
              Pay {formatMoney(team.payment.amountDue, team.payment.currency)} to the UPI QR, then
              upload the receipt:{' '}
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
          <button
            disabled={!check.ok || (paysNow && !receipt) || register.isPending}
            onClick={() => register.mutate(undefined)}
          >
            Register team
          </button>
          {register.error && <p role="alert">{register.error.message}</p>}
        </>
      )}
    </section>
  );
}

function Registration() {
  const reg = useMyRegistration();
  const rsvp = useEventMutation((e) => e.myRegistration.rsvp());
  if (!reg.data) return null;
  const { status, qrToken } = reg.data;
  return (
    <section>
      <h2>Your registration: {status}</h2>
      {status === 'confirmed' && (
        <button onClick={() => rsvp.mutate(undefined)}>I will attend</button>
      )}
      {['confirmed', 'attending', 'checked_in'].includes(status) && (
        <QRCodeSVG value={qrToken} size={200} title="Your check-in QR code" />
      )}
    </section>
  );
}
