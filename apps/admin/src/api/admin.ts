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
  AdminBanResult,
  AdminMe,
  AdminPlanHistoryResponse,
  AdminPlanPatchBody,
  AdminPlanPatchResult,
  AdminPlansResponse,
  AdminPushResult,
  AdminRefundResult,
  AdminUserCard,
  AdminUserSearchResponse,
  AlertsResponse,
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
  /** «Тарифы»: каталог с ценой и историей правок. Маршрутов нет в контракте — в проде блок «недоступно». */
  plans(signal?: AbortSignal): Promise<HttpResult<AdminPlansResponse>>;
  plansPatch(code: string, body: AdminPlanPatchBody): Promise<HttpResult<AdminPlanPatchResult>>;
  plansHistory(code: string, signal?: AbortSignal): Promise<HttpResult<AdminPlanHistoryResponse>>;
  /** «Пользователи»: поиск ровно одним параметром, карточка, действия с основанием. */
  usersSearch(params: UsersSearchParams, signal?: AbortSignal): Promise<HttpResult<AdminUserSearchResponse>>;
  userCard(id: string, signal?: AbortSignal): Promise<HttpResult<AdminUserCard>>;
  /** Возврат звёзд — только полный: тела запроса без суммы нет, сумму вернёт сервер. */
  userRefund(id: string, body: { reason: string }): Promise<HttpResult<AdminRefundResult>>;
  userBan(id: string, body: { reason: string }): Promise<HttpResult<AdminBanResult>>;
  userPush(id: string, body: { enabled: boolean }): Promise<HttpResult<AdminPushResult>>;
  /** Вход: `probe`, потому что маршрута нет в контракте и 404 — это ответ, а не авария. */
  me(): Promise<ProbeResult<AdminMe>>;
  login(payload: TelegramAuthPayload): Promise<HttpResult<unknown>>;
  logout(): Promise<HttpResult<unknown>>;
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

    usersSearch: (params, signal) => http.call<AdminUserSearchResponse>('usersSearch', { query: { ...params }, signal }),

    userCard: (id, signal) => http.call<AdminUserCard>('userCard', { params: { id }, signal }),

    userRefund: (id, body) => http.call<AdminRefundResult>('userRefund', { params: { id }, body: { ...body } }),

    userBan: (id, body) => http.call<AdminBanResult>('userBan', { params: { id }, body: { ...body } }),

    userPush: (id, body) => http.call<AdminPushResult>('userPush', { params: { id }, body: { ...body } }),

    me: () => http.probe<AdminMe>('authMe'),

    login: (payload) => http.call<unknown>('authTelegram', { body: { ...payload } }),

    logout: () => http.call<unknown>('authLogout', { body: {} }),
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
