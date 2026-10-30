import type { Schemas } from '../types';
import { toISTInput } from './datetime';

export type Field = Schemas['EventField'];
export type TeamRule = Schemas['TeamRule'];
/** A list for multi_choice fields. */
export type Answers = Record<string, string | number | string[]>;
/**
 * Form state: what inputs hold. Numbers as typed, multi-selects as the
 * picked options, date-times as `<input type="datetime-local">` values in IST.
 */
export type Draft = Record<string, string | string[]>;
/** What a form's fields have in common: registration and submission fields both fit. */
type FieldLike = Pick<Field, 'id' | 'type' | 'required'>;

export const teamFields = (fields: Field[]) => fields.filter((f) => f.scope === 'team');
export const memberFields = (fields: Field[]) => fields.filter((f) => f.scope === 'member');

/** Saved answers → form state. Pass the fields so date-times fill their inputs. */
export function toDraft(answers: Answers | undefined, fields: FieldLike[] = []): Draft {
  const types = new Map(fields.map((f) => [f.id, f.type]));
  return Object.fromEntries(
    Object.entries(answers ?? {}).map(([k, v]) => {
      if (Array.isArray(v)) return [k, v];
      if (types.get(k) === 'datetime' && typeof v === 'string') return [k, toISTInput(v)];
      return [k, String(v)];
    }),
  );
}

/** A `<input type="datetime-local">` value read as IST, e.g. 2026-10-31T09:30+05:30. */
const istDateTime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}+05:30` : value;

/**
 * Form state → API answers for these fields: numbers as numbers, multi-selects
 * as lists, date-times as IST with their offset, blanks (and empty lists) cleared.
 */
export function toAnswers(
  fields: FieldLike[],
  draft: Draft,
): Record<string, string | number | string[] | null> {
  const out: Record<string, string | number | string[] | null> = {};
  for (const f of fields) {
    const raw = draft[f.id];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      out[f.id] = raw.length === 0 ? null : raw;
      continue;
    }
    const value = raw.trim();
    if (value === '') out[f.id] = null;
    else if (f.type === 'number') out[f.id] = Number(value);
    else if (f.type === 'datetime') out[f.id] = istDateTime(value);
    else out[f.id] = value;
  }
  return out;
}

const isEmpty = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v.length === 0 : !(v ?? '').trim();

/** Required fields the draft leaves empty. */
export const missingRequired = <F extends FieldLike>(fields: F[], draft: Draft) =>
  fields.filter((f) => f.required && isEmpty(draft[f.id]));

/** One option ticked or unticked in a multi-select's draft value. */
export function toggleOption(current: string | string[] | undefined, option: string): string[] {
  const list = Array.isArray(current) ? current : [];
  return list.includes(option) ? list.filter((o) => o !== option) : [...list, option];
}

/** An answer as text, e.g. for a table: lists joined with ", ". */
export const answerText = (v: string | number | string[] | undefined): string =>
  v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);

export interface RuleCheck {
  rule: TeamRule;
  count: number;
  met: boolean;
}

/**
 * How the members' answers stand against each team rule ("at least N members
 * with <field> = <value>"). The API checks them at registration too; check
 * here first to show people what's missing.
 */
export function checkTeamRules(rules: TeamRule[], members: Answers[]): RuleCheck[] {
  return rules.map((rule) => {
    const count = members.filter((a) => a[rule.fieldId] === rule.value).length;
    return { rule, count, met: count >= rule.minCount };
  });
}
