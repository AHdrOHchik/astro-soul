import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../../api';
import { ru } from '../../i18n/ru';
import { apiError, deferred, fakeAnalytics, fakeApi, fakeTelegram, me, meWithChart } from '../../test/fixtures';
import { SettingsScreen, type SettingsScreenProps } from './SettingsScreen';

function setup(profile: Me = meWithChart, api = fakeApi()) {
  const user = userEvent.setup();
  const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockResolvedValue(profile);
  const view = render(
    <SettingsScreen
      api={api}
      telegram={fakeTelegram()}
      refreshMe={refreshMe}
      supportLink=""
      track={fakeAnalytics().track}
      onOpenDocument={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );
  return { ...view, api, user };
}

describe('SettingsScreen: daily forecast notification', () => {
  it('defaults to on when an older GET /me has no notifications field', async () => {
    const olderMe: Me = { ...meWithChart, notifications: undefined };
    setup(olderMe);
    expect(await screen.findByRole('switch', { name: ru.settings.notifications.dailyForecast })).toBeChecked();
    expect(screen.getByText('Приходит раз в день, по времени места рождения. Отключить можно в любой момент')).toBeInTheDocument();
  });

  it('sends false, stays at the old value while saving, then takes the value from the response', async () => {
    const pending = deferred<{ daily_forecast: boolean }>();
    const api = fakeApi();
    api.updateNotifications.mockReturnValueOnce(pending.promise);
    const { user } = setup(meWithChart, api);
    const control = await screen.findByRole('switch', { name: ru.settings.notifications.dailyForecast });
    expect(control).toBeChecked();

    await user.click(control);

    expect(api.updateNotifications).toHaveBeenCalledWith(false);
    expect(control).toBeDisabled();
    expect(control).toBeChecked();
    await act(async () => {
      pending.resolve({ daily_forecast: false });
      await pending.promise;
    });
    expect(control).not.toBeDisabled();
    expect(control).not.toBeChecked();
  });

  it('keeps the prior value and shows the retry text after a request error', async () => {
    const api = fakeApi();
    api.updateNotifications.mockRejectedValueOnce(apiError('NETWORK'));
    const { user } = setup(meWithChart, api);
    const control = await screen.findByRole('switch', { name: ru.settings.notifications.dailyForecast });

    await user.click(control);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не сохранилось, попробуй ещё раз');
    expect(control).toBeChecked();
    expect(control).not.toBeDisabled();
  });

  it('shows a 422 field error on the notification control', async () => {
    const api = fakeApi();
    api.updateNotifications.mockRejectedValueOnce(apiError('VALIDATION_FAILED', {
      status: 422,
      details: { field_errors: [{ field: 'daily_forecast', message: 'Настройка отклонена.' }] },
    }));
    const { user } = setup(meWithChart, api);
    const control = await screen.findByRole('switch', { name: ru.settings.notifications.dailyForecast });

    await user.click(control);

    expect(await screen.findByRole('alert')).toHaveTextContent('Настройка отклонена. (daily_forecast)');
    expect(screen.getByRole('alert')).not.toHaveTextContent(ru.settings.notifications.saveFailed);
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toBeChecked();
  });

  it('shows an unexpected 422 field name instead of a generic save error', async () => {
    const api = fakeApi();
    api.updateNotifications.mockRejectedValueOnce(apiError('VALIDATION_FAILED', {
      status: 422,
      details: { field_errors: [{ field: 'unexpected_key', message: 'Лишнее поле.' }] },
    }));
    const { user } = setup(meWithChart, api);
    await user.click(await screen.findByRole('switch', { name: ru.settings.notifications.dailyForecast }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Лишнее поле. (unexpected_key)');
    expect(screen.getByRole('alert')).not.toHaveTextContent(ru.settings.notifications.saveFailed);
  });

  it('does not render the setting or its note for a profile with no chart', async () => {
    const noChart: Me = { ...me, chart_id: null, has_chart: false };
    const { api } = setup(noChart);
    await screen.findByRole('heading', { name: ru.settings.title });
    expect(screen.queryByRole('heading', { name: ru.settings.notifications.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: ru.settings.notifications.dailyForecast })).not.toBeInTheDocument();
    expect(screen.queryByText('Приходит раз в день, по времени места рождения. Отключить можно в любой момент')).not.toBeInTheDocument();
    expect(api.updateNotifications).not.toHaveBeenCalled();
  });

  it('uses the server value on a new visit rather than a locally retained preference', async () => {
    const profile: Me = { ...meWithChart, notifications: { daily_forecast: false } };
    setup(profile);
    expect(await screen.findByRole('switch', { name: ru.settings.notifications.dailyForecast })).not.toBeChecked();
  });
});
