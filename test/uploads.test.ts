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

  it('sets, reads and removes the payment instructions file (PDF allowed)', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/uploads', () => ticket('k3'));
    mock.on('PUT /k3', () => new Response(null));
    await event.setPaymentInstructionsFile(new Blob(['%PDF'], { type: 'application/pdf' }));
    expect(mock.calls[0]!.body).toEqual({
      purpose: 'payment_instructions',
      contentType: 'application/pdf',
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
