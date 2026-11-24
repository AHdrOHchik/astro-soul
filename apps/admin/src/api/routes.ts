/*
 * Реестр маршрутов, которыми пользуется панель, и честный ответ на вопрос
 * «а он есть в контракте».
 *
 * Почему это отдельный модуль с тестом, а не строчки в компонентах: правило
 * «нет маршрута — экран не работает, а не работает частично» должно
 * проверяться машиной. Тест `routes.contract.test.ts` сверяет `inContract`
 * со списком `paths` в `api.openapi.yaml`, поэтому:
 *
 *   • маршрут появился в контракте, а флаг не переключили → тест падает и
 *     говорит, что экран пора включать (панель не «полурабочая»);
 *   • флаг включили раньше, чем маршрут появился → тест падает сразу, и ни
 *     один экран не начинает дергать несуществующий адрес.
 *
 * Вызывать маршрут с `inContract: false` нельзя: `http.request` это и блокирует
 * (см. `assertCallable`).
 */

import { API_PREFIX } from '../env';

/** Разделы панели — ровно восемь из ТЗ, плюс вход. */
export type ScreenKey =
  | 'login'
  | 'overview'
  | 'users'
  | 'payments'
  | 'plans'
  | 'codes'
  | 'founders'
  | 'ops'
  | 'audit';

export type RouteMethod = 'GET' | 'POST' | 'PATCH';

export interface AdminRoute {
  readonly key: string;
  readonly method: RouteMethod;
  /** Шаблон пути как в контракте, включая `{id}`; префикс `/api/v1` — общий. */
  readonly path: string;
  /** Есть ли маршрут в `api.openapi.yaml`. Проверяется тестом, не на глаз. */
  readonly inContract: boolean;
  /** Нужна ли сессия админа (публичные маршруты работают и без входа). */
  readonly needsSession: boolean;
  /** Зачем нужен — это текст на экране-заглушке и пункт в отчёте для бэкенда. */
  readonly why: string;
  readonly screens: readonly ScreenKey[];
}

/** Публичные маршруты: доступны из браузера без сессии — на них и стоит всё строить первым. */
const PUBLIC: readonly AdminRoute[] = [
  {
    key: 'health',
    method: 'GET',
    path: `${API_PREFIX}/health`,
    inContract: true,
    needsSession: false,
    why: 'Живость, флаги и состояние планировщика пуша.',
    screens: ['overview', 'ops'],
  },
  {
    key: 'foundersCount',
    method: 'GET',
    path: `${API_PREFIX}/founders/count`,
    inContract: true,
    needsSession: false,
    why: 'Сколько мест «первых 50» занято.',
    screens: ['founders'],
  },
];

/** Вход: пришёл в 1.6.15 (`round40-backend`). Флаги сверяет тест-страж. */
const AUTH: readonly AdminRoute[] = [
  {
    key: 'authTelegram',
    method: 'POST',
    path: `${API_PREFIX}/admin/auth/telegram`,
    inContract: true,
    needsSession: false,
    why: 'Проверить подпись Telegram Login Widget, сверить id с ADMIN_TG_ID и поставить cookie-сессию.',
    screens: ['login'],
  },
  {
    key: 'authMe',
    method: 'GET',
    path: `${API_PREFIX}/admin/me`,
    inContract: true,
    needsSession: true,
    why: 'Кто вошёл и когда сессия истекает; он же отдаёт CSRF-токен.',
    screens: ['login', 'overview'],
  },
  {
    key: 'authLogout',
    method: 'POST',
    path: `${API_PREFIX}/admin/auth/logout`,
    inContract: true,
    needsSession: true,
    why: 'Гасить сессию кнопкой в шапке, а не «закрыть вкладку».',
    screens: ['overview'],
  },
];

