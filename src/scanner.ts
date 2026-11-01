import { EventKitError, isEventKitError } from './errors';
import type { EventApi } from './event';
import { formatIST } from './helpers/datetime';
import {
  applyAccepted,
  decideOffline,
  findInRoster,
  indexedDbStorage,
  isReentry,
  type LocalLogEntry,
  logEntry,
  memoryStorage,
  type OfflineStorage,
  offlineResult,
  type QueuedScan,
  type ScanRoster,
} from './offline';
import type { Schemas } from './types';

export type ScanResult = Schemas['ScanResult'];

/** What the volunteer reads after a scan (the meal to hand over is in `result.meal`). */
export function describeScan(r: ScanResult): string {
  if (r.result === 'accepted') {
    if (r.checkpoint.type === 'exit') return r.exitReason ? `Left: ${r.exitReason}` : 'Left';
    if (r.reentry) return 'Back in';
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
    case 'not_inside':
      return 'Already marked outside: scan them back in at the entry';
    case 'cancelled':
      return 'Registration is cancelled';
    default:
      return 'Refused';
  }
}

/** What the scanner needs from the API (an EventApi has it; the console passes its own). */
export interface ScannerApi {
  scan: EventApi['scan'];
  attendance: Pick<EventApi['attendance'], 'mark'>;
  scans?: Pick<EventApi['scans'], 'roster' | 'batch'>;
}

export interface ScannerOptions {
  checkpointId: string;
  /** Pings `/health` this often to know the phone is online. Default 5000 ms; 0 turns it off. */
  pingIntervalMs?: number;
  /** Ignore the same code for this long after a result (cameras re-detect constantly). Default 3000. */
  cooldownMs?: number;
  /** After any camera result, ignore every code for this long. Default 1200 ms; 0 turns it off. */
  pauseMs?: number;
  /** Retries when a request gets no answer, with the same scan id. Default 2. */
  retries?: number;
  /**
   * Keep scanning without a connection: the checkpoint's roster is cached and
   * scans are decided on this device, queued and sent when back online.
   * Default true (IndexedDB in a browser); false scans online only; or pass a store.
   */
  offline?: boolean | OfflineStorage;
  /** Refreshes the cached roster this often while online. Default 60000 ms. */
  rosterRefreshMs?: number;
  /** Separates stored state (the event id). */
  storageKey?: string;
  /** For tests: the clock and id source. */
  now?: () => number;
  uuid?: () => string;
}

const LOG_LIMIT = 200;
const BATCH = 200;

const isRoster = (r: unknown): r is ScanRoster =>
  !!r && typeof r === 'object' && Array.isArray((r as ScanRoster).people);

/**
 * Scanning at a checkpoint. Each scan gets a UUID made on this device; a request
 * that gets no answer is retried with the same id, so it can never count twice.
 *
 * Offline (on by default): while online the checkpoint's roster is cached. When
 * the connection drops, scans are decided on this device from it (`offline: true`
 * in the result), queued, and sent with `scans.batch` once back online; the
 * server's result is then the record and differences show as conflicts in `log`.
 * Without a cached roster, scans are refused (OFFLINE) as before.
 */
