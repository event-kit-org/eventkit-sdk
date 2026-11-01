import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideOffline,
  describeScan,
  memoryStorage,
  type ScannerOptions,
  type ScanResult,
  type ScanRoster,
  sha256Hex,
} from '../src';
import { apiError, client } from './mock';

const result = (over: Partial<ScanResult> = {}): ScanResult => ({
  id: 's',
  result: 'accepted',
  reason: null,
  scannedAt: '2026-10-31T04:00:00.000Z',
  replayed: false,
  previousScanAt: null,
  checkpoint: { id: 'gate', name: 'Gate', type: 'entry' },
  meal: null,
  participant: {
    name: 'Asha',
    participantCode: 'MZ-0001',
    teamName: 'Byte Club',
    status: 'checked_in',
  },
  reentry: false,
  exitReason: null,
  offline: false,
  ...over,
});

function setup(opts: Partial<ScannerOptions> = {}) {
  const { ek, mock } = client();
  let n = 0;
  const scanner = ek.createScanner({
    checkpointId: 'gate',
    pingIntervalMs: 0,
    pauseMs: 0,
    offline: false,
    uuid: () => `id-${++n}`,
    ...opts,
  });
  return { ek, mock, scanner, scans: () => mock.calls.filter((c) => c.path.endsWith('/scans')) };
}

afterEach(() => vi.unstubAllGlobals());

describe('scanner', () => {
  it('scans with an id made on the device, and ignores camera repeats', async () => {
    let t = 0;
    const { mock, scanner, scans } = setup({ now: () => t });
    mock.on('POST /v1/events/:id/scans', () => result());
    expect(await scanner.scan('qr-1')).toMatchObject({ result: 'accepted' });
    expect(scans()[0]!.body).toEqual({ id: 'id-1', checkpointId: 'gate', qrToken: 'qr-1' });
    t = 1000;
    expect(await scanner.scan('qr-1')).toBeNull();
    expect(await scanner.scan('qr-1', { force: true })).not.toBeNull();
    t = 5000;
    expect(await scanner.scan('qr-1')).not.toBeNull();
    expect(scans().map((c) => (c.body as { id: string }).id)).toEqual(['id-1', 'id-2', 'id-3']);
    scanner.destroy();
  });

  it('retries with the same id; after no answer it goes offline and reuses the id later', async () => {
    const { mock, scanner, scans } = setup();
    let fail = true;
    mock.on('POST /v1/events/:id/scans', () => {
      if (fail) throw new TypeError('network');
      return result();
    });
    const changes: boolean[] = [];
    scanner.onOnlineChange((o) => changes.push(o));
    await expect(scanner.scan('qr-1')).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(scans().map((c) => (c.body as { id: string }).id)).toEqual(['id-1', 'id-1', 'id-1']);
    expect(scanner.online).toBe(false);
    await expect(scanner.scan('qr-1', { force: true })).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(scans()).toHaveLength(3); // refused while offline, nothing sent or queued

    expect(await scanner.check()).toBe(true);
    fail = false;
    await scanner.scan('qr-1', { force: true });
    expect((scans().at(-1)!.body as { id: string }).id).toBe('id-1'); // the unanswered id, reused
    await scanner.scan('qr-2');
    expect((scans().at(-1)!.body as { id: string }).id).toBe('id-2');
    expect(changes).toEqual([false, true]);
  });

  it('a refusal from the API is final; switching checkpoint takes a new id', async () => {
    const { mock, scanner, scans } = setup();
    mock.on('POST /v1/events/:id/scans', () => apiError(404, 'UNKNOWN_QR'));
    await expect(scanner.scan('nope')).rejects.toMatchObject({ code: 'UNKNOWN_QR' });
    expect(scans()).toHaveLength(1);
    expect(scanner.online).toBe(true);
    scanner.setCheckpoint('lunch');
    expect(scanner.checkpointId).toBe('lunch');
    mock.on('POST /v1/events/:id/scans', () => result());
    await scanner.scan('nope');
    expect(scans().at(-1)!.body).toMatchObject({ checkpointId: 'lunch', id: 'id-2' });
  });

  it('marks someone attending at the gate, then scans again with a fresh id', async () => {
    const { mock, scanner, scans } = setup();
    mock.on('POST /v1/events/:id/attendance', () => ({
      registrationId: 'r',
      status: 'attending',
      name: 'Asha',
    }));
    mock.on('POST /v1/events/:id/scans', () => result());
    await scanner.markAttendingAndScan('qr-1');
    const attend = mock.calls.find((c) => c.path.endsWith('/attendance'))!;
    expect(attend.body).toEqual({ qrToken: 'qr-1', attending: true });
    expect(scans()).toHaveLength(1);
  });

  it('lets someone through without an RSVP, without marking attendance', async () => {
    const { mock, scanner, scans } = setup();
    mock.on('POST /v1/events/:id/scans', () => result());
    await scanner.allowWithoutRsvp('qr-2');
    expect(mock.calls.some((c) => c.path.endsWith('/attendance'))).toBe(false);
    expect((scans()[0]!.body as { allowWithoutRsvp?: boolean }).allowWithoutRsvp).toBe(true);
  });

  it('pings /health to know it is online, and follows the browser online events', async () => {
    vi.useFakeTimers();
    const events = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (n: string, f: () => void) => events.set(n, f),
      removeEventListener: (n: string) => events.delete(n),
    });
    vi.stubGlobal('navigator', { onLine: false });
    const { ek, mock } = client();
    let up = false;
    mock.on('GET /health', () => (up ? { status: 'ok' } : apiError(503, 'DOWN')));
    const scanner = ek.createScanner({ checkpointId: 'g' });
    expect(scanner.online).toBe(false);
    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(scanner.online).toBe(true);
    events.get('offline')!();
    expect(scanner.online).toBe(false);
    events.get('online')!();
    await vi.waitFor(() => expect(scanner.online).toBe(true));
    scanner.destroy();
    expect(events.size).toBe(0);
    vi.useRealTimers();
  });

  it('makes real UUIDs by default, and assumes online where there is no navigator', async () => {
    vi.stubGlobal('navigator', undefined);
    const { ek, mock } = client();
    mock.on('POST /v1/events/:id/scans', () => result());
    const scanner = ek.createScanner({ checkpointId: 'g', pingIntervalMs: 0 });
    expect(scanner.online).toBe(true);
    await scanner.scan('qr');
    expect((mock.last().body as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    scanner.destroy();
  });

  it('describes results for the volunteer', () => {
    expect(describeScan(result())).toBe('Checked in');
    expect(describeScan(result({ checkpoint: { id: 'l', name: 'Lunch', type: 'meal' } }))).toBe(
      'OK — hand it over',
    );
    const rejected = (reason: ScanResult['reason'], extra: Partial<ScanResult> = {}) =>
      describeScan(result({ result: 'rejected', reason, ...extra }));
    expect(rejected('duplicate', { previousScanAt: '2026-10-31T04:00:00.000Z' })).toBe(
      'Already scanned at 31 Oct 2026, 9:30 am IST',
    );
    expect(rejected('duplicate')).toBe('Already scanned here');
    expect(rejected('not_open')).toBe('This checkpoint is not open yet');
    expect(rejected('closed')).toBe('This checkpoint has closed');
    expect(rejected('not_attending')).toBe("Not RSVP'd");
    expect(rejected('not_checked_in')).toBe('Not checked in at the entry yet');
    expect(rejected('cancelled')).toBe('Registration is cancelled');
    expect(rejected(null)).toBe('Refused');
    const { ek } = client();
    const s = ek.createScanner({ checkpointId: 'g', pingIntervalMs: 0 });
    expect(s.describe(result())).toBe('Checked in');
    s.destroy();
  });
});

