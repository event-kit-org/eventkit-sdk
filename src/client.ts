import { authApi, eventsApi, invitesApi, pushApi, teamInvitesApi, teamLinksApi } from './account';
import { EventKitError } from './errors';
import { eventApi, type EventApi } from './event';
import { createTransport } from './http';
import { createScanner, type ScannerOptions } from './scanner';
import { memorySession, Session, type SessionStore } from './session';

export interface EventKitOptions {
  /** Base URL of the eventKit API, e.g. https://api.eventkit.example */
  apiUrl: string;
  /** Your event's API key (Admin → API keys). It identifies your app and grants nothing. */
  apiKey: string;
  /** The event `ek.event()` uses when called without an id. */
  eventId?: string;
  /** Where to keep the sign-in token. Default: memory. In browsers use localStorageSession(). */
  session?: SessionStore;
  /** A fetch implementation (default: the global fetch). */
  fetch?: typeof fetch;
}

/** The eventKit client. */
export function createEventKit(options: EventKitOptions) {
  const session = new Session(options.session ?? memorySession());
  const t = createTransport({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    session,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const events = new Map<string, EventApi>();
  const health = () => t.call(t.api.GET('/health', { cache: 'no-store' }));

  function event(eventId: string | undefined = options.eventId): EventApi {
    if (!eventId) {
      throw new EventKitError(
        0,
        'NO_EVENT_ID',
        'Pass an event id, or set eventId in createEventKit().',
      );
    }
    let api = events.get(eventId);
    if (!api) {
      api = eventApi(t, eventId);
      events.set(eventId, api);
    }
    return api;
  }

  return {
    session,
    /** Liveness: resolves when the API answers. */
    health,
    /** Readiness: the API and its database. */
    ready: () => t.call(t.api.GET('/health/ready')),
    auth: authApi(t, session),
    events: eventsApi(t),
    invites: invitesApi(t),
    teamInvites: teamInvitesApi(t),
    teamLinks: teamLinksApi(t),
    push: pushApi(t),
    /** Everything inside one event (the configured one by default). */
    event,
    /** Online-only scanning for volunteers and admins at a checkpoint. */
    createScanner: (opts: ScannerOptions & { eventId?: string }) =>
      createScanner(event(opts.eventId), health, opts),
    /** The typed HTTP client underneath, for anything not wrapped yet. */
    raw: t.api,
  };
}

export type EventKit = ReturnType<typeof createEventKit>;
