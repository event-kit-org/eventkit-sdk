import { describe, expect, it } from 'vitest';
import { registrationEmail as t } from '../src';

describe('registrationEmail', () => {
  it('writes the variables eventKit fills in', () => {
    expect(`${t.event.name}: ${t.team.name} is registered`).toBe(
      '{{event.name}}: {{team.name}} is registered',
    );
    expect(t.member.dashboardUrl).toBe('{{member.linkUrl}}');
    expect(t.linkReplaced).toBe('{{linkReplaced}}');
    expect(t.links.portal).toBe('{{event.portalUrl}}');
  });

  it('repeats a block per member, with conditions', () => {
    const html = t.eachMember(
      (m) =>
        `<p>${m.name}${t.when(m.isLeader, ' (leader)')}</p>${t.unless(t.member.dashboardUrl, 'Ask the organisers')}`,
    );
    expect(html).toBe(
      '{{#members}}<p>{{name}}{{#isLeader}} (leader){{/isLeader}}</p>{{^member.linkUrl}}Ask the organisers{{/member.linkUrl}}{{/members}}',
    );
  });

  it('makes a link button, escaping its text but keeping variables', () => {
    const html = t.button({
      href: t.member.dashboardUrl,
      label: `Open ${t.member.name}'s "dashboard" & more`,
      background: '#a78bfa',
    });
    expect(html).toContain('<a href="{{member.linkUrl}}" target="_blank"');
    expect(html).toContain('background:#a78bfa');
    expect(html).toContain(">Open {{member.name}}'s &quot;dashboard&quot; &amp; more</a>");
  });

  it('refuses something that is not a variable', () => {
    expect(() => t.when('{{{raw}}}' as never, 'x')).toThrow('Not a template variable');
    expect(() => t.unless('plain' as never, 'x')).toThrow('Not a template variable');
  });
});
