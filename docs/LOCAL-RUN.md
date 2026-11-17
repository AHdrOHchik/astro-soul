# Локальный прогон: API, туннель и оплата в Telegram

Короткая памятка для стенда, на котором проверяют **оплату**. Всё остальное —
[`docs/DOCKER.md`](./DOCKER.md). Здесь только то, что забывают, и из-за чего
потом «оплата не проходит, а в логах ничего нет».

## 1. Поднять базу и API

```bash
docker compose up -d          # Postgres + Redis
pnpm db:migrate               # миграции (в т.ч. 0027 — название счёта)
pnpm db:seed                  # каталог планов; тестовые — при PAYMENTS_TEST_PLANS=1
pnpm dev:api                  # http://localhost:8080/api/v1
```

Для проверки оплаты владельцем нужен `PAYMENTS_TEST_PLANS=1`: только тогда
витрина отдаёт тарифы за 1 ⭐ (`test_1` — подписка на 30 дней, `test_report_1` —
разовый разбор).

## 2. Туннель

Telegram доставляет `pre_checkout_query` на **публичный** адрес, поэтому
localhost ему не подходит:

```bash
cloudflared tunnel --url http://localhost:3000
export MINI_APP_URL="https://<адрес-из-вывода-cloudflared>"
```

Адрес quick-туннеля меняется при каждом запуске. Для ежедневной работы
правильнее **именованный** туннель: у него постоянный адрес, и `MINI_APP_URL`
не приходится править по десять раз в день.

## 3. После каждого запуска туннеля — перерегистрировать вебхук

```bash
pnpm payments:diagnose --set-webhook
```

Почему это обязательно: `setWebhook` на адрес, который уже не резолвится,
Telegram принимает **молча** (`ok: true`), а потом просто не может достучаться.
Снаружи это выглядит как «окно оплаты открылось и зависло». API теперь сам
проверяет резолв `MINI_APP_URL` при старте и пишет в лог `telegram_webhook_unreachable`
с подсказкой, но адрес вебхука он исправит только при следующем рестарте —
поэтому после нового туннеля запусти `--set-webhook` (или перезапусти API).

Проверить, что всё сошлось:

```bash
pnpm payments:diagnose --periods
# Вебхук: ok, ожидаемый адрес = зарегистрированный
# Каталог: у каждого тарифа invoice_title ≤ 32 и период подписки = 2 592 000
```

## 4. Что смотреть, когда оплата не проходит

| Симптом | Куда смотреть |
|---|---|
| окно оплаты открылось, дальше ошибка | `pnpm payments:diagnose` → вебхук и его адрес |
| в логе `telegram_webhook_unreachable` | `MINI_APP_URL` не резолвится: поднять туннель, обновить переменную, перезапустить API |
| `GET /health` → `telegram_webhook: stale` | вебхук не проверяли или проверка старше суток: перезапустить API |
| `GET /health` → `telegram_webhook: unreachable` | адрес не резолвится или Bot API недоступен, см. `hint` в логе |
| `409 plan_invoice_title_invalid` | `plans.invoice_title` вне 1–32: `pnpm plans:set-titles --code=… --title=…` |
| `409 plan_period_unsupported` | тариф-подписка с периодом, которого Bot API не принимает (звёздная подписка — только 30 дней) |
| `pre_checkout_total_24h = 0` при живых попытках | вебхук не доставляет: адрес/секрет/блокировка |

## 5. Перед прогоном — почистить состояние

```sql
TRUNCATE payments, invoices, subscriptions, entitlements, events, charts, quotas
  RESTART IDENTITY CASCADE;
```

`compatibility` не трогать: это справочник, а не пользовательские данные.
