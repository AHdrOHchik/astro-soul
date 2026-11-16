# Платежи Telegram Stars и подписка

Читают BACKEND и QA; FRONTEND — раздел 6 (что он получает).

## 1. Валюта и цены

Только `XTR` (Stars). Карточные платежи для цифровых товаров запрещены правилами Telegram — не реализуем даже как «эксперимент».

| plan_code | Тип | ⭐ | Период | Что даёт |
|---|---|---|---|---|
| `one_149` | разовый | 149 | — | полный разбор, навсегда для этой карты |
| `week_149` | подписка | 149 | 604800 сек (7 дней) | всё, что в `month_399` |
| `month_399` | подписка | 399 | 2592000 сек (30 дней) | полные прогнозы, 5 вопросов/день, совместимость 1/мес |
| `year_2990` | подписка | 2990 | 31536000 сек (365 дней) | то же + карта года включена |
| `compat_249` | разовый | 249 | — | совместимость с партнёром |
| `solar_590` | разовый | 590 | — | карта года |

Цены хранятся **в одном** месте: `packages/shared/src/plans.ts` (и зеркалятся в БД `plans`). Хардкод цен в обработчиках — ошибка ревью.

### 1.1 Тестовые тарифы за 1 ⭐ (`test_1`, `test_report_1`)

Владельцу нужен настоящий путь оплаты в клиенте Telegram — `openInvoice`,
окно звёзд, `successful_payment`, доступ — но 149–399 ⭐ для проверки дорого.
Денежных путей два, и они устроены по-разному, поэтому тестовых тарифов тоже
два, а флаг — один:

| plan_code | Что это | ⭐ | Период | Права |
|---|---|---|---|---|
| `test_1` | подписка | 1 | 604800 сек (неделя) | как `month_399` |
| `test_report_1` | разовый разбор | 1 | — (без `subscription_period`) | как `one_149`, на одну карту |

Оба помечены `testOnly: true` и **не существуют в проде ни при каком
забытом флаге**:

| Что | Как |
|---|---|
| Флаг | `PAYMENTS_TEST_PLANS=1` в окружении API. По умолчанию выключен. Второго флага нет: два выключателя — это один забытый |
| Флаг выключен | `POST /billing/invoice` с `test_1` или `test_report_1` → `422 VALIDATION_FAILED`, тот же ответ, что на несуществующий план |
| Флаг включён | обычный инвойс: 1 ⭐; у подписки — недельный период, у разбора периода нет |
| Каталог | обоих нет ни в `PLAN_CODES`, ни в `PLANS_ORDERED`, ни в контракте (`PlanCode`). Пейволл о них не знает |
| Права | `test_1` — ровно `month_399` (`SubscriptionState.plan` = `month`); `test_report_1` — `entitlements (kind = 'report')` на карту из `payload.chartId`, как у `one_149` |
| Учёт | `payments.is_test = true`; `/admin/metrics` считает такие платежи отдельно (`test_payments_30d`) и не включает в `stars_received_30d`, `paying`, `conversion_to_paid`, отказы и «зависшие» |
| Сумма | проверка `successful_payment` не ослаблена: 2 ⭐ за любой тестовый тариф → `amount_mismatch`, доступа нет |
| Прод | `./check.sh --prod` падает с кодом 1, если `PAYMENTS_TEST_PLANS=1` |

Почему неделя, а не месяц у тестовой подписки: забытая подписка спишется
через неделю за 1 ⭐, а не через месяц за 399.

Почему у `test_report_1` нет `subscription_period`: с периодом Telegram сделал
бы из разового товара подписку — это был бы третий вид тестового платежа
вместо второго, и проверял бы он не тот путь.

