import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../src';
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
  it('register uploads the receipt straight to storage, then submits its key', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket());
    mock.on('PUT /events/*', () => new Response(null));
    const file = png(40);
    await event.myTeam.register({ receipt: file });
    const [askLink, put, submit] = mock.calls;
    expect(askLink!.body).toEqual({ purpose: 'receipt', contentType: 'image/png', size: 40 });
    expect(put!.url).toBe('https://bucket.test/events/e/receipts/t/k.png?sig=1');
    expect(put!.headers.get('content-type')).toBe('image/png');
    expect(submit!.body).toEqual({ receiptKey: 'events/e/receipts/t/k.png' });
  });

  it('register without a receipt sends none; payReceipt and setPaymentQr upload first', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket('k2'));
    mock.on('PUT /k2', () => new Response(null));
    await event.myTeam.register();
    expect(mock.last().body).toEqual({});
    await event.myTeam.payReceipt(png());
    expect(mock.last().body).toEqual({ receiptKey: 'k2' });
    await event.setPaymentQr(png());
    expect(mock.last().body).toEqual({ key: 'k2' });
    expect(
      mock.calls
        .filter((c) => c.path.endsWith('/uploads'))
        .map((c) => (c.body as { purpose: string }).purpose),
    ).toEqual(['receipt', 'payment_qr']);
  });

  it('refuses wrong types and big files before asking the API', async () => {
    const { event, mock } = client();
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    await expect(event.setPaymentQr(pdf)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
      message: 'Upload a JPEG, PNG, WEBP file.',
    });
    await expect(event.uploads.upload('receipt', png(MAX_UPLOAD_BYTES + 1))).rejects.toMatchObject({
      status: 413,
      code: 'FILE_TOO_LARGE',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('reports refused links, failed PUTs and unreachable storage', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => apiError(403, 'NOT_TEAM_LEADER'));
    await expect(event.myTeam.payReceipt(png())).rejects.toMatchObject({ code: 'NOT_TEAM_LEADER' });
    mock.on('POST /v1/events/:id/uploads', () => ticket('k3'));
    mock.on('PUT /k3', () => new Response(null, { status: 403 }));
    await expect(event.myTeam.payReceipt(png())).rejects.toMatchObject({
      status: 403,
      code: 'UPLOAD_FAILED',
    });
    mock.on('PUT /k3', () => {
      throw new TypeError('network');
    });
    await expect(event.myTeam.payReceipt(png())).rejects.toMatchObject({
      status: 0,
      code: 'UPLOAD_FAILED',
    });
  });
});
