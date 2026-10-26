import type { Schemas } from '../types';

export type Field = Schemas['EventField'];
export type TeamRule = Schemas['TeamRule'];
export type Answers = Record<string, string | number>;
/** Form state: what inputs hold, numbers too, as typed. */
export type Draft = Record<string, string>;

export const teamFields = (fields: Field[]) => fields.filter((f) => f.scope === 'team');
export const memberFields = (fields: Field[]) => fields.filter((f) => f.scope === 'member');

export const toDraft = (answers: Answers | undefined): Draft =>
  Object.fromEntries(Object.entries(answers ?? {}).map(([k, v]) => [k, String(v)]));

/** Form state → API answers for these fields (numbers as numbers, blanks cleared). */
export function toAnswers(fields: Field[], draft: Draft): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const f of fields) {
    const raw = draft[f.id];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value === '') out[f.id] = null;
    else out[f.id] = f.type === 'number' ? Number(value) : value;
  }
  return out;
}

/** Required fields the draft leaves empty. */
export const missingRequired = (fields: Field[], draft: Draft) =>
  fields.filter((f) => f.required && !(draft[f.id] ?? '').trim());

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