describe('pause between scans', () => {
  it('ignores every camera code for pauseMs after a result; typed codes go through', async () => {
    let t = 0;
    const { mock, scanner, scans } = setup({ now: () => t, pauseMs: 1200 });
    mock.on('POST /v1/events/:id/scans', () => result());
    await scanner.scan('qr-1');
    t = 500;
    expect(await scanner.scan('qr-2')).toBeNull();
    expect(await scanner.scan('MZ-0002', { force: true })).not.toBeNull();
    t = 2000;
    expect(await scanner.scan('qr-2')).not.toBeNull();
    expect(scans()).toHaveLength(3);
  });
});

describe('offline scanning', () => {
  const QR = 'qr-asha';
  async function roster(over: Record<string, unknown> = {}) {
    return {
      generatedAt: '2026-10-31T04:00:00.000Z',
      checkpoint: {
        id: 'gate',
        name: 'Gate',
        type: 'entry',
        opensAt: null,
        closesAt: null,
        allowRepeat: false,
        poll: null,
        linkedCheckpointId: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        ...over,
      },
      people: [
        {
          registrationId: 'r1',
          qrHash: await sha256Hex(QR),
          participantCode: 'MZ-0001',
          name: 'Asha',
          teamName: 'Byte Club',
          status: 'attending',
          outsideSince: null,
          outsideCheckpointId: null,
          lastAcceptedAt: null,
        },
      ],
      exits: [],
    };
  }

  async function offlineSetup(t: { now: number }, over: Record<string, unknown> = {}) {
    const ctx = setup({ offline: memoryStorage(), now: () => t.now });
    const r = await roster(over);
    ctx.mock.on('GET /v1/events/:id/scans/roster', () => r);
    let down = false;
    ctx.mock.on('GET /health', () => {
      if (down) throw new TypeError('network');
      return { ok: true };
    });
    ctx.mock.on('POST /v1/events/:id/scans', () => {
      if (down) throw new TypeError('network');
      return result();
    });
    await ctx.scanner.check();
    await ctx.scanner.refreshRoster();
    return { ...ctx, goDown: () => (down = true), goUp: () => (down = false) };
  }

  it('decides from the cached roster, queues, and syncs when back', async () => {
    const t = { now: Date.parse('2026-10-31T05:00:00Z') };
    const { mock, scanner, goDown, goUp } = await offlineSetup(t);
    expect(scanner.offlineReady).toBe(true);
    goDown();
    await scanner.check();
    expect(scanner.online).toBe(false);

    const first = await scanner.scan(QR);
    expect(first).toMatchObject({
      result: 'accepted',
      offline: true,
      participant: { name: 'Asha', status: 'checked_in' },
    });
    t.now += 60_000;
    expect(await scanner.scan('MZ-0001', { force: true })).toMatchObject({
      result: 'rejected',
      reason: 'duplicate',
    });
    await expect(scanner.scan('who', { force: true })).rejects.toMatchObject({
      code: 'UNKNOWN_QR',
    });
    expect(scanner.pendingCount).toBe(2);
    expect(scanner.log.map((e) => e.sync)).toEqual(['pending', 'pending']);

    mock.on('POST /v1/events/:id/scans/batch', (call) => ({
      results: (call.body as { scans: { id: string }[] }).scans.map((s, i) => ({
        id: s.id,
        scan: result({ id: s.id, ...(i === 1 ? { result: 'rejected', reason: 'duplicate' } : {}) }),
        error: null,
      })),
    }));
    goUp();
    await scanner.check();
    await scanner.sync();
    const batch = mock.calls.find((c) => c.path.endsWith('/scans/batch'))!;
    expect((batch.body as { scans: object[] }).scans[0]).toMatchObject({
      qrToken: QR,
      offline: true,
      clientScannedAt: '2026-10-31T05:00:00.000Z',
    });
    expect(scanner.pendingCount).toBe(0);
    expect(scanner.log.map((e) => e.sync)).toEqual(['synced', 'synced']);
    scanner.destroy();
  });

  it('flags a conflict when the server decided differently', async () => {
    const t = { now: Date.parse('2026-10-31T05:00:00Z') };
    const { mock, scanner, goDown, goUp } = await offlineSetup(t);
    goDown();
    await scanner.check();
    await scanner.scan(QR);
    mock.on('POST /v1/events/:id/scans/batch', (call) => ({
      results: (call.body as { scans: { id: string }[] }).scans.map((s) => ({
        id: s.id,
        scan: result({ id: s.id, result: 'rejected', reason: 'cancelled' }),
        error: null,
      })),
    }));
    goUp();
    await scanner.check();
    await scanner.sync();
    expect(scanner.log[0]).toMatchObject({
      sync: 'conflict',
      result: 'rejected',
      serverNote: 'Registration is cancelled',
    });
  });

  it('falls back to offline when a request gets no answer, keeping its id', async () => {
    const t = { now: Date.parse('2026-10-31T05:00:00Z') };
    const { scanner, goDown, scans } = await offlineSetup(t);
    goDown();
    const r = await scanner.scan(QR);
    expect(r).toMatchObject({ offline: true, result: 'accepted' });
    expect(scans().every((c) => (c.body as { id: string }).id === r!.id)).toBe(true);
    expect(scanner.online).toBe(false);
  });

  it('exits need a reason, and re-entry follows a paired exit (as the server decides)', async () => {
    const at = new Date('2026-10-31T05:00:00Z');
    const r = (await roster({
      id: 'out',
      type: 'exit',
      linkedCheckpointId: 'gate',
    })) as unknown as ScanRoster;
    r.exits = [{ id: 'out', linkedCheckpointId: 'gate' }];
    const person: ScanRoster['people'][number] = { ...r.people[0]!, status: 'checked_in' };
    expect(decideOffline(r, person, at)).toBeNull();
    person.outsideSince = at.toISOString();
    person.outsideCheckpointId = 'out';
    expect(decideOffline(r, person, at)).toBe('not_inside');

    const gate = (await roster()) as unknown as ScanRoster;
    gate.exits = r.exits;
    const back = { ...person, lastAcceptedAt: '2026-10-31T04:00:00.000Z' };
    expect(decideOffline(gate, back, at)).toBeNull(); // re-entry, not a duplicate
    expect(decideOffline(gate, { ...back, outsideSince: null }, at)).toBe('duplicate');
    expect(decideOffline(gate, { ...back, lastAcceptedAt: '2026-10-31T04:59:58.000Z' }, at)).toBe(
      'duplicate',
    ); // same sighting
  });

  it('without a cached roster, offline scans are refused', async () => {
    const { scanner } = setup({ offline: memoryStorage() });
    // No roster route: the mock answers {} and it is ignored.
    await scanner.check();
    await scanner.refreshRoster();
    expect(scanner.offlineReady).toBe(false);
  });
});
