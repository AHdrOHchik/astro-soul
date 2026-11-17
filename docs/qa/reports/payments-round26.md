# Итерация 26 — короткое название счёта и вебхук, который не умирает молча

Дата: 2026-11-17. Ветка `arena/2b3d6a3e-astro-soul`, база `d992a93`.
Контракт: **1.6.2** (аддитивно к 1.6.1).

## 1. Что было сломано (по выводу `payments:diagnose` от 17.11)

| Проблема | Факт из диагностики | Причина |
|---|---|---|
| 4 из 7 названий счетов длиннее лимита Bot API | `week_149` 36, `month_399` 35, `year_2990` 33, `test_report_1` 33 | в счёт уходил `title` — название тарифа, нужное длинным для логов |
| `test_1` выставляется с недопустимым периодом | `subscription_period 604800 ≠ 2592000` | `db:seed` вставляет только отсутствующие строки; стенд, где `test_1` создан недельным, не обновлялся |
| вебхук «настроили один раз» | после перезапуска туннеля `pre_checkout_query` не приходит, в логах тишина | `setWebhook` на нерезолвящийся адрес Telegram принимает `ok: true` |

## 2. Название счёта — колонка, а не надежда

`migrations/0027_plan_invoice_title.sql`:

- `plans.invoice_title varchar(32)` → заполнение для всех 8 строк каталога →
  `NOT NULL` → `CHECK (char_length(invoice_title) BETWEEN 1 AND 32)`;
- тариф вне списка: берётся `title`, если он ≤ 32, иначе миграция падает с
  текстом, какие коды и какой длины не подходят (а не «null value in column»);
- идемпотентно: заполняются только пустые значения, поэтому правка через
  `plans:set-titles` переживает повторный деплой.

`createInvoiceLink` получает **только** `invoice_title`
(`billing.service.ts`). Если название вне 1–32:

```text
409 CONFLICT
{ "code": "CONFLICT",
  "message": "Этот тариф временно нельзя оплатить: неверно задано название счёта. Выберите другой тариф.",
  "details": { "reason": "plan_invoice_title_invalid" } }
```

`createInvoiceLink` при этом **не вызывается** (проверка стоит до Telegram),
поэтому `502` взяться неоткуда. В лог идёт `invoice_title_invalid` с планом,
фактической длиной и лимитом.

Правка без релиза:

```text
$ pnpm plans:set-titles --code=solar_590 --title="Карта года 2026"
solar_590: название счёта «Карта года» → «Карта года 2026» (15 символов)
{"event":"plan_invoice_title_changed","plan":"solar_590","from":"Карта года","to":"Карта года 2026","chars":15}

$ pnpm plans:set-titles --code=solar_590 --title="Разбор личности — подписка на месяц"
название счёта длиннее лимита Bot API: 35 символов при максимуме 32.
Сократи: «Разбор личности — подписка на месяц» → например «Разбор личности — подписка на»
exit 1   # в базу ничего не записано
```

## 3. `test_1` = 30 дней

- миграция `0027` обновляет существующую строку по `code = 'test_1'` и только
  подписку (`period_seconds IS DISTINCT FROM 2592000`), идемпотентно;
- `db:seed` теперь **синхронизирует тестовые строки** (`period_seconds`,
  `invoice_title`, `description`, `paywall_subtitle`) под
  `PAYMENTS_TEST_PLANS=1`; цены и `is_active` не трогаются;
- проверено на воспроизведении стенда владельца (миграции 0026/0027 не
  применены, названия 35/36/33/33, `test_1` 604800): после `pnpm db:migrate` —
  все названия ≤ 32, `test_1.period_seconds = 2592000`.

## 4. Вебхук: состояние видно снаружи

- резолв хоста `MINI_APP_URL` (таймаут 2 с) **до** Bot API; при провале
  `setWebhook` не вызывается вообще;
- `WARN telegram_webhook_unreachable` с человеческим текстом (см. ниже);
- `GET /health` → `telegram_webhook: ok | stale | unreachable`
  (`stale` — проверки не было или она старше 24 ч);
- `/admin/metrics` → `telegram_webhook_ok`, `telegram_webhook_checked_at`.

