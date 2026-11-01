import type { Schemas } from './types';

export type ScanRoster = Schemas['ScanRoster'];
export type RosterPerson = ScanRoster['people'][number];
export type ScanResult = Schemas['ScanResult'];
type RejectReason = NonNullable<ScanResult['reason']>;

/** Mirrors the server's: two accepted scans this close together are one sighting. */
export const SAME_SIGHTING_MS = 5_000;

/** A scan made offline, waiting to be sent with `scans.batch`. */
export interface QueuedScan {
  id: string;
  checkpointId: string;
  qrToken: string;
  allowWithoutRsvp?: boolean;
  exitReason?: string;
  offline: true;
  clientScannedAt: string;
}

/**
 * One line of the scan log kept on this device.
 *   pending:  decided offline, not sent yet
 *   synced:   the server agreed
 *   conflict: the server decided differently (its result is the record)
 */
export interface LocalLogEntry {
  id: string;
  checkpointId: string;
  scannedAt: string;
  participantCode: string;
  name: string;
  teamName: string;
  result: ScanResult['result'];
  reason: ScanResult['reason'];
  exitReason: string | null;
  reentry: boolean;
  sync: 'pending' | 'synced' | 'conflict';
  /** For conflicts: what the server said. */
  serverNote?: string;
}

/** Where offline state lives: IndexedDB in a browser, memory elsewhere (and in tests). */
export interface OfflineStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export function memoryStorage(): OfflineStorage {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: async (key, value) => {
      data.set(key, structuredClone(value));
    },
  };
}

/** A one-store IndexedDB key-value database. Falls back to memory when IndexedDB is missing. */
export function indexedDbStorage(name = 'eventkit-offline'): OfflineStorage {
  if (typeof indexedDB === 'undefined') return memoryStorage();
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) =>
    new Promise<T>((resolve, reject) => {
      void open().then((d) => {
        const req = fn(d.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }, reject);
    });
  return {
    get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key)),
    set: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
  };
}

/** SHA-256 hex, as the roster carries QR tokens. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The person a scanned or typed code belongs to: a QR token (by its hash), an
 * exact participant ID, or an older upper-case one, as the server matches.
 */
export async function findInRoster(
  roster: ScanRoster,
  code: string,
): Promise<RosterPerson | undefined> {
  const hash = await sha256Hex(code);
  const typed = code.trim();
  return (
    roster.people.find((p) => p.qrHash === hash) ??
    roster.people.find((p) => p.participantCode === typed) ??
    roster.people.find((p) => p.participantCode === typed.toUpperCase())
  );
}

/** At a gate: whether this scan lets someone out (else back in). */
export const isLeaving = (roster: ScanRoster, person: RosterPerson): boolean =>
  roster.checkpoint.type === 'gate' && !person.outsideSince;

/**
 * The server's decision, made on this device from the cached roster (see
 * `decide` in eventkit-core): null to accept, or the rejection reason.
 */
export function decideOffline(
  roster: ScanRoster,
  person: RosterPerson,
  now: Date,
  allowWithoutRsvp = false,
): RejectReason | null {
  const cp = roster.checkpoint;
  const status = person.status;
  if (status === 'cancelled') return 'cancelled';
  if (cp.opensAt && now < new Date(cp.opensAt)) return 'not_open';
  if (cp.closesAt && now > new Date(cp.closesAt)) return 'closed';
  const last = person.lastAcceptedAt ? new Date(person.lastAcceptedAt) : null;
  if (last && Math.abs(now.getTime() - last.getTime()) < SAME_SIGHTING_MS) return 'duplicate';
  if (cp.type === 'gate') return status === 'checked_in' ? null : 'not_checked_in';
  if (cp.type === 'entry') {
    const rsvpSkipped = allowWithoutRsvp && status === 'confirmed';
    if (status !== 'attending' && status !== 'checked_in' && !rsvpSkipped) return 'not_attending';
  } else if (status !== 'checked_in') {
    return 'not_checked_in';
  }
  if (last && !cp.allowRepeat) return 'duplicate';
  return null;
}

/** The roster after an accepted offline scan, so the next offline scan sees it. */
export function applyAccepted(roster: ScanRoster, person: RosterPerson, at: Date): void {
  const iso = at.toISOString();
  person.lastAcceptedAt = iso;
  if (roster.checkpoint.type === 'entry' && person.status !== 'checked_in') {
    person.status = 'checked_in';
  }
  if (roster.checkpoint.type === 'gate') {
    const out = isLeaving(roster, person);
    person.outsideSince = out ? iso : null;
    person.outsideCheckpointId = out ? roster.checkpoint.id : null;
  }
}

/** A ScanResult shaped like the server's, for a scan decided offline. */
export function offlineResult(
  roster: ScanRoster,
  person: RosterPerson,
  id: string,
  at: Date,
  reason: RejectReason | null,
  reentry: boolean,
  exitReason: string | null,
): ScanResult {
  return {
    id,
    result: reason ? 'rejected' : 'accepted',
    reason,
    scannedAt: at.toISOString(),
    replayed: false,
    previousScanAt: reason === 'duplicate' ? person.lastAcceptedAt : null,
    checkpoint: {
      id: roster.checkpoint.id,
      name: roster.checkpoint.name,
      type: roster.checkpoint.type,
    },
    meal: null,
    participant: {
      name: person.name,
      participantCode: person.participantCode,
      teamName: person.teamName,
      status: person.status,
    },
    reentry,
    exitReason,
    offline: true,
  };
}

export const logEntry = (
  r: ScanResult,
  sync: LocalLogEntry['sync'],
  serverNote?: string,
): LocalLogEntry => ({
  id: r.id,
  checkpointId: r.checkpoint.id,
  scannedAt: r.scannedAt,
  participantCode: r.participant.participantCode,
  name: r.participant.name,
  teamName: r.participant.teamName,
  result: r.result,
  reason: r.reason,
  exitReason: r.exitReason,
  reentry: r.reentry,
  sync,
  ...(serverNote ? { serverNote } : {}),
});