| Что | Как |
|---|---|
| Флаг | `PAYMENTS_TEST_PLANS=1` в окружении API. По умолчанию выключен |
| Флаг выключен | `POST /billing/invoice {plan_code: "test_1"}` → `422 VALIDATION_FAILED`, тот же ответ, что на несуществующий план |
| Флаг включён | обычный инвойс: 1 ⭐, недельный период |
| Каталог | `test_1` нет ни в `PLAN_CODES`, ни в `PLANS_ORDERED`, ни в контракте (`PlanCode`). Пейволл о нём не знает |
| Права | ровно `month_399`; `SubscriptionState.plan` = `month` (enum контракта не менялся) |
| Учёт | `payments.is_test = true`; `stars_paid_total` у самого владельца вырастет на 1 ⭐, но `/admin/metrics` считает тестовые платежи отдельно (`test_payments_30d`) и не включает их в `stars_received_30d`, `paying`, `conversion_to_paid`, отказы и «зависшие» |
| Сумма | проверка `successful_payment` не ослаблена: 2 ⭐ за `test_1` → `amount_mismatch`, доступа нет |
| Прод | `./check.sh --prod` падает с кодом 1, если `PAYMENTS_TEST_PLANS=1` |

Почему неделя, а не месяц: забытая тестовая подписка спишется через неделю за
1 ⭐, а не через месяц за 399, и разбираться с этим проще.

Строки обоих тарифов в таблице `plans` есть (сид, `test_only = true`,
`is_active = false`), потому что на `plans.code` ссылаются `invoices` и
`payments`. В выдачу для клиента они не попадают: каталог собирает код, а не
запрос к таблице.

Как включить и как не забыть выключить — `docs/DOCKER.md` §«Тестовые тарифы за
1 ⭐». Строки тестовых тарифов кладёт `pnpm db:seed`: без сида `POST
/billing/invoice` упадёт на FK `invoices.plan_code → plans.code`, поэтому на
стенде после `db:migrate` нужен `db:seed` (в деплое он идёт следом).

## 2. Создание инвойса

```ts
// подписка
await bot.api.createInvoiceLink({
  title: 'Разбор личности — подписка на месяц',
  description: 'Ежедневный прогноз, полный разбор, 5 вопросов в день',
  payload: JSON.stringify({ plan: 'month_399', userId, chartId, idemK: uuid }), // ≤ 128 байт!
  currency: 'XTR',
  prices: [{ label: 'Месяц', amount: 399 }],
  subscription_period: 2592000,
});

// разовый товар — без subscription_period
```

Правила:
- `payload` ≤ 128 байт, содержит `plan`, внутренний `userId`, `idemK`. Никаких ПДн.
- `amount` берётся из таблицы планов, не из запроса клиента.
- Каждый инвойс — отдельная запись в `invoices` со статусом `created`.

Двойная покупка разбора (контракт 1.5.8): если активный
`entitlements (kind = 'report')` на эту карту уже есть, счёт не выставляется —
`422 VALIDATION_FAILED`, `field_errors[0].field = chart_id`,
`details.reason = report_already_owned`. Проверка смотрит на доступ к карте, а
не на цену плана: на тарифе за 1 ⭐ она срабатывает так же, как на 149 ⭐.
Вторая линия обороны — `grantEntitlement` не создаёт второй активный доступ
на ту же карту, если два счёта всё же были выставлены до оплаты (второй платёж
виден в `payments` и разбирается возвратом). После `refund` доступ `revoked`,
и купить разбор снова можно.

### Жизненный цикл инвойса (контракт 1.5.3)

`invoices.status` — ровно три состояния:

| Статус | Что значит | Оплата |
|---|---|---|
| `created` | выставлен, ждёт оплаты | принимается |
| `paid` | оплачен, доступ выдан | повторно не принимается |
| `invalidated` | аннулирован вместе с удалением данных | не принимается никогда |

Перед транзакцией — отмена автопродления в Telegram
(`editUserStarSubscription(is_canceled: true)`, итерация 12): локальная
`cancelled` подписку в Telegram не отменяет, и звёзды списываются за следующий
период уже после удаления данных. Пара (`telegram_id`,
`telegram_payment_charge_id`) читается, пока `user_id` ещё есть; ошибка Bot API
удаление **не блокирует** (152-ФЗ), результат пишется в
`subscriptions.telegram_cancel_state` (`none | cancelled | failed | gave_up`) и
повторяется ночным джобом, пока не истекло окно возврата.

