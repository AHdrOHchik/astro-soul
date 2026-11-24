/*
 * Все типы панели выводятся из `api.openapi.yaml` (см. `pnpm --filter
 * @astro-soul/admin run gen:api`). Ни одного поля, которого нет в контракте,
 * здесь появиться не может: тип, придуманный руками, — это и есть «экран,
 * построенный на выдуманном маршруте». Правило репозитория такое: чего нет в
 * `api.openapi.yaml`, то не запрашивается и не рисуется, а выносится отдельным
 * запросом к контракту; за экран на придуманном адресе PR отклоняется.
 *
 * История: формы «Тарифов» и «Пользователей» когда-то жили здесь ручным блоком
 * «НЕ В КОНТРАКТЕ» (их собрали по ответам владельца на запрос к контракту). С
 * 1.6.16–1.6.18 эти маршруты в `paths:`, и блок удалён: поле, придуманное
 * панелью, неотличимо от поля, которого сервер никогда не отдавал, — а теперь
 * такое расхождение невозможно по построению.
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

/** `GET /api/v1/admin/me` — кто вошёл, срок сессии (подсказка) и CSRF-токен. */
export type AdminMe = paths['/api/v1/admin/me']['get']['responses'][200]['content']['application/json'];

/** `POST /api/v1/admin/auth/telegram` — набор полей виджета; `id` сервер
 * принимает строкой или числом, панель отправляет «как дал виджет». */
export type TelegramAuthPayload =
  paths['/api/v1/admin/auth/telegram']['post']['requestBody']['content']['application/json'];

/** `GET /api/v1/admin/audit` — страница журнала; `actor_name` — снимок. */
export type AuditEntry = Schemas['AdminAuditEntry'];
export type AuditPage = paths['/api/v1/admin/audit']['get']['responses'][200]['content']['application/json'];

export type GrantsList = paths['/api/v1/admin/grants']['get']['responses'][200]['content']['application/json'];
export type GrantRow = GrantsList['items'][number];
export type GrantsWriteBody = paths['/api/v1/admin/grants']['post']['requestBody']['content']['application/json'];
export type GrantWriteResult = paths['/api/v1/admin/grants']['post']['responses'][200]['content']['application/json'];

export type GrantKind = GrantRow['kind'];
export type GrantSource = GrantRow['source'];

/* ------------------------------------------------------------------------- *
 * 1.6.16–1.6.18 — «Пользователи», «Тарифы», «Платежи и генерации»,
 * «Основатели и партнёры», «Эксплуатация».
 *
 * Всё ниже выведено из `paths` / `components.schemas`. Обязательные поля
 * (например `comment` и `base_version` у цены, `charge_id` у возврата) —
 * обязанность типа, а не договорённость в комментарии: экран не соберётся,
 * если решит послать «половину» запроса.
 * ------------------------------------------------------------------------- */

/** `GET /admin/users` — параметры поиска. Сервер требует ровно один; см. `UsersSearchParams`. */
type UsersSearchQuery = NonNullable<paths['/api/v1/admin/users']['get']['parameters']['query']>;

/**
 * Ровно один параметр поиска. Имена и типы — из контракта; «один» — правило
 * сервера (`422 invalid_search` на нуле и на двух), и тип собирает его так,
 * чтобы второй параметр нельзя было даже передать.
 */
export type UsersSearchParams =
  | { readonly telegram_id: NonNullable<UsersSearchQuery['telegram_id']>; readonly alias?: never; readonly q?: never }
  | { readonly alias: NonNullable<UsersSearchQuery['alias']>; readonly telegram_id?: never; readonly q?: never }
  | { readonly q: NonNullable<UsersSearchQuery['q']>; readonly telegram_id?: never; readonly alias?: never };

export type AdminUserSummary = Schemas['AdminUserSummary'];
export type AdminUsersPage = paths['/api/v1/admin/users']['get']['responses'][200]['content']['application/json'];

/** `GET /admin/users/{id}` — карточка: ПДн, карта, подписка, гранты, платежи, счётчики. */
export type AdminUserCard = Schemas['AdminUserCard'];
export type AdminPayment = Schemas['AdminPayment'];

