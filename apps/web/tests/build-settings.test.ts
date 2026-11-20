// @vitest-environment node
/*
 * What a build says it is made with, and what stops it. Checked through the function the
 * build calls (scripts/buildSettings.ts): `pnpm build` and `vite build` only print its lines.
 */
import { describe, expect, it } from 'vitest';
import { readBuildSettings } from '../scripts/buildSettings.ts';
import { CONSENT_VERSION } from '../src/i18n/ru.ts';

describe('the settings of a build, in the words it prints', () => {
  it('nothing set: subscriptions are off, and every missing value is named with what it costs', () => {
    expect(readBuildSettings({}).lines).toEqual([
      'subscriptions: OFF (set VITE_SUBSCRIPTIONS=enabled to sell)',
      'support:       NOT SET → кнопка поддержки будет неактивна',
      `consent:       ${CONSENT_VERSION}`,
    ]);
  });

  it('all settings set: the three lines stay in the same order with the values', () => {
    const env = { VITE_SUBSCRIPTIONS: 'enabled', VITE_SUPPORT_CONTACT: '@astro_soul_support' };
    expect(readBuildSettings(env).lines).toEqual([
      'subscriptions: ON SALE',
      'support:       @astro_soul_support',
      `consent:       ${CONSENT_VERSION}`,
    ]);
  });

  it('the consent line is the version of the legal texts the app sends, a date', () => {
    expect(readBuildSettings({}).lines[2]).toMatch(/^consent: {7}\d{4}-\d{2}-\d{2}$/);
  });
});

describe('a build without the support contact', () => {
  it('an empty VITE_SUPPORT_CONTACT does not stop the build: the line says NOT SET, the app gets no link', () => {
    const settings = readBuildSettings({ VITE_SUPPORT_CONTACT: '' });
    expect(settings.lines[1]).toBe('support:       NOT SET → кнопка поддержки будет неактивна');
    expect(settings.supportLink).toBe('');
  });

  it.each([
    ['@astro_soul_support', '@astro_soul_support', 'https://t.me/astro_soul_support'],
    ['astro_soul_support', '@astro_soul_support', 'https://t.me/astro_soul_support'],
    ['https://t.me/astro_soul_support', '@astro_soul_support', 'https://t.me/astro_soul_support'],
    ['https://help.astro.example/contact', 'https://help.astro.example/contact', 'https://help.astro.example/contact'],
  ])('VITE_SUPPORT_CONTACT=%s: the line says %s, the button leads to %s', (contact, shown, link) => {
    const settings = readBuildSettings({ VITE_SUPPORT_CONTACT: contact });
    expect(settings.lines[1]).toBe(`support:       ${shown}`);
    expect(settings.supportLink).toBe(link);
  });


});

describe('what a build sells', () => {
  it.each([
    ['not set', {}],
    ['empty', { VITE_SUBSCRIPTIONS: '' }],
    ['`off`', { VITE_SUBSCRIPTIONS: 'off' }],
  ])('VITE_SUBSCRIPTIONS %s: no subscriptions', (_what, env) => {
    expect(readBuildSettings(env)).toMatchObject({ subscriptions: false });
  });

  it('VITE_SUBSCRIPTIONS=enabled, and nothing else: subscriptions', () => {
    expect(readBuildSettings({ VITE_SUBSCRIPTIONS: 'enabled' })).toMatchObject({ subscriptions: true });
  });
});

describe('a value nobody can read stops the build (and the dev server: vite.config.ts calls the same function)', () => {
  it('VITE_SUBSCRIPTIONS=of: the build fails', () => {
    expect(() => readBuildSettings({ VITE_SUBSCRIPTIONS: 'of' })).toThrow('VITE_SUBSCRIPTIONS is «of»');
  });

  it.each(['0', '1', 'yes', 'no', 'true', 'false', 'on', 'OFF', 'Enabled', 'ENABLED', 'disabled', 'enabled,off'])(
    'VITE_SUBSCRIPTIONS=%s: neither «sell» nor «do not sell»',
    (value) => {
      expect(() => readBuildSettings({ VITE_SUBSCRIPTIONS: value })).toThrow(/^VITE_SUBSCRIPTIONS is «/);
    },
  );

  it.each(['support@astro.example', 'http://t.me/astro_soul_support', 'поддержка', 'a b'])(
    'VITE_SUPPORT_CONTACT=%s: neither a Telegram username nor an https link',
    (value) => {
      expect(() => readBuildSettings({ VITE_SUPPORT_CONTACT: value })).toThrow(/^VITE_SUPPORT_CONTACT is neither/);
    },
  );

});
