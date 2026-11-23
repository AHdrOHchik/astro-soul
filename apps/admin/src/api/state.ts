/*
 * Состояния блока данных. Их четыре, и пятого не будет:
 *
 *   loading     — запрос в полёте;
 *   ok          — данные есть (пустой список — это `ok` с нулём строк, и экран
 *                 пишет «Пусто»: «нет данных» и «данных нет вообще» — разные вещи);
 *   error       — сервер ответил ошибкой (403, 500, сеть, таймаут);
 *   unavailable — маршрута нет в контракте: **не отрисовывать ничего**, в том
 *                 числе нулей и прочерков вместо цифр.
 *
 * `unavailable` — не подвид ошибки. Ошибка лечится повтором, отсутствующий
 * маршрут — только релизом бэкенда, и админ должен видеть разницу.
 */

import type { ApiError } from './errors';
import { ADMIN_ROUTES, type AdminRoute } from './routes';

export type Resource<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: T; readonly demo: boolean; readonly requestId: string | null }
  | { readonly kind: 'error'; readonly error: ApiError }
  | { readonly kind: 'unavailable'; readonly routes: readonly AdminRoute[] };

export function loading<T>(): Resource<T> {
  return { kind: 'loading' };
}

export function ok<T>(data: T, demo = false, requestId: string | null = null): Resource<T> {
  return { kind: 'ok', data, demo, requestId };
}

export function failed<T>(error: ApiError): Resource<T> {
  return { kind: 'error', error };
}

/** Блок, для которого в контракте нет ни одного маршрута. */
export function unavailable<T>(...keys: readonly string[]): Resource<T> {
  return { kind: 'unavailable', routes: keys.map((key) => ADMIN_ROUTES.find((item) => item.key === key)).filter((item): item is AdminRoute => item !== undefined) };
}

export function isOk<T>(state: Resource<T>): state is { kind: 'ok'; data: T; demo: boolean; requestId: string | null } {
  return state.kind === 'ok';
}

export function isLoading<T>(state: Resource<T>): boolean {
  return state.kind === 'loading';
}

export function isEmptyList<T>(state: Resource<readonly T[]>): boolean {
  return isOk(state) && state.data.length === 0;
}
