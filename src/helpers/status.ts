import type { Schemas } from '../types';
import {
  checkTeamRules,
  type Field,
  memberFields,
  missingRequired,
  type RuleCheck,
  teamFields,
  type TeamRule,
  toDraft,
} from './fields';

export type DisplayStatus =
  Schemas['RegistrationStatus'] | 'forming' | 'expired' | 'confirmation_pending';

/** A team's status as people read it: a receipt waiting for review is "confirmation pending". */
export function teamDisplayStatus(team: Schemas['Team']): DisplayStatus {
  const latest = team.payment.proofs[0]?.status ?? null;
  if ((team.status === 'registered' || team.status === 'shortlisted') && latest === 'pending') {
    return 'confirmation_pending';
  }
  return team.status ?? team.stage;
}

export interface RegisterCheck {
  ok: boolean;
  /** Human-readable reasons the team can't register yet. */
  reasons: string[];
  rules: RuleCheck[];
  missing: string[];
}

/**
 * Everything a leader must sort out before submitting: team size, team rules
 * (enforced only by front ends) and required details. The API re-checks size
 * and details; it does not check rules.
 */
export function canRegister(
  team: Schemas['Team'],
  event: Pick<Schemas['Event'], 'minTeamSize' | 'maxTeamSize'>,
  fields: Field[],
  rules: TeamRule[],
): RegisterCheck {
  const reasons: string[] = [];
  if (team.stage !== 'forming') reasons.push(`The team has ${team.stage}.`);
  const members = team.members.filter((m) => m.status === 'accepted');
  if (members.length < event.minTeamSize || members.length > event.maxTeamSize) {
    reasons.push(
      `A team needs ${event.minTeamSize}–${event.maxTeamSize} accepted members; this one has ${members.length}.`,
    );
  }
  const ruleChecks = checkTeamRules(
    rules,
    members.map((m) => m.answers as Record<string, string | number>),
  );
  for (const c of ruleChecks.filter((r) => !r.met)) {
    reasons.push(`${c.rule.description} (has ${c.count}).`);
  }
  const missing = [
    ...missingRequired(
      teamFields(fields),
      toDraft(team.answers as Record<string, string | number>),
    ).map((f) => f.label),
    ...members.flatMap((m) =>
      missingRequired(
        memberFields(fields),
        toDraft(m.answers as Record<string, string | number>),
      ).map((f) => `${m.user.name}: ${f.label}`),
    ),
  ];
  if (missing.length > 0) reasons.push(`Missing details: ${missing.join('; ')}.`);
  return { ok: reasons.length === 0, reasons, rules: ruleChecks, missing };
}

/** A shareable link: `{token}` in the template is replaced, else the token is appended. */
export function linkFor(template: string, token: string): string {
  return template.includes('{token}')
    ? template.replace('{token}', encodeURIComponent(token))
    : `${template.replace(/\/+$/, '')}/${encodeURIComponent(token)}`;
}
