import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { EventKit } from '../client';
import { DEFAULT_PORTAL_PATHS, parseLink } from '../portal';
import { decodeSession, type SessionInfo } from '../session';
import type { Schemas } from '../types';
import type { EventApi } from '../event';
import type { LocalLogEntry } from '../offline';
import type { Scanner, ScannerOptions } from '../scanner';

const Ctx = createContext<EventKit | null>(null);

/**
 * Makes the client available to the hooks. Put it inside your
 * QueryClientProvider (TanStack Query v5).
 */
export function EventKitProvider({ client, children }: { client: EventKit; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useEventKit(): EventKit {
  const ek = useContext(Ctx);
  if (!ek) throw new Error('useEventKit: wrap your app in <EventKitProvider client={…}>.');
  return ek;
}

/**
 * Whether someone is signed in, and who (`who.kind`: client, staff or
 * participant); re-renders on sign-in, sign-out and expired tokens.
 */
export function useSession(): {
  isSignedIn: boolean;
  token: string | null;
  who: SessionInfo | null;
} {
  const { session } = useEventKit();
  const token = useSyncExternalStore(
    (cb) => session.onChange(cb),
    () => session.token,
    () => session.token,
  );
  return { isSignedIn: token !== null, token, who: decodeSession(token) };
}

/** Query keys the hooks use: everything for one event sits under ['eventkit', eventId]. */
export const eventKeys = {
  all: (eventId: string) => ['eventkit', eventId] as const,
  of: (eventId: string, name: string, ...rest: unknown[]) =>
    ['eventkit', eventId, name, ...rest] as const,
};

type Opts<T> = Omit<UseQueryOptions<T, Error, T, QueryKey>, 'queryKey' | 'queryFn'>;

/** Any devkit read for an event, cached by name. The base of the hooks below. */
export function useEventQuery<T>(
  name: string,
  fn: (event: EventApi) => Promise<T>,
  options: Opts<T> & { eventId?: string } = {},
  /** Extra key parts (a round id, say). */
  keyParts: unknown[] = [],
) {
  const ek = useEventKit();
  const { eventId, ...rest } = options;
  const event = ek.event(eventId);
  return useQuery({
    queryKey: eventKeys.of(event.id, name, ...keyParts),
    queryFn: () => fn(event),
    ...rest,
  });
}

/** Runs a devkit call, then refreshes everything cached for the event. */
export function useEventMutation<TVars, TData>(
  fn: (event: EventApi, vars: TVars) => Promise<TData>,
  options: { eventId?: string } = {},
) {
  const ek = useEventKit();
  const queryClient = useQueryClient();
  const event = ek.event(options.eventId);
  return useMutation({
    mutationFn: (vars: TVars) => fn(event, vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: eventKeys.all(event.id) }),
  });
}

type EventOpt = { eventId?: string };
export const useEvent = (o: EventOpt = {}) => useEventQuery('event', (e) => e.get(), o);
export const useFeatures = (o: EventOpt = {}) => useEventQuery('features', (e) => e.features(), o);
export const useFields = (o: EventOpt = {}) => useEventQuery('fields', (e) => e.fields.list(), o);
export const useTeamRules = (o: EventOpt = {}) =>
  useEventQuery('team-rules', (e) => e.teamRules.list(), o);
export const usePolls = (o: EventOpt = {}) => useEventQuery('polls', (e) => e.polls.list(), o);
export const useCheckpoints = (o: EventOpt = {}) =>
  useEventQuery('checkpoints', (e) => e.checkpoints.list(), o);
export const useRounds = (o: EventOpt = {}) => useEventQuery('rounds', (e) => e.rounds.list(), o);
export const useCriteria = (roundId?: string, o: EventOpt = {}) =>
  useEventQuery('criteria', (e) => e.criteria.list(roundId), o, [roundId]);
/** Judges: the teams to score, with your scores, for a round. */
export const useJudgingTeams = (roundId?: string, o: EventOpt = {}) =>
  useEventQuery('judging-teams', (e) => e.judging.teams(roundId), o, [roundId]);
/** Admin: a round's submission forms (all rounds without `roundId`). */
export const useSubmissions = (roundId?: string, o: EventOpt = {}) =>
  useEventQuery('submissions', (e) => e.submissions.list(roundId), o, [roundId]);
/** Admin: what teams handed in for one submission. */
export const useSubmissionEntries = (submissionId: string, o: EventOpt = {}) =>
  useEventQuery('submission-entries', (e) => e.submissions.entries(submissionId), o, [
    submissionId,
  ]);
export const useLeaderboard = (roundId?: string, o: EventOpt = {}) =>
  useEventQuery('leaderboard', (e) => e.leaderboard(roundId), o, [roundId]);
/** The notification feed, refreshed every 30 s. */
/** Saved leaderboards the caller may see. */
export const useSavedLeaderboards = (o: EventOpt = {}) =>
  useEventQuery('leaderboards', (e) => e.leaderboards.list(), o);
/** A saved leaderboard's ranking; null for none. */
export const useSavedLeaderboardResults = (leaderboardId: string | null, o: EventOpt = {}) =>
  useEventQuery(
    'leaderboard-results',
    (e) => e.leaderboards.results(leaderboardId!),
    {
      enabled: leaderboardId !== null,
      refetchInterval: 30_000,
      ...o,
    },
    [leaderboardId],
  );
export const useNotifications = (o: EventOpt & { refetchIntervalMs?: number } = {}) =>
  useEventQuery('notifications', (e) => e.notifications.feed(), {
    refetchInterval: o.refetchIntervalMs ?? 30_000,
    ...(o.eventId ? { eventId: o.eventId } : {}),
  });

// ------------------------------------------------------------ the portal

/** Portal queries sit under ['eventkit', 'portal', …]; portal mutations refresh them. */
export const portalKeys = {
  all: ['eventkit', 'portal'] as const,
  of: (name: string) => ['eventkit', 'portal', name] as const,
};

/** The event, its registration form and team rules, the portal's paths (no sign-in). */
export function usePortalInfo() {
  const ek = useEventKit();
  return useQuery({ queryKey: portalKeys.of('info'), queryFn: () => ek.portal.info() });
}

/**
 * On a personal-link page (/me/{token}): opens the link in the address (even
 * when another session is stored), keeps the session and strips the token
 * from the address bar. Without a token in the address, a stored participant
 * session is used. `paths`: the event's (from usePortalInfo), if overridden.
 */
export function useSecretLink(paths?: Schemas['PortalPaths']) {
  const ek = useEventKit();
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ status: 'opening' | 'open' | 'error'; error?: unknown }>(
    () => {
      const inAddress =
        typeof location !== 'undefined' &&
        parseLink(location.pathname, paths ?? DEFAULT_PORTAL_PATHS)?.kind === 'me';
      return {
        status: !inAddress && ek.session.who?.kind === 'participant' ? 'open' : 'opening',
      };
    },
  );
  useEffect(() => {
    let cancelled = false;
    if (state.status !== 'opening') return;
    ek.portal.openSecretLink(undefined, paths ? { paths } : {}).then(
      (me) => {
        if (cancelled) return;
        queryClient.setQueryData(portalKeys.of('me'), me);
        void queryClient.invalidateQueries({ queryKey: portalKeys.all });
        setState({ status: 'open' });
      },
      (error: unknown) => !cancelled && setState({ status: 'error', error }),
    );
    return () => {
      cancelled = true;
    };
  }, [ek, paths, queryClient, state.status]);
  return state;
}

