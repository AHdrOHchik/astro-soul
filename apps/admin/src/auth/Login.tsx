/*
 * Экран входа (контракт 1.6.15: маршруты есть, надвигаться нечем).
 * Состояния и их тексты:
 *
 *   anonymous          — сервер готов пускать, но тебя ещё нет: виджет;
 *   anonymous(expired) — сессия умерла на запросе: тот же виджет плюс
 *                        «Сессия истекла, войди снова»;
 *   error              — отказ входа: текст разбирает `loginErrors.ts` —
 *                        подпись/устарело/не админ/429/«сервер не принимает»
 *                        это пять разных сообщений, а не одно.
 *
 * Ни одного «демо-входа» вне ДЕМО-режима: кнопка появляется только когда панель
 * знает, что данные ей отдаёт мокер.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { config } from '../env';
import { ru } from '../i18n/ru';
import { Banner, Notice } from '../ui/primitives';
import { loginErrorText } from './loginErrors';
import type { SessionStore } from './session';
import { isTelegramLoginUser, mountTelegramWidget, toAuthPayload } from './telegramWidget';

export interface LoginProps {
  readonly store: SessionStore;
  readonly view: ReturnType<SessionStore['getSnapshot']>;
  readonly demo: boolean;
}

/** Кнопка «я админ» для локального просмотра интерфейса. Только в ДЕМО. */
async function demoSignIn(store: SessionStore): Promise<void> {
  await store.signIn({ id: 0, first_name: 'ДЕМО', auth_date: Math.floor(Date.now() / 1000), hash: 'demo' });
}

export function Login({ store, view, demo }: LoginProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [widgetError, setWidgetError] = useState<'none' | 'load' | 'no-bot'>('none');
  const [busy, setBusy] = useState(false);

  const onAuth = useCallback(
    async (user: unknown) => {
      // Подпись мы не проверяем и не логируем: проверка — дело сервера.
      if (!isTelegramLoginUser(user)) return;
      const payload = toAuthPayload(user);
      if (payload === null) return;
      setBusy(true);
      await store.signIn(payload);
      setBusy(false);
    },
    [store],
  );

  // Виджет живёт и при отказе входа: «Попробуй войти ещё раз» обязан быть
  // кликом, а не перезагрузкой страницы.
  const canSignIn = view.kind !== 'live';

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !canSignIn) return;
    return mountTelegramWidget(host, {
      botUsername: config.botUsername,
      onAuth: (user) => void onAuth(user),
      onError: (reason) => { setWidgetError(reason); },
    });
  }, [canSignIn, onAuth]);

  return (
    <section className="grid" style={{ gridTemplateColumns: 'minmax(0, 720px)' }}>
      <div>
        <h1>{ru.login.heading}</h1>
        <p className="lead">{ru.login.lead}</p>

        {view.kind === 'anonymous' && view.reason === 'expired' ? (
          <Banner level="warn" title={ru.login.expired} />
        ) : null}
        {view.kind === 'anonymous' && view.reason === 'signed-out' ? (
          <Banner level="info" title={ru.login.signedOut} />
        ) : null}

        {view.kind === 'error' ? (
          <Banner level="crit" title={ru.login.failed}>
            <p>{loginErrorText(view.error)}</p>
            <p className="muted mono">
              {view.error.code}
              {view.error.requestId ? ` · request_id ${view.error.requestId}` : ''}
            </p>
          </Banner>
        ) : null}

        {canSignIn ? (
          <>
            {/* Контейнер виджета рисуется всегда, пока вход возможен: «нет
                бота» сообщает сам монтировщик (`onError('no-bot')`), и тогда
                текст об этом один, а не два. Размонтировать контейнер после
                отказа означало бы «попробуй ещё раз, но сначала F5». */}
            <div ref={hostRef} aria-label={ru.login.widgetAlt} />
            {widgetError === 'load' ? <Banner level="warn" title={ru.login.widgetBlocked} /> : null}
            {widgetError === 'no-bot' ? <Banner level="warn" title={ru.login.noBotUsername} /> : null}
            {busy ? <Notice>{ru.login.submitting}</Notice> : null}
          </>
        ) : null}

        {demo ? (
          <>
            <Notice>{ru.demo.loginHint}</Notice>
            <button type="button" className="primary" onClick={() => void demoSignIn(store)} disabled={busy}>
              {ru.demo.loginButton}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
