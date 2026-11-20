# Итерация 29 — отмена подписки из приложения

Продуктовый блокер и риск живых денег. Контракт: **1.6.5** (аддитивно: один
маршрут и поля в состоянии подписки). Ветка `arena/26a02d21-astro-soul`, база
`96b4e63`.

## 1. Что было сломано

Владелец оформил тестовую подписку за 1 ⭐ и не смог её отменить. Кнопка
«Открыть подписки в Telegram» ведёт на `tg://settings/star_subscriptions` —
такого адреса нет (`ERR_UNKNOWN_URL_SCHEME`). Отменить автопродление из
приложения было **нельзя вообще**: единственным способом не продлевать было
удалить аккаунт (`DELETE /me`), то есть «не продлевай, но потеряй всё
купленное». Через период звёзды списывались молча.

`payments.md` §3.4 говорил «пользователь отменяет в настройках Telegram», и на
этой инструкции мы держались. Она не работает: до настроек ещё нужно дойти, а
внутри приложения подсказки нет.

## 2. Что сделано

### 2.1. `POST /api/v1/subscription/cancel`

`apps/api/src/modules/billing/subscription.controller.ts` — путь и ответы;
`apps/api/src/modules/billing/billing.service.ts:288` — резолв `user_id` (тот же
псевдонимный ключ, что у подписки и платежей); логика — в
`apps/api/src/modules/billing/subscription-cancel.service.ts:180`
(`cancelAutoRenew`).

| Случай | Ответ |
|---|---|
| Bot API подтвердил | `200 { status: "cancelled", auto_renew: false, current_period_end }` |
| Подписки нет / истекла / отменена удалением | `409`, `details.reason = no_active_subscription` |
| Повтор после успеха | `409`, `details.reason = already_cancelled` |
| `ok:false` / таймаут / нет `charge_id` | `502`, `details.reason = telegram_error \| timeout \| no_charge_id` |
| Нет или битый `Idempotency-Key` | `422`, `details.field_errors[0].field = "Idempotency-Key"` |

`Idempotency-Key` проверяется **до** любых изменений и до похода в Bot API; он
не хранится: повтор после успеха отсекается по состоянию подписки (`409`), а
не по ключу, — иначе ключ нужно было бы держать вечно.

### 2.2. Отмена ≠ возврат

Строка подписки остаётся `active`, `expires_at` не меняется, права
(`entitlements`, `is_active`) те же. Меняются только `auto_renew` и
`cancelled_at`. Это и есть главное требование к тексту ответа: человек не
должен думать, что у него отобрали оплаченное.

### 2.3. `auto_renew` меняется только после подтверждения Bot API

Порядок: Bot API → наша строка. При `ok:false` `auto_renew` остаётся `true`,
состояние — `telegram_cancel_state = 'failed'`, ответ `502`. Сказать «отменено»,
когда звёзды всё ещё спишутся, — это ровно та ошибка, из-за которой маршрут и
появился. Повтор — тем же механизмом, что у `DELETE /me`: ночной джоб
`pdn_retention_cleanup`, окно 30 дней, до 5 попыток, не чаще раза в час.
Второго счётчика попыток нет: колонки `telegram_cancel_state`,
`telegram_cancel_attempts`, `telegram_cancel_last_at` общие.

Отдельно: повторное нажатие «Отменить» после `502` пробует сразу, не дожидаясь
джоба (человек видит «не получилось» и жмёт ещё раз). После 5 неудач
(`gave_up`) вызова нет вовсе — Bot API уже не примет этот `charge_id`.

### 2.4. `charge_id` — последнего успешного платежа

`subscriptions.telegram_payment_charge_id` (обновляется каждым продлением), а
если там пусто — последний успешный платёж пользователя по подписке. Тот же
порядок, что в `DELETE /me`.

`no_charge_id` — не отказ Telegram, а наш дефект: платёж прошёл, а
идентификатор не сохранили. Состояние сразу `gave_up` (повторять бессмысленно),
в лог идёт отдельное событие `subscription_cancel_no_charge_id` уровня `error`,
в метрики — отдельный счётчик.

### 2.5. Состояние и миграция

`migrations/0028_subscription_cancel_at.sql`:

