# QA-13: тестовые тарифы за 1 звезду (`test_1`, `test_report_1`)

**Дата:** 2026-11-16. **Контракт:** 1.5.7. **Стенд:** два процесса API против одной
БД `astro_qa13` — порт 8084 без флага (как прод) и порт 8085 с
`PAYMENTS_TEST_PLANS=1` (как стенд владельца), стаб Bot API на 8091.

## Что проверено на живом стенде (`e2e/qa/iteration-13.mjs`, 74 проверки)

| Сценарий | Факт |
|---|---|
| `off` | `POST /billing/invoice {plan_code: "test_1"}` → `422 VALIDATION_FAILED`, тело побайтно совпадает с ответом на `no_such_plan`; `createInvoiceLink` не вызывался; инвойса в БД нет |
| `on` | `201`, `stars: 1`, `is_subscription: true`, `subscription_period_sec: 604800`; в Bot API ушло `prices[0].amount = 1` и `subscription_period = 604800`; `payload` = `{p,u,k}` без ПДн |
| `precheckout` | `pre_checkout_query` на 1 ⭐ → `ok: true`; после `DELETE /me` тот же счёт → `ok: false` |
| `pay` | 1 ⭐ → `subscription.is_active: true`, `plan: month`, `expires_at` +7 дней, `full_forecast: true`, `ask_per_day: 5`; `payments` = `processed|is_test=true|1` |
| `pay` (метрики) | `test_payments_30d = 1`, `stars_received_30d = 0`, `paying = 0`, `conversion_to_paid = 0` |
| `pay` (БД) | `plans`: `test_only = true`, `is_active = false` |
| `wrong-amount` | 2 ⭐ за `test_1` → `rejected|amount_mismatch|is_test=true`, доступа нет |
| `refund` | `support-refund.ts` → `refund() -> true`, повторный `false`; `refundStarPayment` вызван **ровно один раз** с парой (`user_id`, `charge_id`); платёж `refunded`, доступ отозван |
| `prod-guard` | `check.sh --prod` с `PAYMENTS_TEST_PLANS=1` → код 1 и текст про оба тарифа; чистое окружение → 0 |

### Разовый разбор `test_report_1` (второй денежный путь)

| Сценарий | Факт |
|---|---|
| `report-off` | без флага — `422`, тело совпадает с ответом на `no_such_plan`, Bot API не звали, инвойса нет |
| `report-on` | `201`, `stars: 1`, `is_subscription: false`, `subscription_period_sec: null`; в Bot API **нет** `subscription_period` (не подписка) |
| `report-pay` | `entitlements.full_report: true`, `full_report_chart_id` = оплаченная карта; `POST /reports` по ней `202`, по второй карте `402` (цена); платёж `processed|is_test=true|1` |
| `report-pay` (повтор) | счёт на ту же карту `422`, `field_errors[0].field = chart_id`, активный `report`-доступ ровно один |
| `report-pay` (цена ни при чём) | `one_149` на уже купленную карту — тоже `422` |
| `report-pay` (метрики) | `test_payments_30d = 1`, `stars_received_30d = 0` |
| `report-refund` | `refundStarPayment` один раз, `full_report: false`, `full_report_chart_id: null`, `POST /reports` → `402`, повторная покупка → `201` |

Два прогона подряд — одинаковый результат, скрипт чистит свои фикстуры
(включая `charts`: у `charts` уникальность `(user_id, input_hash)`).

## Почему тестовая цена не поедет в прод

1. Оба тарифа в единственном месте цен (`packages/shared/src/plans.ts`) с
   `testOnly: true`; без флага они не существуют для `POST /billing/invoice`.
2. Ни `test_1`, ни `test_report_1` нет в `PLAN_CODES`, `PLANS_ORDERED`
   (каталог пейволла) и в контракте `PlanCode` — фронт о них не узнаёт.
3. `check.sh --prod` валит запуск с флагом; в `.env.example`,
   `docker-compose.yml` и по умолчанию в документации переменной нет.
4. Отдельный учёт (`payments.is_test`) — забытый флаг видно в
   `/admin/metrics.test_payments_30d`, а не только в логах.

## Двойная покупка разбора (контракт 1.5.8)

Проверено на живом стенде и в vitest: `POST /billing/invoice` на карту, за
которую разбор уже куплен, отвечает `422` (`report_already_owned`) — и для
`test_report_1`, и для `one_149`. Проверка смотрит на активный
`entitlements (kind = 'report')` на карту, а не на цену плана. После возврата
доступ `revoked`, покупка снова разрешена (проверено: `201`).

Вторая линия обороны — `grantEntitlement` не создаёт второй активный доступ на
ту же карту, если два счёта всё же были выставлены до оплаты.

## Эксплуатационная заметка: после выкатки нужен `pnpm db:seed`

Строка `plans` для тестового тарифа появляется из сида. Если её не залить на
стенде, `POST /billing/invoice` упадёт на FK `invoices.plan_code → plans.code`
(`500`). В деплое сид идёт после миграций; при ручном стенде — тоже.

## Что не проверено

- **Настоящая оплата в клиенте Telegram** — `openInvoice`, окно звёзд, реальное
  списание 1 ⭐ и реальный `subscription_expiration_date`. Проверяет владелец
  вручную (шаги — `docs/DOCKER.md` §«Тестовый тариф»).
- **Реальный рекуррентный платёж** через неделю: на стенде Telegram не
  продлевает. Поэтому в инструкции пункт 6 — отменить подписку руками.
- Реальный `refundStarPayment` в Bot API: на стабе возврат успешен всегда,
  отказ (`ok: false`) проверен в vitest.
