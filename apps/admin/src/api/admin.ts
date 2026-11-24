/*
 * Именованные вызовы `/admin/*`. Панель не умеет строить URL из строки и не
 * умеет слать «универсальный запрос»: только этот список функций, и каждая
 * соответствует маршруту из реестра (src/api/routes.ts).
 *
 * Ответы возвращаются «как есть»: ничего не досчитывается на клиенте. Нужна
 * сумма возврата — её отдаёт сервер; нужна цена — она из `GET /admin/plans`,
 * которого в этом контракте нет, и экран говорит об этом прямо.
 *
 * `demo` в каждом результате — признак того, что ответ пришёл от dev-мокера
 * (заголовок `X-Admin-Demo`). На нём держится баннер «ДЕМО»: панель не может
 * показать выдуманные числа, не сказав об этом.
 */

import type { Http, HttpResult, ProbeResult } from './http';
import type {
  AccessCode,
  AdminAlertAckResult,
  AdminBanBody,
  AdminBanResult,
  AuditPage,
  AdminBackupRunResult,
  AdminMe,
  AdminPlanHistoryResponse,
  AdminPlanPatchBody,
  AdminPlanPatchResult,
  AdminPlansResponse,
  AdminPushResult,
  AdminFoundersPage,
  AdminPartnersPage,
  AdminPaymentsPage,
  AdminReasonBody,
  AdminRefundBody,
  AdminRefundResult,
  AdminReportRegenerateResult,
  AdminReportsPage,
  AdminUserCard,
  AdminUsersPage,
  AdminWebhookSetResult,
  AlertsResponse,
  FoundersQuery,
  PaymentsQuery,
  ReportsQuery,
  CodeCreateBody,
  FoundersCount,
  GrantKind,
  GrantRow,
  GrantsWriteBody,
  GrantWriteResult,
  Health,
  Metrics,
  TelegramAuthPayload,
  UsersSearchParams,
} from './types';

export const GRANT_KINDS: readonly GrantKind[] = ['all_access', 'single_report', 'single_compat'];

/** Потолок пакета: «создать 5000 кодов» — это не работа поддержки, а рассылка. */
export const CODE_BATCH_MAX = 50;

