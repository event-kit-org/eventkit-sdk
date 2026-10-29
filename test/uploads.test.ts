import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES, toWebp } from '../src';
import { apiError, client, json, png } from './mock';

const ticket = (key = 'events/e/receipts/t/k.png') =>
  json(
    {
      key,
      url: `https://bucket.test/${key}?sig=1`,
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      expiresIn: 300,
    },
    201,
  );

describe('uploads', () => {
  it("an admin attaches a team's receipt: uploaded straight to storage, then handed in", async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket());
    mock.on('PUT /events/*', () => new Response(null));
    await event.payments.attachReceipt('team-1', png(40));
    const [askLink, put, submit] = mock.calls;
    expect(askLink!.body).toEqual({
      purpose: 'receipt',
      contentType: 'image/png',
      size: 40,
      teamId: 'team-1',
    });
    expect(put!.url).toBe('https://bucket.test/events/e/receipts/t/k.png?sig=1');
    expect(put!.headers.get('content-type')).toBe('image/png');
    expect(submit!.path).toBe(
      `/v1/events/${submit!.path.split('/')[3]}/teams/team-1/payment-proofs`,
    );
    expect(submit!.body).toEqual({ receiptKey: 'events/e/receipts/t/k.png' });
  });

  it('setPaymentQr uploads first, with no team', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket('k2'));
    mock.on('PUT /k2', () => new Response(null));
    await event.setPaymentQr(png());
    expect(mock.calls[0]!.body).toEqual({
      purpose: 'payment_qr',
      contentType: 'image/png',
      size: 12,
    });
    expect(mock.last().body).toEqual({ key: 'k2' });
  });

  it('sets, reads and removes the payment instructions file', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket('k3'));
    mock.on('PUT /k3', () => new Response(null));
    await event.setPaymentInstructionsFile(png(4));
    expect(mock.calls[0]!.body).toEqual({
      purpose: 'payment_instructions',
      contentType: 'image/png',
      size: 4,
    });
    expect(mock.last().path).toMatch(/\/payment-instructions-file$/);
    expect(mock.last().body).toEqual({ key: 'k3' });
    await event.paymentInstructionsFile();
    expect(mock.last().method).toBe('GET');
    await event.removePaymentInstructionsFile();
    expect(mock.last().method).toBe('DELETE');
  });

  it('refuses wrong types and big files before asking the API', async () => {
    const { event, mock } = client();
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    for (const upload of [
      event.setPaymentQr(pdf),
      event.setPaymentInstructionsFile(pdf),
      event.payments.attachReceipt('team-1', pdf),
    ]) {
      await expect(upload).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
        message: 'Upload a JPEG, PNG, WEBP file.',
      });
    }
    await expect(event.uploads.upload('receipt', png(MAX_UPLOAD_BYTES + 1))).rejects.toMatchObject({
      status: 413,
      code: 'FILE_TOO_LARGE',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('reports refused links, failed PUTs and unreachable storage', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => apiError(403, 'ROLE_FORBIDDEN'));
    await expect(event.setPaymentQr(png())).rejects.toMatchObject({ code: 'ROLE_FORBIDDEN' });
    mock.on('POST /v1/events/:id/uploads', () => ticket('k3'));
    mock.on('PUT /k3', () => new Response(null, { status: 403 }));
    await expect(event.setPaymentQr(png())).rejects.toMatchObject({
      status: 403,
      code: 'UPLOAD_FAILED',
    });
    mock.on('PUT /k3', () => {
      throw new TypeError('network');
    });
    await expect(event.setPaymentQr(png())).rejects.toMatchObject({
      status: 0,
      code: 'UPLOAD_FAILED',
    });
  });
});

describe('WebP conversion', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A stand-in browser: images decode to `width`×`height`; the canvas encodes to `encoded`. */
  const browser = (width: number, height: number, encoded: () => Blob) => {
    const canvases: { width: number; height: number; drawn: unknown[] }[] = [];
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => ({ width, height, close }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        drawn: unknown[] = [];
        constructor(
          public width: number,
          public height: number,
        ) {
          canvases.push(this);
        }
        getContext() {
          return { drawImage: (...args: unknown[]) => this.drawn.push(args) };
        }
        async convertToBlob(options: { type: string; quality: number }) {
          expect(options).toEqual({ type: 'image/webp', quality: 0.85 });
          return encoded();
        }
      },
    );
    return { canvases, close };
  };
  const webp = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/webp' });

  it('uploads a photo as a smaller WebP, scaled to 2000 px on its longest side', async () => {
    const { canvases, close } = browser(4000, 3000, () => webp(30));
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket('k4'));
    mock.on('PUT /k4', () => new Response(null));
    await event.payments.attachReceipt('team-1', png(MAX_UPLOAD_BYTES + 1));
    expect(mock.calls[0]!.body).toMatchObject({ contentType: 'image/webp', size: 30 });
    expect(canvases[0]).toMatchObject({ width: 2000, height: 1500 });
    expect(close).toHaveBeenCalled();
  });

  it('keeps small images at their size', async () => {
    const { canvases } = browser(300, 600, () => webp(5));
    expect((await toWebp(png(40))).type).toBe('image/webp');
    expect(canvases[0]).toMatchObject({ width: 300, height: 600 });
  });

  it('leaves WebP and other types alone', async () => {
    const { canvases } = browser(10, 10, () => webp(1));
    const already = webp(20);
    expect(await toWebp(already)).toBe(already);
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    expect(await toWebp(pdf)).toBe(pdf);
    expect(canvases).toHaveLength(0);
  });

  it('keeps the original when the browser cannot help', async () => {
    const file = png(40);
    // No canvas (Node, old browsers).
    vi.stubGlobal('createImageBitmap', async () => ({}));
    expect(await toWebp(file)).toBe(file);
    // No WebP encoder: the canvas falls back to PNG.
    browser(10, 10, () => png(5));
    expect(await toWebp(file)).toBe(file);
    // The WebP comes out bigger.
    browser(10, 10, () => webp(41));
    expect(await toWebp(file)).toBe(file);
    // The image cannot be decoded.
    vi.stubGlobal('createImageBitmap', async () => {
      throw new DOMException('bad image', 'InvalidStateError');
    });
    expect(await toWebp(file)).toBe(file);
  });
});