- `subscriptions.cancelled_at timestamptz` — новое;
- `auto_renew` **уже был** (с 0003, `NOT NULL DEFAULT true`), добавлять не
  пришлось: изменился его смысл — раньше «значение из настроек Telegram, только
  для чтения», теперь наше записываемое состояние. Комментарий обновлён;
- частичный индекс повтора расширен с `status = 'cancelled'` на
  `telegram_cancel_state = 'failed'`: отменённая через приложение подписка
  остаётся `active`, и без этого сбой не повторился бы никогда;
- индекс под метрику `subscriptions_auto_renew_off`.

### 2.6. `GET /me`

`apps/api/src/modules/entitlements/entitlements.service.ts:143` — в
`SubscriptionState` добавлено `cancelled_at` (`null`, если продление включено).
`auto_renew` уже было и остаётся обязательным полем; оба меняются только у
отменённой подписки. Существующие поля не переименованы.

### 2.7. `DELETE /me`

Поведение не изменилось: данные удаляются, доступ закрывается, автопродление
гасится тем же `editUserStarSubscription`. Одно улучшение: если отмена уже была
подтверждена (`auto_renew = false` и `telegram_cancel_state = 'cancelled'`),
второго вызова нет — иначе Bot API ответил бы `subscription not active` и это
записалось бы в события как сбой.

## 3. Метрики и события

`GET /admin/metrics`:

| Метрика | Что значит |
|---|---|
| `subscription_cancel_total_24h` | сколько отмен прошло за сутки (события `subscription_cancelled`) |
| `subscription_cancel_failed_24h` | сколько не прошло (события `subscription_cancel_failed`) |
| `subscription_cancel_no_charge_id_24h` | из них без `charge_id` — наш дефект данных |
| `subscriptions_auto_renew_off` | действующие подписки, которые уже не продлятся |
| `subscriptions_cancelled_pending_telegram` | ждут повтора (теперь без фильтра по статусу) |

События: `subscription_cancelled` (новое, `props.source = endpoint`),
`subscription_cancel_failed` (переиспользовано, добавлен `props.source`:
`endpoint` для кнопки, `delete` для удаления аккаунта, у повтора — нет).

## 4. Как проверял

```
pnpm build      → ok (web 114.7 kB gzip из 350)
pnpm lint       → 0 проблем
pnpm typecheck  → 4/4 проекта; gen:contracts:check и gen:api:check зелёные
pnpm test       → api 546/546 (46 файлов, было 529), shared 31/31, ui 39/39,
                  web 823/825 — те же два падения
                  apps/web/tests/legal-texts.test.ts, что и на базе
```

Новый файл `apps/api/test/subscription-cancel.spec.ts` — 17 тестов:

1. успех: `200`, стаб получил верный `user_id`/`charge_id`, `auto_renew: false`,
   `cancelled_at` заполнен, `status` строки `active`, `expires_at` и
   `entitlements` не изменились;
2. `charge_id` берётся из последнего платежа, а не из первого;
3. события и метрики: одна отмена, ноль провалов, одна подписка без продления;
4. повтор → `409 already_cancelled`, второго вызова нет;
5. подписки нет → `409 no_active_subscription`; истёкшая → то же; отменённая
   удалением аккаунта → то же;
6. без `Idempotency-Key` → `422`, вызова нет, `auto_renew` не тронут;
7. `ok:false` → `502 telegram_error`, `failed`, событие с `source`, метрика;
   джоб повторяет → `cancelled`, и только тогда `/me` говорит «не продлится»;
8. таймаут → `502 timeout`, `failed`;
9. нет `charge_id` → `502 no_charge_id`, `gave_up`, отдельный счётчик;
10. `gave_up` → сразу `502` без вызова;
11. повторное нажатие после `502` пробует сразу;
12. `test_1` → отмена работает, повтор `409`;
13. `/me` до/после: `auto_renew`/`cancelled_at` меняются только у отменённой;
14. `/me` без подписки: `plan none`, `auto_renew false`, `cancelled_at null`;
15. `DELETE /me` после отмены: удаление проходит, второго вызова нет.

### Живой прогон на стабе Bot API

`e2e/qa/iteration-29.mjs` — полный путь для `test_1` (та самая подписка
владельца): счёт → `pre_checkout_query` → `successful_payment` → `/me` →
`POST /subscription/cancel` → повтор → сбой Bot API на втором пользователе →
метрики.

