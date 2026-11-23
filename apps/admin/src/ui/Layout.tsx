/*
 * Каркас окна: шапка (кто вошёл, до чего сессия, выход), прилипающая плашка
 * ДЕМО и меню на все восемь разделов.
 *
 * Меню показывает и шесть разделов без маршрутов — не «чтобы было красиво», а
 * как список задач, видимый в самом приложении: админ с первой минуты видит,
 * чего в панели нет и почему.
 */

import type { ReactNode } from 'react';
import { SCREEN_READINESS, type ScreenKey } from '../api/routes';
import { config } from '../env';
import { ru } from '../i18n/ru';
import { toHref, type RouterLocation } from '../lib/router';
import { formatDateTime } from '../lib/format';
import type { AdminSession, SessionView } from '../auth/session';

const NAV: readonly { key: ScreenKey; label: string }[] = [
  { key: 'overview', label: ru.nav.overview },
  { key: 'users', label: ru.nav.users },
  { key: 'payments', label: ru.nav.payments },
  { key: 'plans', label: ru.nav.plans },
  { key: 'codes', label: ru.nav.codes },
  { key: 'founders', label: ru.nav.founders },
  { key: 'ops', label: ru.nav.ops },
  { key: 'audit', label: ru.nav.audit },
];

export interface LayoutProps {
  readonly location: RouterLocation;
  readonly view: SessionView;
  readonly demo: boolean;
  readonly onLogout: () => void;
  readonly busy: boolean;
  readonly children: ReactNode;
}

export function Layout({ location, view, demo, onLogout, busy, children }: LayoutProps) {
  const session: AdminSession | null = view.kind === 'live' ? view.session : null;
  const name = demo ? ru.demo.headerName : (session?.name ?? '—');

  return (
    <div className="shell">
      {demo ? (
        <div className="demo" role="alert">
          {ru.demo.banner}
          <small>{ru.demo.detail}</small>
        </div>
      ) : null}

      <header className="top">
        <div>
          <div className="top__brand">{ru.app.title}</div>
          <div className="top__meta">
            <span>
              {ru.app.contract} {config.contractVersion}
            </span>
            <span>
              {ru.app.signedInAs}: <strong className="mono">{name}</strong>
              {session && session.tgId !== '' ? <span className="mono"> · id {session.tgId}</span> : null}
            </span>
            {session?.expiresAt ? (
              <span>
                {ru.app.sessionExpires} {formatDateTime(session.expiresAt)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="top__actions">
          {session ? (
            <button type="button" onClick={onLogout} disabled={busy}>
              {busy ? ru.app.loggingOut : ru.app.logout}
            </button>
          ) : null}
        </div>
      </header>

      <nav className="nav" aria-label={ru.app.shortTitle}>
        {NAV.map((item) => (
          <a
            key={item.key}
            className="nav__link"
            href={toHref(item.key)}
            aria-current={location.screen === item.key ? 'page' : undefined}
          >
            {item.label}
            {SCREEN_READINESS[item.key] === 'waiting-for-routes' ? <span className="nav__mark">нет маршрутов</span> : null}
          </a>
        ))}
      </nav>

      <main id="main">{children}</main>
    </div>
  );
}
