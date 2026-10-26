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
) {
  const ek = useEventKit();
  const { eventId, ...rest } = options;
  const event = ek.event(eventId);
  return useQuery({ queryKey: eventKeys.of(event.id, name), queryFn: () => fn(event), ...rest });
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
export const useLeaderboard = (o: EventOpt = {}) =>
  useEventQuery('leaderboard', (e) => e.leaderboard(), o);
/** The notification feed, refreshed every 30 s. */
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
export function useScanner(options: ScannerOptions & { eventId?: string }): {
  scanner: Scanner | null;
  online: boolean;
} {
  const ek = useEventKit();
  const [scanner, setScanner] = useState<Scanner | null>(null);
  const [online, setOnline] = useState(true);
  const { eventId, checkpointId, pingIntervalMs } = options;
  useEffect(() => {
    const s = ek.createScanner({
      ...options,
      ...(eventId ? { eventId } : {}),
      checkpointId,
    });
    setScanner(s);
    setOnline(s.online);
    const off = s.onOnlineChange(setOnline);
    void s.check();
    return () => {
      off();
      s.destroy();
    };
    // Rebuilt only when what identifies the scanner changes.
  }, [ek, eventId, checkpointId, pingIntervalMs]); // eslint-disable-line
  return { scanner, online };
}

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
