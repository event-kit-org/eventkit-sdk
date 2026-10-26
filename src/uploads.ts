import { EventKitError } from './errors';
import type { Transport } from './http';

export type UploadPurpose = 'receipt' | 'payment_qr';
type FileType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** What each upload accepts. The API checks again, by the file's first bytes. */
export const UPLOAD_TYPES: Record<UploadPurpose, readonly FileType[]> = {
  receipt: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  payment_qr: ['image/jpeg', 'image/png', 'image/webp'],
};
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Uploads a file straight to storage and returns its key:
 *   1. the API checks permission and returns a short-lived presigned link,
 *   2. the file is PUT to it (it never passes through the API),
 *   3. the caller hands the key to the action that uses it.
 * `file` is a browser File, or any Blob with a `type` (Node 18+ too).
 */
export async function uploadFile(
  t: Transport,
  eventId: string,
  purpose: UploadPurpose,
  file: Blob,
): Promise<string> {
  const type = UPLOAD_TYPES[purpose].find((x) => x === file.type);
  if (!type) {
    const names = UPLOAD_TYPES[purpose].map((x) => x.split('/')[1]!.toUpperCase()).join(', ');
    throw new EventKitError(415, 'UNSUPPORTED_FILE_TYPE', `Upload a ${names} file.`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new EventKitError(413, 'FILE_TOO_LARGE', 'Files can be at most 5 MB.');
  }
  const ticket = await t.call(
    t.api.POST('/v1/events/{eventId}/uploads', {
      params: { path: { eventId } },
      body: { purpose, contentType: type, size: file.size },
    }),
  );
  let res: Response;
  try {
    res = await t.fetch(ticket.url, {
      method: ticket.method,
      headers: ticket.headers,
      body: file,
    });
  } catch (e) {
    throw new EventKitError(0, 'UPLOAD_FAILED', 'The upload failed. Check the connection.', e);
  }
  if (!res.ok) {
    throw new EventKitError(res.status, 'UPLOAD_FAILED', 'The upload failed. Try again.');
  }
  return ticket.key;
}
