import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaywallScreen } from './screens/paywall/PaywallScreen';
import { chart, fakeApi, fakeTelegram, meWithChart } from './test/fixtures';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The paywall of a build made with this `VITE_SUBSCRIPTIONS`. The value goes the way it
 * goes in the app: read once by `config`, handed on as `subscriptions`.
 */
async function paywallBuiltWith(value: string | undefined) {
  vi.stubEnv('VITE_SUBSCRIPTIONS', value);
  vi.resetModules();
  const { config } = await import('./config');
  render(
    <PaywallScreen
      api={fakeApi()}
      telegram={fakeTelegram()}
      me={meWithChart}
      refreshMe={vi.fn().mockResolvedValue(meWithChart)}
      reportChartId={chart.chart_id}
      offersReport
      initialKind={null}
      subscriptions={config.subscriptions}
      track={vi.fn()}
      onOpenTerms={vi.fn()}
      onReportPaid={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

/** The plans of the three subscriptions, as far as the document has them in any form. */
const subscriptionPlans = async () => (await screen.findAllByRole('radio')).filter((radio) => /^Подписка на /.test(radio.closest('label')?.textContent ?? ''));

describe('VITE_SUBSCRIPTIONS: subscriptions are sold only when the build says `enabled`', () => {
  it('not set: no subscription plan in the DOM', async () => {
    await paywallBuiltWith(undefined);
    expect(await subscriptionPlans()).toHaveLength(0);
  });

  it('empty: no subscription plan in the DOM', async () => {
    await paywallBuiltWith('');
    expect(await subscriptionPlans()).toHaveLength(0);
  });

  it('`enabled`: the three plans are there', async () => {
    await paywallBuiltWith('enabled');
    expect(await subscriptionPlans()).toHaveLength(3);
  });

  // The build stops on such a value (tests/build-settings.test.ts). Should a bundle be made with it all the same, it sells nothing.
  it('`of`: no subscription plan in the DOM either', async () => {
    await paywallBuiltWith('of');
    expect(await subscriptionPlans()).toHaveLength(0);
  });
});