/** The participant's own registration (after their link is open). */
export function useMe() {
  const ek = useEventKit();
  return useQuery({
    queryKey: portalKeys.of('me'),
    queryFn: () => ek.portal.me.get(),
    retry: false,
  });
}
/** The participant's team (the leader also sees contacts and payment). */
export function useMyTeam() {
  const ek = useEventKit();
  return useQuery({ queryKey: portalKeys.of('team'), queryFn: () => ek.portal.me.team.get() });
}
/** Polls for participants, with their vote. */
export function useMyPolls() {
  const ek = useEventKit();
  return useQuery({ queryKey: portalKeys.of('polls'), queryFn: () => ek.portal.me.polls.list() });
}
/** The participant's submission forms per round, with their team's entry. */
export function useMySubmissions() {
  const ek = useEventKit();
  return useQuery({
    queryKey: portalKeys.of('submissions'),
    queryFn: () => ek.portal.me.submissions.list(),
  });
}
/** Team totals for a round (when the organiser shows the leaderboard). */
export function useMyLeaderboard(roundId?: string) {
  const ek = useEventKit();
  return useQuery({
    queryKey: [...portalKeys.of('leaderboard'), roundId ?? null],
    queryFn: () => ek.portal.me.leaderboard(roundId),
    refetchInterval: 30_000,
  });
}
/** Public saved leaderboards (per track, top teams, overall…). */
export function useMyLeaderboards() {
  const ek = useEventKit();
  return useQuery({
    queryKey: portalKeys.of('leaderboards'),
    queryFn: () => ek.portal.me.leaderboards.list(),
  });
}
/** A public saved leaderboard's ranking; null for none. */
export function useMyLeaderboardResults(leaderboardId: string | null) {
  const ek = useEventKit();
  return useQuery({
    queryKey: [...portalKeys.of('leaderboard-results'), leaderboardId],
    queryFn: () => ek.portal.me.leaderboards.results(leaderboardId!),
    enabled: leaderboardId !== null,
    refetchInterval: 30_000,
  });
}
/** The participant's notification feed, refreshed every 30 s. */
export function useMyNotifications(refetchIntervalMs = 30_000) {
  const ek = useEventKit();
  return useQuery({
    queryKey: portalKeys.of('notifications'),
    queryFn: () => ek.portal.me.notifications.feed(),
    refetchInterval: refetchIntervalMs,
  });
}