const OVERVIEW: readonly AdminRoute[] = [
  {
    key: 'metrics',
    method: 'GET',
    path: `${API_PREFIX}/admin/metrics`,
    inContract: true,
    needsSession: true,
    why: 'Воронка, конверсия, звёзды, траты LLM, пуши, гранты.',
    screens: ['overview', 'plans'],
  },
  {
    key: 'alerts',
    method: 'GET',
    path: `${API_PREFIX}/admin/alerts`,
    inContract: true,
    needsSession: true,
    why: 'Неподтверждённые алерты со списка `since`.',
    screens: ['overview', 'ops'],
  },
];

const USERS: readonly AdminRoute[] = [
  {
    key: 'usersSearch',
    method: 'GET',
    path: `${API_PREFIX}/admin/users`,
    inContract: true,
    needsSession: true,
    why: 'Поиск человека — ровно одним параметром: `?telegram_id=`, `?alias=` или `?q=`. Без него карточку открыть нечем; два сразу сервер не принимает.',
    screens: ['users'],
  },
  {
    key: 'userCard',
    method: 'GET',
    path: `${API_PREFIX}/admin/users/{id}`,
    inContract: true,
    needsSession: true,
    why: 'Карточка: карта, подписка, платежи, гранты, push_enabled, last_seen_at.',
    screens: ['users'],
  },
  {
    key: 'userRefund',
    method: 'POST',
    path: `${API_PREFIX}/admin/users/{id}/refund`,
    inContract: true,
    needsSession: true,
    why: 'Возврат по выбранному `charge_id` (только `charge_id` + `reason`); сумму считает сервер и возвращает её же.',
    screens: ['users'],
  },
  {
    key: 'userBan',
    method: 'POST',
    path: `${API_PREFIX}/admin/users/{id}/ban`,
    inContract: true,
    needsSession: true,
    why: 'Бан и разбан одним маршрутом: `ban` с `banned: true|false` и основанием в аудит. Отдельного `unban` в контракте нет.',
    screens: ['users'],
  },
  {
    key: 'userPush',
    method: 'POST',
    path: `${API_PREFIX}/admin/users/{id}/push`,
    inContract: true,
    needsSession: true,
    why: 'Тестовая отправка утреннего пуша: `200 {sent, sent_at, kind}`; выключенный пуш — `409 push_disabled`.',
    screens: ['users'],
  },
];

const PAYMENTS: readonly AdminRoute[] = [
  {
    key: 'reportsList',
    method: 'GET',
    path: `${API_PREFIX}/admin/reports`,
    inContract: true,
    needsSession: true,
    why: 'Лента разборов с фильтрами `status`/`kind`/`user_id`; текста разбора в ответе нет намеренно.',
    screens: ['payments', 'overview'],
  },
  {
    key: 'reportRegenerate',
    method: 'POST',
    path: `${API_PREFIX}/admin/reports/{id}/regenerate`,
    inContract: true,
    needsSession: true,
    why: 'Перегенерация упавшего разбора: `202 {report_id, state, attempts}`; тела запроса у маршрута нет.',
    screens: ['payments'],
  },
  {
    key: 'paymentsList',
    method: 'GET',
    path: `${API_PREFIX}/admin/payments`,
    inContract: true,
    needsSession: true,
    why: 'Список платежей и возвратов для экрана «Платежи и генерации»; поиск по `charge_id` — главный сценарий поддержки.',
    screens: ['payments'],
  },
];

const PLANS: readonly AdminRoute[] = [
  {
    key: 'plansList',
    method: 'GET',
    path: `${API_PREFIX}/admin/plans`,
    inContract: true,
    needsSession: true,
    why: 'Каталог тарифов: `price_stars`, `test_only`, `active`, `founder_only`, `version`, `updated_at`.',
    screens: ['plans'],
  },
  {
    key: 'plansPatch',
    method: 'PATCH',
    path: `${API_PREFIX}/admin/plans/{code}`,
    inContract: true,
    needsSession: true,
    why: 'Цена и `test_only` — с `comment`, `base_version` и `confirm` при снятии тестового флага; `is_active` не правится.',
    screens: ['plans'],
  },
  {
    key: 'plansAudit',
    method: 'GET',
    path: `${API_PREFIX}/admin/plans/{code}/history`,
    inContract: true,
    needsSession: true,
    why: 'Кто и когда менял цену в прошлый раз — без этого подтверждение изменения цены неполное.',
    screens: ['plans'],
  },
];