```
✓ счёт выставлен            plan_code = test_1, stars = 1
✓ successful_payment принят
✓ подписка активна и продлится   auto_renew = true, cancelled_at = null
✓ без Idempotency-Key → 422      field = Idempotency-Key
✓ POST /subscription/cancel → 200
    status = cancelled, auto_renew = false,
    current_period_end = 2026-12-20T09:27:08.000Z
✓ стаб получил editUserStarSubscription
    last = {"user_id":777000111,
            "telegram_payment_charge_id":"qa-cancel-777000111-…",
            "is_canceled":true}
✓ в /me: auto_renew false, cancelled_at заполнен, доступ тот же
    is_active = true, expires_at тот же, entitlements не изменились = true
✓ повтор → 409 already_cancelled
✓ второго вызова в Bot API нет   было 1, стало 1
✓ отмена при сбое Bot API → 502 telegram_error
✓ после 502 подписка всё ещё «продлится»   auto_renew = true, cancelled_at = null
✓ метрики: total_24h ≥ 1, failed_24h = 1, no_charge_id_24h = 0,
           auto_renew_off = 1, pending_telegram = 1
Итог: 14/14 проверок пройдено
```

## 5. Что проверять QA

1. Оформить `test_1` (при `PAYMENTS_TEST_PLANS=1`), открыть экран подписки.
2. Нажать «Отменить» → `200`; в `GET /me` `auto_renew: false`,
   `cancelled_at` заполнен, `is_active: true`, права те же.
3. В `GET /__config` стаба — `editUserStarSubscription.last` с `user_id`,
   `telegram_payment_charge_id` последнего платежа и `is_canceled: true`.
4. Нажать «Отменить» ещё раз → `409 already_cancelled`, второго вызова нет.
5. В `GET /admin/metrics`: `subscription_cancel_total_24h` вырос,
   `subscription_cancel_no_charge_id_24h = 0`, `subscriptions_auto_renew_off ≥ 1`.
6. `DELETE /me` после отмены → `204`, второго вызова в Bot API нет.

## 6. Контракт

**1.6.5, аддитивно.** Добавлено:

- `POST /api/v1/subscription/cancel` (обязательный `Idempotency-Key`, `409`
  двух видов, `502` с `details.reason`);
- схема `SubscriptionCancelResult`;
- `SubscriptionState.cancelled_at` (`string | null`, приходит всегда, в
  `required` не включено — чтобы не ломать уже собранный клиент; `auto_renew`
  там был и остался);
- описания `DELETE /me` (уже говорило правду — проверено), `GET /admin/metrics`
  (четыре новые цифры), `x-analytics-server-events` (`subscription_cancelled`,
  `props.source`).

Ни одно существующее поле не переименовано, ни один код не удалён. Фронту
нужен `pnpm --filter @astro-soul/web run gen:api`, чтобы получить новые типы.
Кнопку «Открыть подписки в Telegram» фронт меняет на вызов этого маршрута —
это отдельная работа (`apps/web` в этой итерации не трогался).

## 7. Риски и что не проверено

- **Живой Bot API не вызывался** (в песочнице нет ключа и сети до Telegram):
  проверено на стабе, который принимает `POST` и отдаёт `{ok:true}`. Живой
  ответ на `editUserStarSubscription` с настоящим `charge_id` — за владельцем;
- **`test_1` — 30 дней, а не 7**, как в задании: Bot API принимает у звёздных
  подписок только период 2 592 000 секунд, недельный тестовый тариф вообще не
  выставлялся (итерация 25). Отмена от периода не зависит, но «спишется через
  7 дней» — уже неверно: через 30;
- **Публичный юридический текст** (`legal-texts-2026-11-10.md`, экран
  «Пользовательское соглашение») говорит «отменить можно в настройках
  Telegram». Это не ложь, но теперь неполно: отмена есть в приложении. Текст
  принадлежит владельцу — править его и пересчитывать digest без решения
  владельца нельзя. `SPEC.md` §3 и `legal.md` §4 обновлены;
- `apps/web` не менялся: кнопка в мини-аппе всё ещё ведёт на несуществующий
  адрес — маршрут для неё готов, но фронт это отдельный PR;
- retry-джоб проверен тестом (сдвиг `telegram_cancel_last_at` на 2 часа), но не
  «живым ожиданием ночи».