/** `POST /admin/users/{id}/refund` — тело: только платёж и основание. Суммы здесь нет. */
export type AdminRefundBody = paths['/api/v1/admin/users/{id}/refund']['post']['requestBody']['content']['application/json'];
export type AdminRefundResult = Schemas['AdminRefundResult'];

/** `POST /admin/users/{id}/ban` — бан и разбан одним маршрутом: `banned` решает. */
export type AdminBanBody = paths['/api/v1/admin/users/{id}/ban']['post']['requestBody']['content']['application/json'];
export type AdminBanResult = Schemas['AdminBanResult'];

/** `POST /admin/users/{id}/push` — тестовая отправка; `sent:false` — пуш выключен. */
export type AdminPushResult = paths['/api/v1/admin/users/{id}/push']['post']['responses'][200]['content']['application/json'];

/** `GET /admin/plans` — каталог. `version` — оптимистичная блокировка цены. */
export type AdminPlan = Schemas['AdminPlan'];
export type AdminPlansResponse = Schemas['AdminPlanPage'];

/** `PATCH /admin/plans/{code}` — `comment` и `base_version` обязательны. */
export type AdminPlanPatchBody = paths['/api/v1/admin/plans/{code}']['patch']['requestBody']['content']['application/json'];
export type AdminPlanPatchResult = paths['/api/v1/admin/plans/{code}']['patch']['responses'][200]['content']['application/json'];
export type PriceChangeScope = Schemas['PriceChangeScope'];

/** История цены: `actor_name` — снимок на момент правки, джойнинг не нужен. */
export type AdminPlanHistoryEntry = Schemas['AdminPlanHistoryEntry'];
export type AdminPlanHistoryResponse = paths['/api/v1/admin/plans/{code}/history']['get']['responses'][200]['content']['application/json'];

/** `GET /admin/reports` — лента разборов; текста разбора в ответе нет намеренно. */
export type AdminReportSummary = Schemas['AdminReportSummary'];
export type ReportsQuery = paths['/api/v1/admin/reports']['get']['parameters']['query'];
export type AdminReportsPage = paths['/api/v1/admin/reports']['get']['responses'][200]['content']['application/json'];

/** `POST /admin/reports/{id}/regenerate` — `202`, очередь, а не «готово». */
export type AdminReportRegenerateResult = paths['/api/v1/admin/reports/{id}/regenerate']['post']['responses'][202]['content']['application/json'];

/** `GET /admin/payments` — лента платежей; `next_cursor` — единственный способ листать. */
export type AdminPaymentEntry = Schemas['AdminPaymentEntry'];
export type AdminPaymentsPage = Schemas['AdminPaymentsPage'];
export type PaymentsQuery = paths['/api/v1/admin/payments']['get']['parameters']['query'];

/** «Основатели»: `AdminFounder` без `username` (1.6.18) — ника в контракте нет. */
export type AdminFounder = Schemas['AdminFounder'];
export type AdminFoundersPage = Schemas['AdminFoundersPage'];
export type FoundersQuery = paths['/api/v1/admin/founders']['get']['parameters']['query'];

/** «Партнёры»: только агрегаты, `revenue_stars` — без учёта возвратов. */
export type AdminPartner = Schemas['AdminPartner'];
export type AdminPartnersPage = Schemas['AdminPartnersPage'];

/** Тело «операций с основанием» (`backup/run`, `telegram/webhook`): `{reason}`. */
export type AdminReasonBody = paths['/api/v1/admin/backup/run']['post']['requestBody']['content']['application/json'];
export type AdminBackupRunResult = paths['/api/v1/admin/backup/run']['post']['responses'][202]['content']['application/json'];
export type AdminWebhookSetResult = paths['/api/v1/admin/telegram/webhook']['post']['responses'][200]['content']['application/json'];
export type AdminAlertAckResult = paths['/api/v1/admin/alerts/{id}/ack']['post']['responses'][200]['content']['application/json'];
