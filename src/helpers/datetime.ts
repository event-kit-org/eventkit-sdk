/** The API stores and returns UTC; eventKit shows times in IST. */
const IST = 'Asia/Kolkata';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "31 Oct 2026, 9:00 am IST" */
export function formatIST(iso: string): string {
  return `${dateTime.format(new Date(iso))} IST`;
}

/** "31 Oct 2026" */
export function formatDateIST(iso: string): string {
  return dateOnly.format(new Date(iso));
}

/** UTC ISO string → value for `<input type="datetime-local">`, in IST. */
export function toISTInput(iso: string): string {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** `<input type="datetime-local">` value, read as IST → UTC ISO string for the API. */
export function fromISTInput(value: string): string {
  return new Date(new Date(`${value}:00.000Z`).getTime() - IST_OFFSET_MS).toISOString();
}
