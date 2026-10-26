import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeScan, type ScanResult } from '../src';
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
  ...over,
});

function setup(opts: { now?: () => number } = {}) {
  const { ek, mock } = client();
  let n = 0;
  const scanner = ek.createScanner({
    checkpointId: 'gate',
    pingIntervalMs: 0,
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
    expect(rejected('not_attending')).toBe('Has not confirmed attendance (RSVP) yet');
    expect(rejected('not_checked_in')).toBe('Not checked in at the entry yet');
    expect(rejected('cancelled')).toBe('Registration is cancelled');
    expect(rejected(null)).toBe('Refused');
    const { ek } = client();
    const s = ek.createScanner({ checkpointId: 'g', pingIntervalMs: 0 });
    expect(s.describe(result())).toBe('Checked in');
    s.destroy();
  });
});
