/** Where the access token lives between page loads. */
export interface SessionStore {
  get(): string | null;
  set(token: string | null): void;
}

/** Kept in memory only: the session ends when the page (or process) does. The default. */
export function memorySession(initial: string | null = null): SessionStore {
  let token = initial;
  return {
    get: () => token,
    set: (t) => {
      token = t;
    },
  };
}

/**
 * Kept in localStorage, so sign-in survives reloads. Storage can be unavailable
 * (private mode, a worker, Node), so every call is guarded and falls back to memory.
 */
export function localStorageSession(key = 'eventkit.accessToken'): SessionStore {
  const fallback = memorySession();
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    get() {
      try {
        return storage()?.getItem(key) ?? fallback.get();
      } catch {
        return fallback.get();
      }
    },
    set(token) {
      fallback.set(token);
      try {
        if (token) storage()?.setItem(key, token);
        else storage()?.removeItem(key);
      } catch {
        // kept in memory only
      }
    },
  };
}

/**
 * The signed-in state: the token plus listeners. All token handling goes
 * through here, so a later refresh-token scheme changes only this class.
 */
export class Session {
  private readonly listeners = new Set<(signedIn: boolean) => void>();

  constructor(private readonly store: SessionStore) {}

  get token(): string | null {
    return this.store.get();
  }

  get isSignedIn(): boolean {
    return this.token !== null;
  }

  /** Who the session is for (read from the token; the API still checks it). */
  get who(): SessionInfo | null {
    return decodeSession(this.token);
  }

  /** Called on sign-in, sign-out, and when the API says the token is no longer valid. */
  onChange(listener: (signedIn: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** @internal */
  set(token: string | null): void {
    if (token === this.store.get()) return;
    this.store.set(token);
    this.listeners.forEach((l) => l(token !== null));
  }
}

export interface SessionInfo {
  /** client: an eventKit account; staff: a volunteer or judge of `eventId`; participant: a personal link. */
  kind: 'client' | 'staff' | 'participant';
  /** The user (client, staff) or registration (participant) id. */
  id: string;
  eventId: string | null;
  expiresAt: Date | null;
}

/**
 * Reads who a session token belongs to, without checking its signature: for
 * choosing what to show (participant page or staff tools), never for access.
 */
export function decodeSession(token: string | null): SessionInfo | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as {
      sub?: unknown;
      kind?: unknown;
      eventId?: unknown;
      exp?: unknown;
    };
    if (
      typeof claims.sub !== 'string' ||
      (claims.kind !== 'client' && claims.kind !== 'staff' && claims.kind !== 'participant')
    ) {
      return null;
    }
    return {
      kind: claims.kind,
      id: claims.sub,
      eventId: typeof claims.eventId === 'string' ? claims.eventId : null,
      expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null,
    };
  } catch {
    return null;
  }
}