Лог на стенде с нерезолвящимся адресом (`MINI_APP_URL=https://gone-tunnel-26.trycloudflare.com`):

```json
{"level":"warn","msg":"telegram_webhook_unreachable",
 "host":"gone-tunnel-26.trycloudflare.com",
 "dns_error":"getaddrinfo ENOTFOUND gone-tunnel-26.trycloudflare.com",
 "hint":"адрес MINI_APP_URL (gone-tunnel-26.trycloudflare.com) не резолвится: … Telegram не сможет доставить pre_checkout_query — оплата в Telegram работать не будет. Запусти туннель (например, cloudflared tunnel --url http://localhost:3000), проверь MINI_APP_URL и перезапусти API: pnpm payments:diagnose --set-webhook",
 "note":"setWebhook не вызывался: адрес не резолвится, доставка апдейтов невозможна"}
```

```text
GET /api/v1/health        → telegram_webhook = unreachable
GET /api/v1/admin/metrics → telegram_webhook_ok = false,
                            telegram_webhook_checked_at = 2026-11-17T11:30:43.866Z
```

## 5. `payments:diagnose`

Каталог печатает название счёта и его длину рядом с лимитом — то, что реально
уйдёт в Bot API:

```text
Каталог и лимиты Bot API (invoice_title = то, что уходит в счёт Telegram)
  ✓ one_149        invoice_title=«Полный разбор» (13/32)  period=        —  ok
  ! week_149       invoice_title=«Подписка на неделю» (18/32)  period=   604800  subscription_period 604800 ≠ 2592000: Telegram отклонит счёт
  ✓ month_399      invoice_title=«Подписка на месяц» (17/32)  period=  2592000  ok
  ! year_2990      invoice_title=«Подписка на год» (15/32)  period= 31536000  …
  ✓ compat_249     invoice_title=«Совместимость с партнёром» (25/32)  period=—  ok
  ✓ solar_590      invoice_title=«Карта года» (10/32)  period=        —  ok
  ✓ test_1         invoice_title=«Тестовая подписка — 1 ⭐» (23/32)  period=  2592000  ok
  ✓ test_report_1  invoice_title=«Тестовый разбор — 1 ⭐» (21/32)  period= —  ok
```

`!` у `week_149`/`year_2990` — не регрессия и не эта итерация: тарифы-подписки с
периодом, которого Bot API не принимает; решение владельца (A/B/C,
`payments.md` §3.6) в этот PR не входит.

При нерезолвящемся адресе вывод добавляет строку «что делать»:

```text
Вебхук
  unreachable: адрес MINI_APP_URL не резолвится — Telegram не доставит pre_checkout_query
  ожидается: https://random-words-here.trycloudflare.com/api/v1/internal/telegram/webhook/***cret
  зарегистрирован: —
  что делать: адрес MINI_APP_URL (…) не резолвится: getaddrinfo ENOTFOUND … Запусти туннель …
```

`--set-webhook` на стенде со «старым доменом» в стабе Bot API:

```text
Вебхук
  registered: вебхук перерегистрирован на ожидаемый адрес
  ожидается:          http://127.0.0.1:8080/api/v1/internal/telegram/webhook/***6789
  зарегистрирован:    http://127.0.0.1:8080/api/v1/internal/telegram/webhook/***6789
  в очереди: 0
```

## 6. Прогон на стенде (`e2e/qa/iteration-26.mjs`)

Стенд: Postgres 16 (локально), API на `127.0.0.1:8080`, **стаб Bot API**
(`e2e/qa/bot-stub.mjs`, `TELEGRAM_API_BASE_URL`), `PAYMENTS_TEST_PLANS=1`,
`MINI_APP_URL=http://127.0.0.1:8080`. Живого бота и туннеля в песочнице нет —
см. «Не проверено».