`DELETE /me` делает всё в одной транзакции, в этом порядке:
1. разрешить/вернуть зависшие платежи (`resolvePending` → `refundStillPendingPayments`);
2. отменить подписку и обезличить её: `status='cancelled'`, `user_id=NULL`,
   `anonymized_at=now()`;
3. отозвать права: `entitlements.status='revoked'`, `user_id=NULL`,
   `chart_id=NULL`, `anonymized_at=now()`;
4. обезличить платежи: `user_id=NULL`, `invoice_payload=NULL` (в нём `u=<user_id>`),
   `anonymized_at=now()`;
5. отвязать события: `events.user_id=NULL`, `anonymized_at=now()`;
6. записать результат отмены автопродления (`telegram_cancel_state`,
   `telegram_cancel_attempts`, `telegram_cancel_last_at`);
7. `UPDATE invoices SET status='invalidated', invalidated_at=now()
   WHERE user_id=$1 AND status='created'`;
8. удалить квоты и `users`.

`user_id` обнуляется обязательно: он детерминирован из `telegram_id`
(`HMAC(pepper, "telegram:<id>")`), и оставленный ключ возвращает покупки
вернувшемуся человеку. Всё, что остаётся от денег, — бухгалтерия без владельца.

`payments.telegram_id` живёт ещё 30 дней после удаления
(`PAYMENT_REFUND_WINDOW_DAYS`): `refundStarPayment` требует пару
(user_id, charge_id), без неё возврат невозможен. Дальше его снимает
`pdn_retention_cleanup`. Если возврат нужен позже, поддержка передаёт
telegram id явно: `PaymentsService.refund(chargeId, reason, {telegramUserId})`.

Порядок именно такой: если удалить пользователя раньше инвалидации, останется
окно, в котором пользователя уже нет, а инвойс ещё оплатим.

Оплата по `invalidated` инвойсу (и по отсутствующему пользователю) не выдаёт
доступ: `successful_payment` пишет `rejected` с
`reject_reason = invoice_invalidated | user_deleted`, вебхук всё равно отвечает
`200`, `refundStarPayment` вызывается автоматически, в `events` пишутся
`payment_rejected` и `refund_issued` с тем же `props.code`. Ручной разбор
нужен только при техническом отказе возврата: тогда `payment_rejected`
с `code = refund_failed`, а платёж виден в `pending_payments_now`.

## 3. Обработка событий

### 3.1 `pre_checkout_query`
Ответить `answerPreCheckoutQuery(ok=true)` в течение **10 секунд**. Перед ответом — проверить, что `payload` валиден, инвойс существует и его статус `created`, а пользователь не удалён и не заблокирован.

Если товар уже выдан — всё равно `ok=true` (деньги уже списаны, разберёмся через возврат).

Если инвойс `invalidated`, оплачен или пользователя нет — `ok=false`
с текстом «Оплата больше недоступна — начни заново»: человек должен начать
заказ заново, а не ждать возврата.

### 3.2 `successful_payment`
Поля: `currency`, `total_amount`, `invoice_payload`, `telegram_payment_charge_id`, `provider_payment_charge_id`, `subscription_expiration_date` (для подписок, unix).

Алгоритм (строго в транзакции):
1. `SELECT ... FOR UPDATE` по `telegram_payment_charge_id`; если запись уже `processed` — выйти (идемпотентность).
2. Записать платёж в `payments` (`processed=false`).
3. Выдать доступ:
   - разовый товар → `entitlements` (report/compat/solar);
   - подписка → `subscriptions.plan`, `expires_at = to_timestamp(subscription_expiration_date)`.
4. Поставить `processed=true`, зафиксировать `paid_at`.
5. Отправить пользователю сообщение: что куплено, до какой даты действует.
6. Если тип `report` — поставить задачу генерации в очередь.