export function createScanner(
  event: ScannerApi,
  health: () => Promise<unknown>,
  options: ScannerOptions,
) {
  const now = options.now ?? (() => Date.now());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const cooldown = options.cooldownMs ?? 3000;
  const pause = options.pauseMs ?? 1200;
  const retries = options.retries ?? 2;
  const storage: OfflineStorage | null =
    options.offline === false
      ? null
      : options.offline === true || options.offline === undefined
        ? indexedDbStorage()
        : options.offline;
  const offlineOn = storage !== null && !!event.scans;
  const key = options.storageKey ?? 'default';
  const rosterKey = (cp: string) => `roster:${key}:${cp}`;
  const queueKey = `queue:${key}`;
  const logKey = `log:${key}`;

  let checkpointId = options.checkpointId;
  let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  let last: { code: string; at: number } | null = null;
  let lastResultAt: number | null = null;
  let unanswered: { code: string; checkpointId: string; id: string } | null = null;
  let roster: ScanRoster | null = null;
  let queue: QueuedScan[] = [];
  let log: LocalLogEntry[] = [];
  let syncing: Promise<void> | null = null;
  const listeners = new Set<(online: boolean) => void>();
  const changeListeners = new Set<() => void>();
  const changed = () => changeListeners.forEach((l) => l());

  const store = storage ?? memoryStorage();
  const persist = () =>
    Promise.all([store.set(queueKey, queue), store.set(logKey, log.slice(0, LOG_LIMIT))]).catch(
      () => undefined,
    );

  async function loadRoster(cp: string) {
    if (!offlineOn) return;
    const cached = await store.get<ScanRoster>(rosterKey(cp)).catch(() => undefined);
    if (cp === checkpointId && isRoster(cached) && !roster) {
      roster = cached;
      changed();
    }
  }

  const ready = (async () => {
    if (!offlineOn) return;
    queue = (await store.get<QueuedScan[]>(queueKey).catch(() => undefined)) ?? [];
    log = (await store.get<LocalLogEntry[]>(logKey).catch(() => undefined)) ?? [];
    await loadRoster(checkpointId);
    changed();
  })();

  /** Fetches the checkpoint's roster for offline use (online only). */
  async function refreshRoster(): Promise<void> {
    if (!offlineOn || !online) return;
    const cp = checkpointId;
    try {
      const fresh = await event.scans!.roster(cp);
      if (!isRoster(fresh) || cp !== checkpointId) return;
      roster = fresh;
      await store.set(rosterKey(cp), fresh).catch(() => undefined);
      changed();
    } catch {
      // Keep the cached one.
    }
  }

  /** Sends queued offline scans. The server's results replace the local decisions. */
  function sync(): Promise<void> {
    if (!offlineOn || !online || queue.length === 0) return Promise.resolve();
    syncing ??= (async () => {
      try {
        await ready;
        while (online && queue.length > 0) {
          const chunk = queue.slice(0, BATCH);
          const { results } = await event.scans!.batch(chunk);
          for (const r of results) {
            const entry = log.find((e) => e.id === r.id);
            if (!entry) continue;
            if (r.error) {
              entry.sync = 'conflict';
              entry.serverNote = r.error.message;
            } else if (r.scan) {
              const same = r.scan.result === entry.result && r.scan.reason === entry.reason;
              entry.sync = same ? 'synced' : 'conflict';
              if (!same) entry.serverNote = describeScan(r.scan);
              else delete entry.serverNote;
              entry.result = r.scan.result;
              entry.reason = r.scan.reason;
            }
          }
          const sent = new Set(chunk.map((c) => c.id));
          queue = queue.filter((q) => !sent.has(q.id));
          await persist();
          changed();
        }
        await refreshRoster();
      } catch {
        // Try again on the next check.
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  const setOnline = (value: boolean) => {
    if (value === online) return;
    online = value;
    listeners.forEach((l) => l(value));
    changed();
    if (value) {
      void sync();
      void refreshRoster();
    }
  };

  let rosterFetched = false;
  async function check(): Promise<boolean> {
    try {
      await health();
      setOnline(true);
      if (queue.length > 0) void sync();
      if (!rosterFetched) {
        rosterFetched = true;
        void refreshRoster();
      }
    } catch {
      setOnline(false);
    }
    return online;
  }

  const interval = options.pingIntervalMs ?? 5000;
  const timer = interval > 0 ? setInterval(() => void check(), interval) : null;
  const rosterEvery = options.rosterRefreshMs ?? 60_000;
  const rosterTimer =
    offlineOn && rosterEvery > 0 ? setInterval(() => void refreshRoster(), rosterEvery) : null;
  const onBrowserOnline = () => void check();
  const onBrowserOffline = () => setOnline(false);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onBrowserOffline);
  }

  function remember(entry: LocalLogEntry) {
    log = [entry, ...log.filter((e) => e.id !== entry.id)].slice(0, LOG_LIMIT);
  }

  /** Keeps the cached roster in step with what the server just decided. */
  function noteOnline(r: ScanResult) {
    if (!roster || roster.checkpoint.id !== r.checkpoint.id) return;
    const person = roster.people.find((p) => p.participantCode === r.participant.participantCode);
    if (!person) return;
    person.status = r.participant.status;
    if (r.result === 'accepted') applyAccepted(roster, person, new Date(r.scannedAt));
  }

  async function decideHere(
    code: string,
    id: string,
    opts: { allowWithoutRsvp?: boolean; exitReason?: string },
  ): Promise<ScanResult> {
    const r = roster!;
    const person = await findInRoster(r, code);
    if (!person) {
      throw new EventKitError(404, 'UNKNOWN_QR', 'Not on the offline list for this event.');
    }
    if (r.checkpoint.type === 'exit' && !opts.exitReason?.trim()) {
      throw new EventKitError(400, 'EXIT_REASON_REQUIRED', 'Say why they are leaving.');
    }
    const at = new Date(now());
    const reason = decideOffline(r, person, at, opts.allowWithoutRsvp ?? false);
    const reentry = !reason && isReentry(r, person);
    if (!reason) applyAccepted(r, person, at);
    const result = offlineResult(r, person, id, at, reason, reentry, opts.exitReason);
    queue.push({
      id,
      checkpointId: r.checkpoint.id,
      qrToken: code,
      offline: true,
      clientScannedAt: at.toISOString(),
      ...(opts.allowWithoutRsvp ? { allowWithoutRsvp: true } : {}),
      ...(opts.exitReason ? { exitReason: opts.exitReason } : {}),
    });
    unanswered = null;
    remember(logEntry(result, 'pending'));
    await Promise.all([persist(), store.set(rosterKey(r.checkpoint.id), r).catch(() => undefined)]);
    changed();
    return result;
  }

  const offlineReady = () => offlineOn && roster !== null && roster.checkpoint.id === checkpointId;

  /**
   * Scans a code. Returns null when the same code was just scanned, or another
   * result came in under `pauseMs` ago (camera repeats); pass `{ force: true }`
   * for codes typed by hand. Exit checkpoints need `exitReason`.
   */
  async function scan(
    code: string,
    opts: { force?: boolean; allowWithoutRsvp?: boolean; exitReason?: string } = {},
  ): Promise<ScanResult | null> {
    const at = now();
    if (!opts.force) {
      if (last && last.code === code && at - last.at < cooldown) return null;
      if (pause > 0 && lastResultAt !== null && at - lastResultAt < pause) return null;
    }
    last = { code, at };
    await ready;

    const pending = unanswered;
    const id =
      pending && pending.code === code && pending.checkpointId === checkpointId
        ? pending.id
        : uuid();

    if (!online) {
      if (offlineReady()) {
        try {
          return await decideHere(code, id, opts);
        } finally {
          lastResultAt = now();
        }
      }
      throw new EventKitError(
        0,
        'OFFLINE',
        'You are offline. Scanning is paused until the connection is back.',
      );
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await event.scan({
          id,
          checkpointId,
          qrToken: code,
          ...(opts.allowWithoutRsvp ? { allowWithoutRsvp: true } : {}),
          ...(opts.exitReason ? { exitReason: opts.exitReason } : {}),
        });
        unanswered = null;
        lastResultAt = now();
        noteOnline(result);
        remember(logEntry(result, 'synced'));
        void persist();
        changed();
        return result;
      } catch (e) {
        if (isEventKitError(e) && e.code !== 'NETWORK_ERROR') {
          unanswered = null;
          lastResultAt = now();
          throw e;
        }
        if (attempt >= retries) {
          unanswered = { code, checkpointId, id };
          setOnline(false);
          // Same id: if the server did get it, the batch replays its result.
          if (offlineReady()) {
            try {
              return await decideHere(code, id, opts);
            } finally {
              lastResultAt = now();
            }
          }
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
    /** A roster for this checkpoint is cached: scanning goes on without a connection. */
    get offlineReady() {
      return offlineReady();
    },
    /** Offline scans waiting to be sent. */
    get pendingCount() {
      return queue.length;
    },
    /** This device's scan log for the current checkpoint, newest first. */
    get log(): LocalLogEntry[] {
      return log.filter((e) => e.checkpointId === checkpointId);
    },
    /** Camera results are ignored until then (epoch ms). */
    get pausedUntil() {
      return lastResultAt === null ? 0 : lastResultAt + pause;
    },
    onOnlineChange(listener: (online: boolean) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Anything shown changed: online, roster, queue or log. */
    onChange(listener: () => void): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    /** Checks the connection now (and sends queued scans when online). */
    check,
    sync,
    refreshRoster,
    /** Resolves once stored offline state has loaded. */
    ready,
    get checkpointId() {
      return checkpointId;
    },
    /** Switch checkpoint (a pending unanswered scan is tied to its checkpoint). */
    setCheckpoint(id: string) {
      checkpointId = id;
      last = null;
      roster = null;
      void loadRoster(id).then(() => refreshRoster());
      changed();
    },
    /** Stops pinging and removes listeners. */
    destroy() {
      if (timer) clearInterval(timer);
      if (rosterTimer) clearInterval(rosterTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onBrowserOnline);
        window.removeEventListener('offline', onBrowserOffline);
      }
      listeners.clear();
      changeListeners.clear();
    },
  };
}

export type Scanner = ReturnType<typeof createScanner>;
