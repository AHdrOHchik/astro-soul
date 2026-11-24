/*
 * Роутер на хэше. Сознательно свой, а не `react-router`: девять экранов, у
 * шести из которых одна страница-заглушка. Библиотека ради этого — ещё ~18 кБ
 * в бандле внутреннего инструмента и ещё одна зависимость, которую кто-то будет
 * обновлять. Плюс хэш не требует настроенных rewrite на статике: `#/plans`
 * откроется с любого хоста и из-file, что удобно на стенде.
 */

import { useEffect, useState } from 'react';
import type { ScreenKey } from '../api/routes';

export interface RouterLocation {
  readonly screen: RoutedScreen;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * Разделы, которые умеет открывать хэш-роутер. `login` в списке нет намеренно:
 * экран входа выбирается состоянием сессии, а не адресом, и ссылка `#/login`
 * не должна открывать «вход» у вошедшего человека.
 */
const ROUTED_SCREENS = ['overview', 'users', 'payments', 'plans', 'codes', 'founders', 'ops', 'audit'] as const satisfies readonly ScreenKey[];

/** Один из восьми разделов — тип, а не `string`: опечатка в адресе не живёт. */
export type RoutedScreen = (typeof ROUTED_SCREENS)[number];

const SCREEN_SET = new Set<string>(ROUTED_SCREENS as readonly string[]);

/** `#/codes?user_id=…` → `{ screen: 'codes', query: { user_id: '…' } }`. */
export function parseHash(hash: string): RouterLocation {
  const withoutMark = hash.replace(/^#/, '');
  const [rawPath, rawQuery] = withoutMark.split('?');
  const screen = (rawPath ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  const query: Record<string, string> = {};

  if (rawQuery) {
    const params = new URLSearchParams(rawQuery);
    for (const [key, value] of params) {
      // Одноимённые параметры не накапливаются: экрану нужен последний, а не список.
      query[key] = value;
    }
  }

  return { screen: SCREEN_SET.has(screen) ? (screen as RoutedScreen) : 'overview', query };
}

export function toHref(screen: ScreenKey, query?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const qs = params.toString();
  return `#/${screen}${qs === '' ? '' : `?${qs}`}`;
}

export function useHashLocation(): RouterLocation {
  const [location, setLocation] = useState<RouterLocation>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => { setLocation(parseHash(window.location.hash)); };
    window.addEventListener('hashchange', onHashChange);
    return () => { window.removeEventListener('hashchange', onHashChange); };
  }, []);

  // Пустой хэш приводим к «Обзору», чтобы ссылка в шапке и состояние совпадали.
  useEffect(() => {
    if (window.location.hash === '' || window.location.hash === '#') {
      window.location.replace(toHref('overview'));
    }
  }, []);

  return location;
}

export function navigate(screen: ScreenKey, query?: Record<string, string | undefined>): void {
  window.location.hash = toHref(screen, query).replace(/^#/, '');
}
