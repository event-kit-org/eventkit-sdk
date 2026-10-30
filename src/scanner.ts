import { EventKitError, isEventKitError } from './errors';
import type { EventApi } from './event';
import { formatIST } from './helpers/datetime';
import type { Schemas } from './types';

export type ScanResult = Schemas['ScanResult'];

/** What the volunteer reads after a scan (the meal to hand over is in `result.meal`). */
export function describeScan(r: ScanResult): string {
  if (r.result === 'accepted') {
    return r.checkpoint.type === 'entry' ? 'Checked in' : 'OK — hand it over';
  }
  switch (r.reason) {
    case 'duplicate':
      return r.previousScanAt
        ? `Already scanned at ${formatIST(r.previousScanAt)}`
        : 'Already scanned here';
    case 'not_open':
      return 'This checkpoint is not open yet';
    case 'closed':
      return 'This checkpoint has closed';
    case 'not_attending':
      return "Not RSVP'd";
    case 'not_checked_in':
      return 'Not checked in at the entry yet';
    case 'cancelled':
      return 'Registration is cancelled';
    default:
      return 'Refused';
  }
}

export interface ScannerOptions {
  checkpointId: string;
  /** Pings `/health` this often to know the phone is online. Default 5000 ms; 0 turns it off. */
  pingIntervalMs?: number;
  /** Ignore the same code for this long after a result (cameras re-detect constantly). Default 3000. */
  cooldownMs?: number;
  /** Retries when a request gets no answer, with the same scan id. Default 2. */
  retries?: number;
  /** For tests: the clock and id source. */
  now?: () => number;
  uuid?: () => string;
}

/**
 * Online-only scanning, as eventKit requires: each scan gets a UUID made on this
 * device; a request that gets no answer is retried with the same id, and
 * scanning that code again reuses it, so it can never count twice. While
 * offline every scan is refused (OFFLINE) and nothing is queued.
 */
export function createScanner(
  event: EventApi,
  health: () => Promise<unknown>,
  options: ScannerOptions,
) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const cooldown = options.cooldownMs ?? 3000;
  const retries = options.retries ?? 2;
  let checkpointId = options.checkpointId;
  let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  let last: { code: string; at: number } | null = null;
  let unanswered: { code: string; checkpointId: string; id: string } | null = null;
  const listeners = new Set<(online: boolean) => void>();

  const setOnline = (value: boolean) => {
    if (value === online) return;
    online = value;
    listeners.forEach((l) => l(value));
  };

  async function check(): Promise<boolean> {
    try {
      await health();
      setOnline(true);
    } catch {
      setOnline(false);
    }
    return online;
  }

  const interval = options.pingIntervalMs ?? 5000;
  const timer = interval > 0 ? setInterval(() => void check(), interval) : null;
  const onBrowserOnline = () => void check();
  const onBrowserOffline = () => setOnline(false);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onBrowserOffline);
  }

  /**
   * Scans a code. Returns null when the same code was just scanned (camera
   * repeat); pass `{ force: true }` for codes typed by hand.
   */
  async function scan(
    code: string,
    opts: { force?: boolean; allowWithoutRsvp?: boolean } = {},
  ): Promise<ScanResult | null> {
    if (!online) {
      throw new EventKitError(
        0,
        'OFFLINE',
        'You are offline. Scanning is paused until the connection is back.',
      );
    }
    const at = now();
    if (!opts.force && last && last.code === code && at - last.at < cooldown) return null;
    last = { code, at };

    const pending = unanswered;
    const id =
      pending && pending.code === code && pending.checkpointId === checkpointId
        ? pending.id
        : uuid();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await event.scan({
          id,
          checkpointId,
          qrToken: code,
          ...(opts.allowWithoutRsvp ? { allowWithoutRsvp: true } : {}),
        });
        unanswered = null;
        return result;
      } catch (e) {
        if (isEventKitError(e) && e.code !== 'NETWORK_ERROR') {
          unanswered = null;
          throw e;
        }
        if (attempt >= retries) {
          unanswered = { code, checkpointId, id };
          setOnline(false);
          throw new EventKitError(
            0,
            'OFFLINE',
            'No answer from the server. Not recorded: scan again when back online.',
            e,
          );
        }
      }
    }
  }

  return {
    scan,
    /** At the gate: mark a confirmed person who never RSVPed as attending, then scan again. */
    async markAttendingAndScan(code: string): Promise<ScanResult> {
      await event.attendance.mark(code, true);
      return (await scan(code, { force: true }))!;
    },
    /** At the gate: let someone through who has not RSVP'd, without marking them attending. */
    async allowWithoutRsvp(code: string): Promise<ScanResult> {
      return (await scan(code, { force: true, allowWithoutRsvp: true }))!;
    },
    describe: describeScan,
    get online() {
      return online;
    },
    onOnlineChange(listener: (online: boolean) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Checks the connection now. */
    check,
    get checkpointId() {
      return checkpointId;
    },
    /** Switch checkpoint (a pending unanswered scan is tied to its checkpoint). */
    setCheckpoint(id: string) {
      checkpointId = id;
      last = null;
    },
    /** Stops pinging and removes listeners. */
    destroy() {
      if (timer) clearInterval(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onBrowserOnline);
        window.removeEventListener('offline', onBrowserOffline);
      }
      listeners.clear();
    },
  };
}

export type Scanner = ReturnType<typeof createScanner>;
