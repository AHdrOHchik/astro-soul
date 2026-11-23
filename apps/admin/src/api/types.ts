/*
 * Все типы панели выводятся из `api.openapi.yaml` (см. `pnpm --filter
 * @astro-soul/admin run gen:api`). Ни одного поля, которого нет в контракте,
 * здесь появиться не может: тип, придуманный руками, — это и есть «экран,
 * построенный на выдуманном маршруте». Правило репозитория такое: чего нет в
 * `api.openapi.yaml`, то не запрашивается и не рисуется, а выносится отдельным
 * запросом к контракту; за экран на придуманном адресе PR отклоняется.
 *
 * Единственное исключение — `AdminMe` и `TelegramAuthPayload` в конце файла:
 * они помечены как «не в контракте» и существуют только для dev-мокера.
 */

import type { components, paths } from './schema.gen';

type Schemas = components['schemas'];

export type Problem = Schemas['Problem'];
export type Alert = Schemas['Alert'];
export type AlertsResponse = Schemas['AlertsResponse'];
export type AccessCode = Schemas['AccessCode'];
export type GeoPlace = Schemas['GeoPlace'];

/** `GET /api/v1/health` — 200 и 503 имеют одно тело, поэтому разбирать надо оба. */
export type Health = paths['/api/v1/health']['get']['responses'][200]['content']['application/json'];

/** `GET /api/v1/founders/count` — публичный маршрут, два числа без ПДн. */
export type FoundersCount = paths['/api/v1/founders/count']['get']['responses'][200]['content']['application/json'];

export type Metrics = paths['/api/v1/admin/metrics']['get']['responses'][200]['content']['application/json'];

export type CodesList = paths['/api/v1/admin/codes']['get']['responses'][200]['content']['application/json'];
export type CodeCreateBody = paths['/api/v1/admin/codes']['post']['requestBody']['content']['application/json'];

export type GrantsList = paths['/api/v1/admin/grants']['get']['responses'][200]['content']['application/json'];
export type GrantRow = GrantsList['items'][number];
export type GrantsWriteBody = paths['/api/v1/admin/grants']['post']['requestBody']['content']['application/json'];
export type GrantWriteResult = paths['/api/v1/admin/grants']['post']['responses'][200]['content']['application/json'];

export type GrantKind = GrantRow['kind'];
export type GrantSource = GrantRow['source'];

/* ------------------------------------------------------------------------- *
 * НЕ В КОНТРАКТЕ 1.6.14.
 *
 * Формы ниже взяты из ТЗ админки (§3) и нужны, чтобы dev-мокер отвечал в той
 * же конвенции, что и остальные маршруты. Экраны, построенные на них, не
 * выезжают в прод, пока бэкенд не добавит маршруты в `api.openapi.yaml`: гейт
 * в `http.assertCallable` не даёт сделать запрос на неизвестный путь.
 * Как только маршрут появится в контракте — эти два типа удаляются, и их
 * место берут выведенные из `paths`.
 * ------------------------------------------------------------------------- */

export interface AdminMe {
  /**
   * Поля необязательны нарочно: `/admin/me` ещё нет в контракте, и форма ниже
   * — предложение бэкенду, а не факт. Пока маршрут не описан, панель обязана
   * обрабатывать отсутствующее значение, а не считать его гарантированным:
   * нет `csrf_token` — сессия негодна (`auth/session.ts` → `CSRF_MISSING`).
   */
  readonly tg_id?: string | null;
  readonly name?: string | null;
  readonly expires_at?: string | null;
  readonly csrf_token?: string | null;
}

/** То, что виджет возвращает подписанным набором полей; сервер проверяет подпись. */
export type TelegramAuthPayload = Readonly<Record<string, string>>;