/** Runs a portal call, then refreshes the portal's queries. */
export function usePortalMutation<TVars, TData>(
  fn: (portal: EventKit['portal'], vars: TVars) => Promise<TData>,
) {
  const ek = useEventKit();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => fn(ek.portal, vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all }),
  });
}

/**
 * A scanner for a checkpoint, with its online state. The scanner is rebuilt
 * when the event or checkpoint changes, and stopped on unmount.
 */
export interface ScannerState {
  scanner: Scanner | null;
  online: boolean;
  /** A roster is cached: scanning goes on without a connection. */
  offlineReady: boolean;
  /** Offline scans waiting to be sent. */
  pendingCount: number;
  /** This device's scan log for the checkpoint, newest first. */
  log: LocalLogEntry[];
}

/** A scanner for one checkpoint, with its online and offline state as React state. */
export function useScanner(options: ScannerOptions & { eventId?: string }): ScannerState {
  const ek = useEventKit();
  const [scanner, setScanner] = useState<Scanner | null>(null);
  const [state, setState] = useState<Omit<ScannerState, 'scanner'>>({
    online: true,
    offlineReady: false,
    pendingCount: 0,
    log: [],
  });
  const { eventId, checkpointId, pingIntervalMs } = options;
  useEffect(() => {
    const s = ek.createScanner({
      ...options,
      ...(eventId ? { eventId } : {}),
      checkpointId,
    });
    const read = () =>
      setState({
        online: s.online,
        offlineReady: s.offlineReady,
        pendingCount: s.pendingCount,
        log: s.log,
      });
    setScanner(s);
    read();
    const off = s.onChange(read);
    void s.check();
    return () => {
      off();
      s.destroy();
    };
    // Rebuilt only when what identifies the scanner changes.
  }, [ek, eventId, checkpointId, pingIntervalMs]); // eslint-disable-line
  return { scanner, ...state };
}

/** One row of the scan log: the server's scans merged with this device's unsent ones. */
export interface ScanLogRow {
  id: string;
  scannedAt: string;
  participantCode: string;
  name: string;
  teamName: string;
  result: 'accepted' | 'rejected';
  reason: Schemas['ScanResult']['reason'];
  exitReason: string | null;
  reentry: boolean;
  offline: boolean;
  /** pending: decided offline, not sent; conflict: the server decided differently. */
  sync: 'pending' | 'synced' | 'conflict';
  serverNote?: string;
}

/**
 * The scan log under a scanner: the checkpoint's recent scans from the server
 * (refreshed every 5 s while online) with this device's offline scans on top.
 */
export function useScanLog(
  state: Pick<ScannerState, 'online' | 'log'>,
  checkpointId: string | null,
  o: EventOpt & { limit?: number; refetchIntervalMs?: number } = {},
): { rows: ScanLogRow[]; isPending: boolean } {
  const event = useEventKit().event(o.eventId);
  const q = useQuery({
    queryKey: eventKeys.of(event.id, 'scans', checkpointId, o.limit ?? 25),
    queryFn: () => event.scans.list({ checkpointId: checkpointId!, limit: o.limit ?? 25 }),
    enabled: !!checkpointId && state.online,
    refetchInterval: o.refetchIntervalMs ?? 5000,
  });
  const local = new Map(state.log.map((e) => [e.id, e]));
  const server: ScanLogRow[] = (q.data ?? []).map((s) => {
    const mine = local.get(s.id);
    return {
      id: s.id,
      scannedAt: s.scannedAt,
      participantCode: s.participant.participantCode,
      name: s.participant.name,
      teamName: s.participant.teamName,
      result: s.result,
      reason: s.reason,
      exitReason: s.exitReason,
      reentry: mine?.reentry ?? false,
      offline: s.offline,
      sync: mine?.sync === 'conflict' ? 'conflict' : 'synced',
      ...(mine?.serverNote ? { serverNote: mine.serverNote } : {}),
    };
  });
  const seen = new Set(server.map((r) => r.id));
  const mine: ScanLogRow[] = state.log
    .filter((e) => !seen.has(e.id))
    .map((e) => ({ ...e, offline: e.sync !== 'synced' }));
  const rows = [...mine, ...server]
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))
    .slice(0, Math.max(o.limit ?? 25, mine.length));
  return { rows, isPending: q.isPending && state.online && !!checkpointId };
}

/** Everyone who left through an exit and has not come back, refreshed every 15 s. */
export const useOutside = (o: EventOpt & { refetchIntervalMs?: number } = {}) =>
  useEventQuery('outside', (e) => e.scans.outside(), {
    refetchInterval: o.refetchIntervalMs ?? 15_000,
    ...(o.eventId ? { eventId: o.eventId } : {}),
  });

/** Whether the API is reachable (pings /health). */
export function useOnlineStatus(intervalMs = 5000): boolean {
  const ek = useEventKit();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      ek.health().then(
        () => !cancelled && setOnline(true),
        () => !cancelled && setOnline(false),
      );
    void check();
    const timer = setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ek, intervalMs]);
  return online;
}