```text
1. Состояние вебхука видно снаружи (без ssh в контейнер)
✓ GET /health → telegram_webhook: ok          (telegram_webhook = ok, db = ok, astro = down)
✓ GET /admin/metrics → telegram_webhook_ok и время проверки (true, 2026-11-17T11:30:08.496Z)

2. payments:diagnose на этом же окружении
✓ каталог: у каждого тарифа invoice_title 1–32 символа (8/8)
✓ test_1: период 2 592 000 и название счёта в лимите
✓ --periods: все периоды приняты (стаб, не живой Bot API)

3. Полный путь оплаты: compat_249 и test_report_1
✓ compat_249: счёт → pre_checkout ok → платёж → доступ
    createInvoiceLink.title = «Совместимость с партнёром» (25/32)
    pre_checkout ответ: {"ok":true}
    successful_payment: 200, доступ: {"compat_per_month":1}
✓ test_report_1: счёт по карте → pre_checkout ok → платёж → доступ к разбору
    createInvoiceLink.title = «Тестовый разбор — 1 ⭐» (21/32)
    entitlements: {"full_report":true,"full_report_chart_id":"486b2f44-…"}
✓ в счёт уходит invoice_title из базы, а не название тарифа

4. test_1 — подписка на 30 дней
✓ test_1: счёт подписки с subscription_period = 2 592 000

Итог: 9/9 проверок зелёные
```

Логи API того же прогона (то, что требует приёмка):

```json
{"msg":"pre_checkout_answered","ok":true,"reason":"ok","plan":"compat_249","amount":249,"expected":249,"duration_ms":5,"answered":true}
{"msg":"pre_checkout_answered","ok":true,"reason":"ok","plan":"test_report_1","amount":1,"expected":1,"duration_ms":7,"answered":true}
{"msg":"test_payment_processed","stars":1,"charge_tail":"027961"}
```

Карта на стенде создана вставкой в `charts` (`POST /charts` недоступен: движок
эфемерид не запущен, `astro: down`), поэтому в прогоне нет проверки «карта из
приложения» — путь разового товара покрыт интеграционным тестом
`payments-precheckout.spec.ts` и этим прогоном с `QA_CHART_ID`.

## 7. Тесты

| Пакет | Было (итерация 25) | Стало |
|---|---|---|
| `apps/api` | 470 тестов / 41 файл | **499 / 45** |
| `apps/web` | 823 / 825 (2 падения `legal-texts`, было до нас) | 823 / 825 (те же 2) |
| `packages/shared` | 31 / 4 | 31 / 4 |
| `packages/ui` | 39 / 4 | 39 / 4 |

Новые файлы:

- `apps/api/test/plans-invoice-title.spec.ts` (11) — длина у всех тарифов в базе,
  `createInvoiceLink` получает `invoice_title`, 33 символа не записываются,
  битое название → `409 plan_invoice_title_invalid` без вызова Bot API,
  `test_1` = 2 592 000, `test_report_1` разовый, валидация `plans:set-titles`;
- `apps/api/test/telegram-webhook-health.spec.ts` (12) — резолв адреса,
  `setWebhook` не вызывается на нерезолвящийся хост, `ok|stale|unreachable` в
  `/health`, `telegram_webhook_ok`/`_checked_at` в метриках, «свежесть» через
  подмену часов;
- `apps/api/test/payments-diagnose.spec.ts` (6) — формат вывода: `invoice_title`
  и `(17/32)`, `✓`/`✗`, строка «что делать», вердикты `--periods`.

## 8. Команды и коды возврата

```text
pnpm build      → 0   (web bundle 114.7 kB gzip из 350 kB)
pnpm lint       → 0   (0 errors, 0 warnings)
pnpm typecheck  → 0
pnpm test       → 1   (единственное падение — 2 теста apps/web/tests/legal-texts.test.ts,
                       они падают и на базе d992a93, тексты принадлежат владельцу)
apps/api vitest → 0   (499/499)
```

## 9. Не проверено (честно)

- живой Bot API и живой туннель: в песочнице нет сети до `api.telegram.org` и
  нет возможности поднять `cloudflared`. Поэтому «оплата 1 ⭐ в клиенте
  Telegram» и `--set-webhook` на реальном адресе не прогонялись — проверены
  идентичным кодом на стабе (расхождение только в адресе Bot API);
- `--periods` на живом Bot API: на стабе он не валидирует период, поэтому
  «все ok» подтверждает наш код и данные, а не ответ Telegram;
- приёмка «все семь ok, без `✗` и `!`» выполнена частично: `✗` нет ни одного,
  `!` остались только у `week_149`/`year_2990` — это ожидающее решения владельца
  (§3.6), в PR не входит.
