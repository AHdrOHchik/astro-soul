# QA-13: тестовый тариф `test_1` за 1 звезду

**Дата:** 2026-11-16. **Контракт:** 1.5.7. **Стенд:** два процесса API против одной
БД `astro_qa13` — порт 8084 без флага (как прод) и порт 8085 с
`PAYMENTS_TEST_PLANS=1` (как стенд владельца), стаб Bot API на 8091.

## Что проверено на живом стенде (`e2e/qa/iteration-13.mjs`, 45 проверок)

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
| `prod-guard` | `check.sh --prod` с `PAYMENTS_TEST_PLANS=1` → код 1 и текст про `test_1`; чистое окружение → 0 |

Два прогона подряд — одинаковый результат, скрипт чистит свои фикстуры.

## Почему тестовая цена не поедет в прод

1. Тариф в единственном месте цен (`packages/shared/src/plans.ts`) с
   `testOnly: true`; без флага он не существует для `POST /billing/invoice`.
2. `test_1` нет в `PLAN_CODES`, `PLANS_ORDERED` (каталог пейволла) и в
   контракте `PlanCode` — фронт о нём не узнаёт из типов.
3. `check.sh --prod` валит запуск с флагом; в `.env.example`,
   `docker-compose.yml` и по умолчанию в документации переменной нет.
4. Отдельный учёт (`payments.is_test`) — забытый флаг видно в
   `/admin/metrics.test_payments_30d`, а не только в логах.

## Что не проверено

- **Настоящая оплата в клиенте Telegram** — `openInvoice`, окно звёзд, реальное
  списание 1 ⭐ и реальный `subscription_expiration_date`. Проверяет владелец
  вручную (шаги — `docs/DOCKER.md` §«Тестовый тариф»).
- **Реальный рекуррентный платёж** через неделю: на стенде Telegram не
  продлевает. Поэтому в инструкции пункт 6 — отменить подписку руками.
- Реальный `refundStarPayment` в Bot API: на стабе возврат успешен всегда,
  отказ (`ok: false`) проверен в vitest.
