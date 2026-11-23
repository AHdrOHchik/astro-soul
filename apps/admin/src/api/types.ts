/*
 * Все типы панели выводятся из `api.openapi.yaml` (см. `pnpm --filter
 * @astro-soul/admin run gen:api`). Ни одного поля, которого нет в контракте,
 * здесь появиться не может: тип, придуманный руками, — это и есть «экран,
 * построенный на выдуманном маршруте». Правило репозитория такое: чего нет в
 * `api.openapi.yaml`, то не запрашивается и не рисуется, а выносится отдельным
 * запросом к контракту; за экран на придуманном адресе PR отклоняется.
 *
 * Исключения — блоки «НЕ В КОНТРАКТЕ» в конце файла: они помечены как
 * отсутствующие в контракте и существуют только для dev-мокера.
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

/**
 * Формы «Тарифов» и «Пользователей» — тоже «НЕ В КОНТРАКТЕ»: маршрутов
 * `/admin/plans*` и `/admin/users*` в 1.6.14 нет. Формы взяты из ответов
 * владельца на запрос к контракту (`answers/admin-pr1-review.md`) — это и есть
 * причина каждой формы, а не удобная выдумка панели:
 *
 *   • у `AdminPlanPatchBody` обязателен `comment`, а `base_version` нужен для
 *     честного `409 price_changed` — панель не имеет права писать поверх
 *     изменённого значения;
 *   • `AdminRefundBody` НЕ содержит суммы: возврат только полный, сумму
 *     считает сервер (`AdminUserCard.refundable`) и её же возвращает;
 *   • `AdminPlanHistoryRow.actor_name` — снимок имени на момент действия,
 *     поэтому колонка «кто менял» не требует запроса к `users`.
 *
 * В день, когда маршруты появятся в `api.openapi.yaml`, блоки ниже удаляются,
 * а их место берут типы, выведенные из `paths`.
 */

export interface AdminPlanRow {
  readonly code: string;
  readonly title: string;
  /** Цена в звёздах — только со сервера, панель не конвертирует и не пересчитывает. */
  readonly price_stars: number;
  readonly discount_price_stars: number | null;
  readonly is_active: boolean;
  readonly test_only: boolean;
  /** `founder_month`: право проверяется по таблице `founders`, в витрине его нет. */
  readonly founder_only: boolean;
  /** Код из ответа сервера: кого касается новая цена (`only_new_purchases`). */
  readonly price_change_scope: string;
  /** Версия строки: уходит в `base_version`, на расхождении сервер ответит 409. */
  readonly version: number;
  readonly updated_at: string;
  /** Снимок имени из аудита на момент последней правки. */
  readonly updated_by_name: string | null;
  readonly updated_by_tg_id: string | null;
}

export interface AdminPlansResponse {
  readonly items: readonly AdminPlanRow[];
}

export interface AdminPlanPatchBody {
  readonly price_stars: number;
  readonly discount_price_stars: number | null;
  /** Обязателен: без основания цену менять нельзя (ответ владельца, §4). */
  readonly comment: string;
  readonly base_version: number;
}

export interface AdminPlanAuditLine {
  readonly at: string;
  readonly actor_name: string;
  readonly actor_tg_id: string;
  readonly request_id: string | null;
}

export interface AdminPlanPatchResult {
  readonly plan: AdminPlanRow;
  readonly audit: AdminPlanAuditLine;
  readonly price_change_scope: string;
}

export interface AdminPlanHistoryRow {
  readonly at: string;
  readonly actor_tg_id: string;
  readonly actor_name: string;
  readonly from_price: number | null;
  readonly to_price: number;
  readonly comment: string;
}

export interface AdminPlanHistoryResponse {
  readonly items: readonly AdminPlanHistoryRow[];
}

/**
 * Ровно один параметр поиска: union не даёт собрать запрос с двумя, а сервер
 * на двух отвечает 422 — панель предпочитает не создавать этот ответ самим
 * своим типом.
 */
export type UsersSearchParams =
  | { readonly telegram_id: string; readonly alias?: never; readonly q?: never }
  | { readonly alias: string; readonly telegram_id?: never; readonly q?: never }
  | { readonly q: string; readonly telegram_id?: never; readonly alias?: never };

export interface AdminUserRow {
  readonly user_id: string;
  readonly tg_id: string;
  readonly alias: string | null;
  readonly name: string | null;
  readonly plan_code: string | null;
  readonly access_until: string | null;
  readonly banned: boolean;
}

export interface AdminUserSearchResponse {
  readonly items: readonly AdminUserRow[];
}

export interface AdminUserPaymentRow {
  readonly id: string;
  readonly charge_id: string;
  readonly kind: 'payment' | 'refund';
  readonly stars: number;
  readonly at: string;
  readonly refunded: boolean;
}

/** Сумма возврата, посчитанная сервером: панель её только показывает и ни в чём не пересчитывает. */
export interface AdminRefundQuote {
  readonly charge_id: string;
  readonly amount_stars: number;
  readonly currency: string;
}

export interface AdminUserCard {
  readonly user_id: string;
  readonly tg_id: string;
  readonly alias: string | null;
  readonly name: string | null;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  readonly push_enabled: boolean;
  readonly banned_at: string | null;
  readonly ban_reason: string | null;
  readonly subscription: { readonly plan_code: string; readonly until: string; readonly source: string } | null;
  readonly payments: readonly AdminUserPaymentRow[];
  /** `null` — возвращать нечего. Сумма здесь же: ввод «сколько вернуть» на экране запрещён. */
  readonly refundable: AdminRefundQuote | null;
}

export interface AdminRefundResult {
  readonly charge_id: string;
  readonly amount_stars: number;
  readonly currency: string;
  readonly status: string;
}

export interface AdminBanResult {
  readonly user_id: string;
  readonly banned: boolean;
  readonly reason: string;
  readonly at: string;
}

export interface AdminPushResult {
  readonly user_id: string;
  readonly push_enabled: boolean;
}
