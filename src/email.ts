/**
 * Helpers to write an email template as ordinary HTML in your own code, for
 * `event.emails.save()`. Each one returns the Mustache text eventKit fills in
 * when it sends (`{{team.name}}`, `{{#members}}…{{/members}}`), so the template
 * stays plain HTML with no build step. eventKit escapes every value.
 *
 * Mail apps run no scripts, so a button in an email is a link: put a link
 * variable in its `href` (`member.dashboardUrl`, `links.portal`).
 *
 * ```ts
 * import { registrationEmail as t } from '@eventkit/sdk';
 *
 * const html = `<!doctype html><html><body>
 *   <h1>${t.team.name} is in!</h1>
 *   ${t.eachMember((m) => `
 *     <p>${m.name}${t.when(m.isLeader, ' (leader)')} · ${m.participantCode}</p>
 *     ${t.when(m.dashboardUrl, t.button({ href: m.dashboardUrl, label: 'Open dashboard' }))}
 *   `)}
 * </body></html>`;
 * await ek.event(id).emails.save('registration', {
 *   subject: `${t.event.name}: ${t.team.name} is registered`,
 *   html,
 * });
 * ```
 */

/** A value eventKit fills in, written as `{{name}}`. */
export type TemplateVariable = `{{${string}}}`;

const v = <N extends string>(name: N) => `{{${name}}}` as const;

const nameOf = (variable: TemplateVariable) => {
  const name = /^\{\{([\w.]+)\}\}$/.exec(variable)?.[1];
  if (!name) throw new Error(`Not a template variable: ${variable}`);
  return name;
};

/** The variables of one member, inside `eachMember`. */
export interface MemberVariables {
  name: TemplateVariable;
  email: TemplateVariable;
  /** e.g. MZ-0007 */
  participantCode: TemplateVariable;
  /** Set for the leader: use with `when` / `unless`. */
  isLeader: TemplateVariable;
  /** The member's personal link to their dashboard; empty when the event has no portal URL. */
  dashboardUrl: TemplateVariable;
}

const member: MemberVariables = {
  name: v('name'),
  email: v('email'),
  participantCode: v('participantCode'),
  isLeader: v('isLeader'),
  dashboardUrl: v('linkUrl'),
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface ButtonOptions {
  /** Where it goes: usually a link variable, e.g. `member.dashboardUrl`. */
  href: string;
  /** The text on it; may hold variables. */
  label: string;
  /** Default #111827. */
  background?: string;
  /** Default #ffffff. */
  color?: string;
  /** Default 8px. */
  radius?: string;
}

/** The registration email (sent to the team leader once the team registers). */
export const registrationEmail = {
  event: {
    name: v('event.name'),
    hostedBy: v('event.hostedBy'),
    venue: v('event.venue'),
    /** "7 Nov 2026, 8:00 am IST – 8 Nov 2026, 7:00 pm IST" */
    when: v('event.when'),
    startAt: v('event.startAt'),
    endAt: v('event.endAt'),
  },
  team: { name: v('team.name') },
  /** How many people registered. */
  memberCount: v('memberCount'),
  /** The leader, who receives the email. */
  leader: {
    name: v('leader.name'),
    email: v('leader.email'),
    participantCode: v('leader.participantCode'),
    /** The leader's personal link to their dashboard; empty without a portal URL. */
    dashboardUrl: v('leader.linkUrl'),
  },
  /** Links for buttons. Each is empty when the event has no portal URL: wrap buttons in `when`. */
  links: {
    /** The event's portal (its home page). */
    portal: v('event.portalUrl'),
    /** The leader's dashboard. Inside `eachMember`, use the member's `dashboardUrl`. */
    leaderDashboard: v('leader.linkUrl'),
  },

  /** Repeats `render` for every member, the leader included, in form order. */
  eachMember(render: (m: MemberVariables) => string): string {
    return `{{#members}}${render(member)}{{/members}}`;
  },

  /** `html` only when the variable is set (a link exists, the member is the leader, …). */
  when(variable: TemplateVariable, html: string): string {
    const name = nameOf(variable);
    return `{{#${name}}}${html}{{/${name}}}`;
  },

  /** `html` only when the variable is empty or false. */
  unless(variable: TemplateVariable, html: string): string {
    const name = nameOf(variable);
    return `{{^${name}}}${html}{{/${name}}}`;
  },

  /**
   * A link styled as a button that holds up in Gmail, Outlook and Apple Mail
   * (a table cell with inline styles). Mail apps run no scripts: a button can
   * only open a link.
   */
  button({
    href,
    label,
    background = '#111827',
    color = '#ffffff',
    radius = '8px',
  }: ButtonOptions) {
    const style = `display:inline-block;padding:12px 20px;border-radius:${radius};background:${background};color:${color};font-weight:600;text-decoration:none`;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:${radius};background:${background}"><a href="${escapeHtml(href)}" target="_blank" style="${escapeHtml(style)}">${escapeHtml(label)}</a></td></tr></table>`;
  },
};
