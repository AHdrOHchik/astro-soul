/*
 * Экран входа. Три разных состояния, и каждое говорит свою правду:
 *
 *   anonymous     — сервер готов пускать, но тебя ещё нет: рисуем виджет;
 *   no-auth-route — сервер **не умеет** пускать: маршрутов входа в контракте
 *                   нет. Это не ошибка пароля, и текст здесь другой;
 *   error         — запрос не прошёл (сеть/500): показываем причину и request id.
 *
 * Ни одного «демо-входа» вне ДЕМО-режима: кнопка появляется только когда панель
 * знает, что данные ей отдаёт мокер.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { route, routeLabel } from '../api/routes';
import { config } from '../env';
import { ru } from '../i18n/ru';
import { Banner, Notice } from '../ui/primitives';
import type { SessionStore } from './session';
import { isTelegramLoginUser, mountTelegramWidget, toAuthPayload } from './telegramWidget';

export interface LoginProps {
  readonly store: SessionStore;
  readonly view: ReturnType<SessionStore['getSnapshot']>;
  readonly demo: boolean;
  readonly onOpenPublic: () => void;
}

const AUTH_ROUTES = ['authTelegram', 'authMe', 'authLogout'].map((key) => route(key));

/** Кнопка «я админ» для локального просмотра интерфейса. Только в ДЕМО. */
async function demoSignIn(store: SessionStore): Promise<void> {
  await store.signIn({ id: '0', first_name: 'ДЕМО', auth_date: String(Math.floor(Date.now() / 1000)), hash: 'demo' });
}

export function Login({ store, view, demo, onOpenPublic }: LoginProps) {
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

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || view.kind !== 'anonymous') return;
    return mountTelegramWidget(host, {
      botUsername: config.botUsername,
      onAuth: (user) => void onAuth(user),
      onError: (reason) => { setWidgetError(reason); },
    });
  }, [onAuth, view.kind]);

  return (
    <section className="grid" style={{ gridTemplateColumns: 'minmax(0, 720px)' }}>
      <div>
        <h1>{ru.login.heading}</h1>
        <p className="lead">{ru.login.lead}</p>

        {view.kind === 'no-auth-route' ? (
          <Banner level="crit" title={ru.login.noRoute.title}>
            <p>{ru.login.noRoute.lead}</p>
            <p>
              <strong>{ru.login.noRoute.routes}</strong>
            </p>
            <ul className="tight mono">
              {AUTH_ROUTES.map((item) => (
                <li key={`${item.method}-${item.path}`}>{routeLabel(item)}</li>
              ))}
            </ul>
            <p>
              <strong>{ru.login.noRoute.whatWorks}</strong>
            </p>
            <p>{ru.login.noRoute.whatWorksLead}</p>
            <p>
              <button type="button" onClick={onOpenPublic}>
                {ru.app.shortTitle}: {ru.nav.overview}
              </button>
            </p>
          </Banner>
        ) : null}

        {view.kind === 'error' ? (
          <Banner level="crit" title={ru.login.failed}>
            <p>{view.error.message}</p>
            <p className="muted mono">
              {view.error.code}
              {view.error.requestId ? ` · request_id ${view.error.requestId}` : ''}
            </p>
          </Banner>
        ) : null}

        {view.kind === 'anonymous' ? (
          <>
            {config.botUsername === '' ? (
              <Notice>{ru.login.noBotUsername}</Notice>
            ) : (
              <div ref={hostRef} aria-label={ru.login.widgetAlt} />
            )}
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
