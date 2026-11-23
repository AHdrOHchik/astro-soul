import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIDGET_SRC, isTelegramLoginUser, mountTelegramWidget, toAuthPayload } from './telegramWidget';

describe('Telegram Login Widget', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete window.onAstroAdminTelegramAuth;
  });

  it('принимает только полный подписанный набор полей', () => {
    expect(isTelegramLoginUser({ id: 1, auth_date: 2, hash: 'h' })).toBe(true);
    expect(isTelegramLoginUser({ id: 1, auth_date: 2 })).toBe(false);
    expect(isTelegramLoginUser(null)).toBe(false);
    expect(isTelegramLoginUser('hash')).toBe(false);
  });

  it('на сервер уходит плоский набор строк, без дописанных полей', () => {
    const payload = toAuthPayload({ id: 1, first_name: 'Владелец', auth_date: 2, hash: 'h', nested: { a: 1 } });
    expect(payload).toEqual({ id: '1', first_name: 'Владелец', auth_date: '2', hash: 'h' });
    expect(toAuthPayload({})).toBeNull();
  });

  it('без имени бота виджет не монтируется — нечего рисовать', () => {
    const onError = vi.fn();
    const host = document.createElement('div');
    const cleanup = mountTelegramWidget(host, { botUsername: '', onAuth: () => undefined, onError });

    expect(onError).toHaveBeenCalledWith('no-bot');
    expect(host.children).toHaveLength(0);
    cleanup();
  });

  it('скрипт виджета вставляется с настройками бота и колбэком', () => {
    const host = document.createElement('div');
    const cleanup = mountTelegramWidget(host, { botUsername: 'astro_soul_bot', onAuth: () => undefined, onError: vi.fn() });

    const script = host.querySelector('script');
    expect(script?.getAttribute('src')).toBe(WIDGET_SRC);
    expect(script?.getAttribute('data-telegram-login')).toBe('astro_soul_bot');
    expect(script?.getAttribute('data-onauth')).toBe('onAstroAdminTelegramAuth(user)');
    expect(typeof window.onAstroAdminTelegramAuth).toBe('function');

    cleanup();
    expect(host.children).toHaveLength(0);
    expect(window.onAstroAdminTelegramAuth).toBeUndefined();
  });
});