const CODES: readonly AdminRoute[] = [
  {
    key: 'codesList',
    method: 'GET',
    path: `${API_PREFIX}/admin/codes`,
    inContract: true,
    needsSession: true,
    why: 'Последние коды с остатком активаций.',
    screens: ['codes'],
  },
  {
    key: 'codesCreate',
    method: 'POST',
    path: `${API_PREFIX}/admin/codes`,
    inContract: true,
    needsSession: true,
    why: 'Создать код (или пакет кодов) для партнёра.',
    screens: ['codes'],
  },
  {
    key: 'grantsList',
    method: 'GET',
    path: `${API_PREFIX}/admin/grants`,
    inContract: true,
    needsSession: true,
    why: 'История прав человека, включая отозванные (`?user_id=` — без него сервер отвечает 422).',
    screens: ['codes', 'users'],
  },
  {
    key: 'grantsWrite',
    method: 'POST',
    path: `${API_PREFIX}/admin/grants`,
    inContract: true,
    needsSession: true,
    why: 'Выдать право вручную и отозвать его (`action: "revoke"`).',
    screens: ['codes', 'users'],
  },
];

const FOUNDERS: readonly AdminRoute[] = [
  {
    key: 'foundersList',
    method: 'GET',
    path: `${API_PREFIX}/admin/founders`,
    inContract: true,
    needsSession: true,
    why: 'Кто занял места «первых 50», когда и что ему выдано.',
    screens: ['founders'],
  },
  {
    key: 'partnersStats',
    method: 'GET',
    path: `${API_PREFIX}/admin/partners`,
    inContract: true,
    needsSession: true,
    why: 'Партнёр → активации, оплаты, конверсия. Без этого экрана непонятно, какой партнёр работает.',
    screens: ['founders'],
  },
];

const OPS: readonly AdminRoute[] = [
  {
    key: 'backupNow',
    method: 'POST',
    path: `${API_PREFIX}/admin/backup/run`,
    inContract: true,
    needsSession: true,
    why: 'Кнопка «сделать бэкап сейчас»: тот же scripts/db-dump.sh, что у cron; 202 — запущено, 409 — уже идёт или был меньше 10 минут назад.',
    screens: ['ops'],
  },
  {
    key: 'webhookSet',
    method: 'POST',
    path: `${API_PREFIX}/admin/telegram/webhook`,
    inContract: true,
    needsSession: true,
    why: 'Переустановить вебхук после смены адреса или секрета.',
    screens: ['ops'],
  },
  {
    key: 'alertsAck',
    method: 'POST',
    path: `${API_PREFIX}/admin/alerts/{id}/ack`,
    inContract: true,
    needsSession: true,
    why: 'Подтвердить алерт и заглушить его на час.',
    screens: ['ops', 'overview'],
  },
];

/**
 * Чего панель ждёт, а контракта на это нет (1.6.18; в 1.6.19 не изменилось).
 * Это не «маршруты, которые
 * мы вызываем», а перечень того, чего на экранах сознательно нет: у экрана нет
 * кнопки, которая вела бы в никуда, и нет цифры, посчитанной на клиенте.
 *
 * Флаг `inContract: false` здесь — не «когда-нибудь включим», а запись в
 * отчёт бэкенду: эти четыре адреса в `api.openapi.yaml` отсутствуют, и запрос к
 * ним панель не делает (гейт `assertCallable` её бы и не пустил).
 */
