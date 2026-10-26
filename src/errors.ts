/**
 * Stable error codes the API returns (the `code` of every error), plus the
 * devkit's own. New codes can appear; treat unknown ones as generic failures.
 */
export type ErrorCode =
  // auth and keys
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'
  | 'API_KEY_REQUIRED'
  | 'API_KEY_INVALID'
  | 'API_KEY_EVENT_MISMATCH'
  // access
  | 'EVENT_NOT_FOUND'
  | 'ROLE_FORBIDDEN'
  | 'FEATURE_DISABLED'
  | 'FEATURE_NOT_PURCHASED'
  | 'ALREADY_IN_EVENT'
  | 'LAST_ADMIN'
  // links and teams
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'INVITE_PASSWORD_WRONG'
  | 'TEAM_LINK_NOT_FOUND'
  | 'NO_ACCOUNT'
  | 'NO_TEAM'
  | 'NOT_TEAM_LEADER'
  | 'ALREADY_IN_TEAM'
  | 'ALREADY_INVITED'
  | 'INVITEE_IS_STAFF'
  | 'INVITEE_IN_TEAM'
  | 'TEAM_FULL'
  | 'TEAM_LOCKED'
  | 'TEAM_NAME_TAKEN'
  | 'TEAM_SIZE'
  | 'LEADER_CANNOT_LEAVE'
  | 'IS_TEAM_LEADER'
  | 'MISSING_DETAILS'
  | 'INVALID_ANSWERS'
  | 'ANSWER_TAKEN'
  // registration and payment
  | 'REGISTRATION_NOT_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'ALREADY_REGISTERED'
  | 'NOT_REGISTERED'
  | 'EVENT_FULL'
  | 'NOT_ENOUGH_PLACES'
  | 'INVALID_TRANSITION'
  | 'RECEIPT_REQUIRED'
  | 'RECEIPT_NOT_EXPECTED'
  | 'PAYMENT_NOT_DUE'
  | 'PAYMENT_CLOSED'
  | 'PROOF_PENDING'
  | 'ALREADY_PAID'
  | 'NO_PAYMENT_NEEDED'
  | 'PAYMENT_SETTINGS_LOCKED'
  // files
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'UPLOAD_INVALID'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_FAILED'
  // on-site, polls, notifications, judging
  | 'UNKNOWN_QR'
  | 'CANNOT_SEND_TO_CHANNEL'
  | 'LEADERBOARD_HIDDEN'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'ROUTE_NOT_FOUND'
  // not found
  | 'API_KEY_NOT_FOUND'
  | 'CHANNEL_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CRITERION_NOT_FOUND'
  | 'FIELD_NOT_FOUND'
  | 'MEMBER_NOT_FOUND'
  | 'OPTION_NOT_FOUND'
  | 'PAYMENT_QR_NOT_FOUND'
  | 'POLL_NOT_FOUND'
  | 'PROOF_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'REGISTRATION_NOT_FOUND'
  | 'RULE_NOT_FOUND'
  | 'TEAM_NOT_FOUND'
  | 'USER_NOT_FOUND'
  // other refusals
  | 'CHANNEL_NAME_TAKEN'
  | 'INVALID_SCORES'
  | 'NOT_CANCELLED'
  | 'NOT_IN_AUDIENCE'
  | 'POLL_CLOSED'
  | 'POLL_IN_USE'
  | 'POLL_ONLY_FOR_MEALS'
  | 'PROOF_NOT_PENDING'
  | 'SCAN_ID_CONFLICT'
  | 'TOO_FEW_OPTIONS'
  | 'USE_STAFF_FLOW'
  | 'USE_TEAM_FLOW'
  // devkit
  | 'NO_EVENT_ID'
  | 'NETWORK_ERROR'
  | 'OFFLINE'
  | 'NOT_SUPPORTED'
  | 'UNKNOWN_ERROR';

/** Every failed call throws this: the API's `{ error: { code, message, details } }`. */
export class EventKitError extends Error {
  readonly status: number;
  readonly code: ErrorCode | (string & {});
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'EventKitError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** True when `e` is an EventKitError, optionally with one of the given codes. */
export function isEventKitError(e: unknown, ...codes: ErrorCode[]): e is EventKitError {
  return e instanceof EventKitError && (codes.length === 0 || codes.includes(e.code as ErrorCode));
}

/** Field-level messages from an INVALID_ANSWERS or VALIDATION_ERROR, keyed by path. */
export function fieldErrors(e: unknown, prefix = ''): Record<string, string> {
  if (!(e instanceof EventKitError) || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: string; message?: string }[]) {
    if (typeof d?.path !== 'string' || typeof d.message !== 'string') continue;
    if (!prefix) out[d.path] = d.message;
    else if (d.path.startsWith(`${prefix}/`)) out[d.path.slice(prefix.length + 1)] = d.message;
  }
  return out;
}
