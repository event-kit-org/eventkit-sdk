import { authApi, eventsApi, pushApi } from './account';
import { EventKitError } from './errors';
import { eventApi, type EventApi } from './event';
import { createTransport } from './http';
import { portalApi } from './portal';
import { createScanner, type ScannerOptions } from './scanner';
import { memorySession, Session, type SessionStore } from './session';

export interface EventKitOptions {
  /** Base URL of the eventKit API, e.g. https://api.eventkit.example */
  apiUrl: string;
  /**
   * Your event's API key (console → API keys). It says which event your portal
   * is for, and grants nothing by itself.
   */
  apiKey: string;
  /** The event `ek.event()` uses when called without an id (it's in `portal.info()`). */
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

  const portal = portalApi(t, session);

  return {
    session,
    /** Liveness: resolves when the API answers. */
    health,
    /** Readiness: the API and its database. */
    ready: () => t.call(t.api.GET('/health/ready')),

    /**
     * Your event's portal: what participants, volunteers and judges use. No
     * accounts for participants: the leader registers the team, and everyone
     * comes back through their personal link.
     */
    portal: {
      ...portal,
      me: {
        ...portal.me,
        /** Urgent notifications on this device, for this participant. */
        push: pushApi(t, portal.me.pushDevice.put, portal.me.pushDevice.remove),
      },
    },

    /** The eventKit console: client accounts and their events. */
    console: {
      auth: authApi(t, session),
      events: eventsApi(t),
    },

    /** Urgent notifications on this device, for a signed-in client or staff member. */
    push: pushApi(
      t,
      (device) => t.call(t.api.PUT('/v1/push/subscriptions', { body: device })),
      (endpoint) => t.call(t.api.DELETE('/v1/push/subscriptions', { body: { endpoint } })),
    ),

    /** Everything inside one event, for its owner and staff (the configured one by default). */
    event,
    /** Online-only scanning for volunteers and admins at a checkpoint. */
    createScanner: (opts: ScannerOptions & { eventId?: string }) =>
      createScanner(event(opts.eventId), health, opts),
    /** The typed HTTP client underneath, for anything not wrapped yet. */
    raw: t.api,
  };
}

export type EventKit = ReturnType<typeof createEventKit>;
