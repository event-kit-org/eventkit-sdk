import type { components, paths } from './schema';

/** Every object the API returns, by its OpenAPI name: `Schemas['Team']`, `Schemas['Poll']`, … */
export type Schemas = components['schemas'];
export type { components, paths };

type Op<P extends keyof paths, M extends keyof paths[P]> = paths[P][M];

/** The JSON body an operation takes. */
export type Body<P extends keyof paths, M extends keyof paths[P]> =
  Op<P, M> extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;

/** The query string an operation takes. */
export type Query<P extends keyof paths, M extends keyof paths[P]> =
  Op<P, M> extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

/** What an operation returns on success. */
export type Result<P extends keyof paths, M extends keyof paths[P]> =
  Op<P, M> extends { responses: infer R }
    ? R extends { 200: { content: { 'application/json': infer T } } }
      ? T
      : R extends { 201: { content: { 'application/json': infer T } } }
        ? T
        : undefined
    : never;

export type Role = Schemas['Role'];
export type Feature = Schemas['Feature'];
export type EmailKind = Schemas['EmailKind'];

/**
 * A poll answer: `optionId` (choice, dropdown), `optionIds` (multi_choice) or
 * `value` (text, number, date-time, rating). A plain string is an option id.
 */
export type PollAnswerInput =
  string | { optionId?: string; optionIds?: string[]; value?: string | number };

/** The request body for a poll answer. */
export const pollAnswerBody = (answer: PollAnswerInput) =>
  typeof answer === 'string' ? { optionId: answer } : answer;