const GAPS: readonly AdminRoute[] = [
  {
    key: 'paymentDetail',
    method: 'GET',
    path: `${API_PREFIX}/admin/payments/{id}`,
    inContract: false,
    needsSession: true,
    why: 'Открыть один платёж по `charge_id`. Маршрута нет — на экране «Платежи» нет и ссылки «к карте платежа», только фильтр ленты.',
    screens: ['payments'],
  },
  {
    key: 'paymentsExport',
    method: 'GET',
    path: `${API_PREFIX}/admin/payments/export.csv`,
    inContract: false,
    needsSession: true,
    why: 'Выгрузка ленты в CSV. Экранировать запятые на клиенте панель не будет: цифры разъедутся, и это будут уже не серверные данные.',
    screens: ['payments'],
  },
  {
    key: 'plansCreate',
    method: 'POST',
    path: `${API_PREFIX}/admin/plans`,
    inContract: false,
    needsSession: true,
    why: 'Создать тариф. Контракт разрешает панели только `PATCH` цены и `test_only`; завести тариф — работа миграции, не кнопки.',
    screens: ['plans'],
  },
  {
    key: 'usersBulk',
    method: 'POST',
    path: `${API_PREFIX}/admin/users/bulk`,
    inContract: false,
    needsSession: true,
    why: 'Массовые действия (забанить/вернуть всем сразу). Их нет намеренно: каждое действие с деньгами обязано быть одиночным и записанным в аудит.',
    screens: ['users'],
  },
];

const AUDIT: readonly AdminRoute[] = [
  {
    key: 'auditList',
    method: 'GET',
    path: `${API_PREFIX}/admin/audit`,
    inContract: true,
    needsSession: true,
    why: 'Журнал действий админа: кто, когда, что менял, было → стало, причина.',
    screens: ['audit', 'plans'],
  },
];

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  ...PUBLIC,
  ...AUTH,
  ...OVERVIEW,
  ...USERS,
  ...PAYMENTS,
  ...CODES,
  ...PLANS,
  ...FOUNDERS,
  ...OPS,
  ...AUDIT,
  // В конце: то, чего в контракте нет. Ни один экран эти маршруты не зовёт.
  ...GAPS,
];

const BY_KEY = new Map(ADMIN_ROUTES.map((route) => [route.key, route]));

export function route(key: string): AdminRoute {
  const found = BY_KEY.get(key);
  if (!found) throw new Error(`Неизвестный маршрут админки: ${key}`);
  return found;
}

export function routesBy(keys: readonly string[]): readonly AdminRoute[] {
  return keys.map((key) => route(key));
}

/** Маршруты, которых нет в контракте, но которые нужны экрану. */
export function missingRoutesFor(screen: ScreenKey): readonly AdminRoute[] {
  return ADMIN_ROUTES.filter((item) => !item.inContract && item.screens.includes(screen));
}

/** Человекочитаемое имя маршрута: `GET /api/v1/admin/plans`. */
export function routeLabel(item: AdminRoute): string {
  return `${item.method} ${item.path}`;
}

/**
 * Чем экран заполняется: `ok` — есть чем, `await` — в контракте только публичные
 * маршруты, которых для работы экрана не хватает. Список открытым: новый экран
 * добавляется сюда вместе с его маршрутами, а не «когда-нибудь».
 */
export type ScreenReadiness = 'ready' | 'waiting-for-routes';

export const SCREEN_READINESS: Record<ScreenKey, ScreenReadiness> = {
  login: 'ready',
  overview: 'ready',
  // 1.6.16–1.6.18: маршруты этих разделов приехали в `paths:`, поэтому
  // «ждём серверные маршруты» на них — неправда, и флаг поднят. Готовность
  // экрана ≠ полнота контракта: `GAPS` ниже (карточка платежа, CSV, создание
  // тарифа, массовые действия) по-прежнему не сделана, и каждый экран называет
  // её текстом «маршрута нет», а не кнопкой в никуда.
  users: 'ready',
  payments: 'ready',
  plans: 'ready',
  codes: 'ready',
  // 1.6.17: все маршруты §5 пришли — «нет маршрутов» в меню больше не правда.
  // Сами экраны появятся в PR панели; до этого они показывают заглушку.
  founders: 'ready',
  ops: 'ready',
  audit: 'ready',
};