**Если генерация упала** — `reports.status=failed`, автовозврат `refundStarPayment` через 10 минут ретраев, пользователю — сообщение «вернули звёзды, попробуйте ещё раз». Возврат без запроса пользователя — обязателен, это защита от жалоб.

### 3.3 Продление
Telegram присылает новый `successful_payment` с тем же `invoice_payload` при продлении. Обработчик обновляет `expires_at`. Ничего отдельно делать не нужно, но **надо** проверить, что `expires_at` действительно сдвинулся, и записать это в лог.

### 3.4 Отмена подписки
Пользователь отменяет в настройках Telegram. Отдельного события нет. Поэтому:
- доступ живёт до `expires_at`, проверяем его при каждом запросе;
- ежедневный джоб `subscription_downgrade` помечает истёкшие подписки как `expired` и отправляет одно сообщение «подписка закончилась, продлить?» (не больше одного на 30 дней). Реализовано в `POST /api/v1/internal/jobs/run` (`apps/api/src/modules/ops/jobs.service.ts`, секрет `X-Jobs-Secret`).

### 3.5 Возвраты
`refundStarPayment(user_id, telegram_payment_charge_id)`. Возврат возможен только пока платёж не выведен (в пределах разумного срока). Правила:
- по запросу пользователя через поддержку — возвращаем, если с момента оплаты < 24 ч;
- автоматически — если товар не был доставлен;
- после возврата доступ отзывается, статус `refunded`, повторная покупка разрешена;
- автопродление отключается в Telegram вызовом `editUserStarSubscription`
  (`is_canceled: true`) — иначе следующее списание придёт после удаления данных;
- возврат по удалённому аккаунту работает: `payments.user_id` уже `NULL`, но
  `telegram_payment_charge_id` и (в окне возврата) `telegram_id` на месте.

Автовозврат за недоставленный товар (`processed = false` дольше 10 минут) — тот же джоб `POST /internal/jobs/run`. Возврат «по запросу через поддержку» делается вызовом `PaymentsService.refund(chargeId, reason)`.

## 4. Проверка подписки на бэкенде

Единая функция `getEntitlements(userId)` возвращает:

```ts
type Entitlements = {
  isActive: boolean;          // подписка действует сейчас
  plan: 'none' | 'trial' | 'week' | 'month' | 'year';
  fullForecast: boolean;
  askPerDay: number;          // 0 / 1 / 5 / -1
  fullReport: boolean;        // куплен ли разбор
  compatPerMonth: number;
  solarIncluded: boolean;
}
```

Правило: **любая проверка доступа — только через неё**. Дублирование условий `if (plan === 'month')` по коду — ошибка ревью.

## 5. Антифрод и лимиты

- Не более 3 инвойсов на пользователя в час, 10 в сутки.
- Один и тот же `plan_code` нельзя купить дважды за 5 минут (защита от двойных тапов — но не блокируем, а возвращаем существующий инвойс).
- Если пользователь сделал 2 возврата — новые покупки разрешены, но помечаем `risk_flag` и не даём триал.
- `initData` старше 24 часов не принимается (защита от replay).

## 6. Что получает FRONTEND

FRONTEND не работает с деньгами напрямую. Его путь:

1. `POST /api/v1/billing/invoice` → получает `invoice_link`.
2. Вызывает `Telegram.WebApp.openInvoice(invoice_link, status => ...)`.
3. `status === 'paid'` → показывает «оплачено» и **перезапрашивает** `GET /api/v1/me` (не верит локальному статусу).
4. `status === 'cancelled'` / `'failed'` → возвращает на пейволл без агрессивных сообщений.
5. `status === 'pending'` → показывает «обрабатываем» и делает 3 попытки `GET /me` с интервалом 2 с.

Доступ к экрану «Разбор» проверяется по данным `GET /me`, а не по локальному флагу после openInvoice. Иначе пользователь увидит контент, который сервер не отдал.