/** Фильтр журнала; `cursor` — непрозрачное значение из `next_cursor`. */
export interface AuditQuery {
  readonly entity?: string | null;
  readonly entity_id?: string | null;
  readonly action?: string | null;
  readonly actor_tg_id?: string | null;
  /** Сервер принимает 1..200; панель не зажимает молча: чужой `422` честнее. */
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export interface AdminApi {
  /** Публичный: работает и без сессии — на нём стоит первый экран. */
  health(signal?: AbortSignal): Promise<HttpResult<Health>>;
  foundersCount(signal?: AbortSignal): Promise<HttpResult<FoundersCount>>;
  alerts(signal?: AbortSignal): Promise<HttpResult<AlertsResponse>>;
  metrics(signal?: AbortSignal): Promise<HttpResult<Metrics>>;
  codes(signal?: AbortSignal): Promise<HttpResult<readonly AccessCode[]>>;
  createCode(body: CodeCreateBody): Promise<HttpResult<AccessCode>>;
  grants(userId: string, signal?: AbortSignal): Promise<HttpResult<readonly GrantRow[]>>;
  grantWrite(body: GrantsWriteBody): Promise<HttpResult<GrantWriteResult>>;
  /** «Тарифы»: каталог с ценой, версией строки и историей правок (1.6.16). */
  plans(signal?: AbortSignal): Promise<HttpResult<AdminPlansResponse>>;
  /**
   * Цена и флаг «только для теста». `comment` и `base_version` обязательны по
   * контракту; снятие `test_only` требует `confirm: 'disable_test_plan'`.
   */
  plansPatch(code: string, body: AdminPlanPatchBody): Promise<HttpResult<AdminPlanPatchResult>>;
  plansHistory(code: string, signal?: AbortSignal): Promise<HttpResult<AdminPlanHistoryResponse>>;
  /** «Пользователи»: поиск ровно одним параметром, карточка, действия с основанием. */
  usersSearch(params: UsersSearchParams, signal?: AbortSignal): Promise<HttpResult<AdminUsersPage>>;
  userCard(id: string, signal?: AbortSignal): Promise<HttpResult<AdminUserCard>>;
  /** Возврат только полный: тело — `{charge_id, reason}`, суммы в запросе нет. */
  userRefund(id: string, body: AdminRefundBody): Promise<HttpResult<AdminRefundResult>>;
  /** Бан и разбан одним маршрутом: `banned` решает, `reason` — основание в аудит. */
  userBan(id: string, body: AdminBanBody): Promise<HttpResult<AdminBanResult>>;
  /** Тестовая отправка утреннего пуша: тела у запроса нет, ответ — `sent`. */
  userPush(id: string): Promise<HttpResult<AdminPushResult>>;
  /** «Платежи и генерации»: лента платежей по курсору и лента разборов. */
  payments(query?: PaymentsQuery, signal?: AbortSignal): Promise<HttpResult<AdminPaymentsPage>>;
  reports(query?: ReportsQuery, signal?: AbortSignal): Promise<HttpResult<AdminReportsPage>>;
  /** `202` — разбор снова в очереди; «готово» экран не обещает. */
  reportRegenerate(id: string): Promise<HttpResult<AdminReportRegenerateResult>>;
  /** «Основатели и партнёры»: места 1…50 и агрегаты по партнёрам. */
  founders(query?: FoundersQuery, signal?: AbortSignal): Promise<HttpResult<AdminFoundersPage>>;
  partners(signal?: AbortSignal): Promise<HttpResult<AdminPartnersPage>>;
  /** «Эксплуатация»: дамп, переустановка вебхука, подтверждение алерта. */
  backupRun(body: AdminReasonBody): Promise<HttpResult<AdminBackupRunResult>>;
  webhookSet(body: AdminReasonBody): Promise<HttpResult<AdminWebhookSetResult>>;
  alertAck(id: string, body: { minutes: number }): Promise<HttpResult<AdminAlertAckResult>>;
  /** Вход: `probe`, потому что маршрута нет в контракте и 404 — это ответ, а не авария. */
  me(): Promise<ProbeResult<AdminMe>>;
  login(payload: TelegramAuthPayload): Promise<HttpResult<unknown>>;
  logout(): Promise<HttpResult<unknown>>;
  /** Журнал действий: курсорная страница `{items, next_cursor}`. */
  audit(params?: AuditQuery, signal?: AbortSignal): Promise<HttpResult<AuditPage>>;
}

export function createAdminApi(http: Http): AdminApi {
  return {
    // 503 — тоже ответ с тем же телом: без БД мониторинг обязан остаться
    // читаемым, поэтому статус не превращаем в исключение.
    health: (signal) => http.call<Health>('health', { signal, treatAsOk: [503], retry: false }),
    foundersCount: (signal) => http.call<FoundersCount>('foundersCount', { signal }),
    alerts: (signal) => http.call<AlertsResponse>('alerts', { signal }),
    metrics: (signal) => http.call<Metrics>('metrics', { signal }),

    codes: async (signal) => {
      const result = await http.call<{ items?: readonly AccessCode[] }>('codesList', { signal });
      return { ...result, data: result.data.items ?? [] };
    },

    createCode: (body) => http.call<AccessCode>('codesCreate', { body }),

    grants: async (userId, signal) => {
      const result = await http.call<{ items?: readonly GrantRow[] }>('grantsList', { query: { user_id: userId }, signal });
      return { ...result, data: result.data.items ?? [] };
    },

    grantWrite: (body) => http.call<GrantWriteResult>('grantsWrite', { body }),

    plans: (signal) => http.call<AdminPlansResponse>('plansList', { signal }),

    plansPatch: (code, body) => http.call<AdminPlanPatchResult>('plansPatch', { params: { code }, body: { ...body } }),

    plansHistory: (code, signal) => http.call<AdminPlanHistoryResponse>('plansAudit', { params: { code }, signal }),

    usersSearch: (params, signal) => http.call<AdminUsersPage>('usersSearch', { query: { ...params }, signal }),

    userCard: (id, signal) => http.call<AdminUserCard>('userCard', { params: { id }, signal }),

    userRefund: (id, body) => http.call<AdminRefundResult>('userRefund', { params: { id }, body: { ...body } }),

    userBan: (id, body) => http.call<AdminBanResult>('userBan', { params: { id }, body: { ...body } }),

    // Тела нет: `POST /admin/users/{id}/push` — это «отправь тестовый пуш», а
    // не «включи/выключи пуши»: флагом управляет человек в мини-аппе.
    userPush: (id) => http.call<AdminPushResult>('userPush', { params: { id } }),

    payments: (query, signal) => http.call<AdminPaymentsPage>('paymentsList', { query: { ...query }, signal }),

    reports: (query, signal) => http.call<AdminReportsPage>('reportsList', { query: { ...query }, signal }),

    reportRegenerate: (id) => http.call<AdminReportRegenerateResult>('reportRegenerate', { params: { id }, body: {} }),

    founders: (query, signal) => http.call<AdminFoundersPage>('foundersList', { query: { ...query }, signal }),

    partners: (signal) => http.call<AdminPartnersPage>('partnersStats', { signal }),

    backupRun: (body) => http.call<AdminBackupRunResult>('backupNow', { body: { ...body } }),

    webhookSet: (body) => http.call<AdminWebhookSetResult>('webhookSet', { body: { ...body } }),

    alertAck: (id, body) => http.call<AdminAlertAckResult>('alertsAck', { params: { id }, body: { ...body } }),

    me: () => http.probe<AdminMe>('authMe'),

    login: (payload) => http.call<unknown>('authTelegram', { body: { ...payload } }),

    logout: () => http.call<unknown>('authLogout', { body: {} }),

    audit: (params, signal) => http.call<AuditPage>('auditList', { query: { ...params }, signal }),
  };
}

export interface BatchInput {
  readonly count: number;
  readonly kind: GrantKind;
  readonly days: number | null;
  readonly maxActivations: number;
  readonly partnerName: string | null;
  readonly expiresAt: string | null;
}

export interface BatchResult {
  readonly created: readonly AccessCode[];
  /** Сколько запросов успело уйти до остановки; `null` — дошли до конца. */
  readonly stoppedAfter: number | null;
  /** `null` — дошли до конца; иначе — причина остановки (её показывает экран). */
  readonly error: unknown;
  readonly requested: number;
}

function toCodeBody(input: BatchInput): CodeCreateBody {
  const body: Record<string, unknown> = {
    kind: input.kind,
    max_activations: input.maxActivations,
  };
  // `days` обязателен для all_access и не нужен для одноразовых: не присылаем null
  // туда, где сервер ждёт отсутствие поля.
  if (input.days !== null) body.days = input.days;
  if (input.partnerName !== null) body.partner_name = input.partnerName;
  if (input.expiresAt !== null) body.expires_at = input.expiresAt;
  return body as unknown as CodeCreateBody;
}

/**
 * Создать пакет кодов. Один запрос = один код (так устроено `POST /admin/codes`),
 * поэтому «пакет из N» — это N последовательных вызовов без повторов: POST не
 * идемпотентен, и повтор на 500 создал бы ещё один код.
 *
 * Прерывание не откатывает созданные строки — сервер про них уже знает. Поэтому
 * возвращаются и созданные коды, и причина остановки: иначе админ решит, что
 * «ничего не создалось», и повторит пакет целиком.
 */
export async function createCodeBatch(
  api: Pick<AdminApi, 'createCode'>,
  input: BatchInput,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  const requested = Math.max(1, Math.min(Math.trunc(input.count) || 1, CODE_BATCH_MAX));
  const body = toCodeBody(input);
  const created: AccessCode[] = [];

  for (let index = 0; index < requested; index += 1) {
    try {
      const result = await api.createCode(body);
      created.push(result.data);
    } catch (error) {
      onProgress?.(index + 1, requested);
      return { created, stoppedAfter: created.length, error, requested };
    }
    onProgress?.(index + 1, requested);
  }

  return { created, stoppedAfter: null, error: null, requested };
}
