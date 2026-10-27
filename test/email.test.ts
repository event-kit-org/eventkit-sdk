import { describe, expect, it } from 'vitest';
import { registrationEmail as t } from '../src';

describe('registrationEmail', () => {
  it('writes the variables eventKit fills in', () => {
    expect(`${t.event.name}: ${t.team.name} is registered`).toBe(
      '{{event.name}}: {{team.name}} is registered',
    );
    expect(t.leader.dashboardUrl).toBe('{{leader.linkUrl}}');
    expect(t.links.portal).toBe('{{event.portalUrl}}');
  });

  it('repeats a block per member, with conditions', () => {
    const html = t.eachMember(
      (m) =>
        `<p>${m.name}${t.when(m.isLeader, ' (leader)')}</p>${t.unless(m.dashboardUrl, 'Ask the organisers')}`,
    );
    expect(html).toBe(
      '{{#members}}<p>{{name}}{{#isLeader}} (leader){{/isLeader}}</p>{{^linkUrl}}Ask the organisers{{/linkUrl}}{{/members}}',
    );
  });

  it('makes a link button, escaping its text but keeping variables', () => {
    const html = t.eachMember((m) =>
      t.button({
        href: m.dashboardUrl,
        label: `Open ${m.name}'s "dashboard" & more`,
        background: '#a78bfa',
      }),
    );
    expect(html).toContain('<a href="{{linkUrl}}" target="_blank"');
    expect(html).toContain('background:#a78bfa');
    expect(html).toContain(">Open {{name}}'s &quot;dashboard&quot; &amp; more</a>");
  });

  it('refuses something that is not a variable', () => {
    expect(() => t.when('{{{raw}}}' as never, 'x')).toThrow('Not a template variable');
    expect(() => t.unless('plain' as never, 'x')).toThrow('Not a template variable');
  });
});
