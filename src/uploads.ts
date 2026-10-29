import { EventKitError } from './errors';
import type { Transport } from './http';

export type UploadPurpose = 'receipt' | 'payment_qr' | 'payment_instructions';
type FileType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * What each upload accepts. The API checks again, by the file's first bytes.
 * PDFs are switched off for now.
 */
export const UPLOAD_TYPES: Record<UploadPurpose, readonly FileType[]> = {
  receipt: ['image/jpeg', 'image/png', 'image/webp'],
  payment_qr: ['image/jpeg', 'image/png', 'image/webp'],
  payment_instructions: ['image/jpeg', 'image/png', 'image/webp'],
};
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const MAX_SIDE = 2000;
const WEBP_QUALITY = 0.85;

/**
 * Re-encodes a JPG or PNG as WebP, scaled down to at most 2000 px on its
 * longest side, so stored files stay small. Runs in the browser; anything else
 * (another type, Node, a browser that cannot encode WebP, a WebP that comes out
 * bigger) gets the file back unchanged.
 */
export async function toWebp(file: Blob): Promise<Blob> {
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') return file;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
    return webp.type === 'image/webp' && webp.size < file.size ? webp : file;
  } catch {
    return file;
  }
}

export interface UploadTicket {
  key: string;
  url: string;
  method: 'PUT';
  headers: { 'Content-Type': string };
}

/**
 * Uploads a file straight to storage and returns its key:
 *   0. a JPG or PNG is turned into WebP first (in the browser, see `toWebp`),
 *   1. `ticket` asks the API (which checks permission) for a presigned link,
 *   2. the file is PUT to it (it never passes through the API),
 *   3. the caller hands the key to the action that uses it.
 * `file` is a browser File, or any Blob with a `type` (Node 18+ too).
 */
export async function putFile(
  t: Transport,
  purpose: UploadPurpose,
  file: Blob,
  ticket: (contentType: FileType, size: number) => Promise<UploadTicket>,
): Promise<string> {
  file = await toWebp(file);
  const type = UPLOAD_TYPES[purpose].find((x) => x === file.type);
  if (!type) {
    const names = UPLOAD_TYPES[purpose].map((x) => x.split('/')[1]!.toUpperCase()).join(', ');
    throw new EventKitError(415, 'UNSUPPORTED_FILE_TYPE', `Upload a ${names} file.`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new EventKitError(413, 'FILE_TOO_LARGE', 'Files can be at most 5 MB.');
  }
  const link = await ticket(type, file.size);
  let res: Response;
  try {
    res = await t.fetch(link.url, { method: link.method, headers: link.headers, body: file });
  } catch (e) {
    throw new EventKitError(0, 'UPLOAD_FAILED', 'The upload failed. Check the connection.', e);
  }
  if (!res.ok) {
    throw new EventKitError(res.status, 'UPLOAD_FAILED', 'The upload failed. Try again.');
  }
  return link.key;
}

/** Admin uploads in an event: the payment QR, or a team's receipt (with its teamId). */
export function uploadFile(
  t: Transport,
  eventId: string,
  purpose: UploadPurpose,
  file: Blob,
  teamId?: string,
): Promise<string> {
  return putFile(t, purpose, file, (contentType, size) =>
    t.call(
      t.api.POST('/v1/events/{eventId}/uploads', {
        params: { path: { eventId } },
        body: { purpose, contentType, size, ...(teamId ? { teamId } : {}) },
      }),
    ),
  );
}
