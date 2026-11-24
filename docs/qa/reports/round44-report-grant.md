# Итерация 44 — «грант на разбор не открывает разбор» (контракт 1.6.18, без изменений)

Диагностика и правка платёжного пути. Симптом владельца: аккаунт A без покупок,
код «всё включено» на 14 дней → совместимость открылась, разбор остался платным;
второй код «только разбор» → активировался без ошибки, разбор всё равно платный.

Три факта важны вместе, и они не противоречат друг другу: `all_access` **работал**
для четырёх фич из пяти, а пятая не работала ни через `all_access`, ни через
`single_report` — при этом по разным причинам. Это и есть ответ на «почему код
сработал, а разбор нет».

Контракт не менялся: ни `api.openapi.yaml`, ни сгенерированные типы, ни версия
(`info.version` остался `1.6.18` из предыдущей правки). Миграций нет — данные в
порядке, дефект был в коде. Цены, `plans`, `MAX_ATTEMPTS`, брейкеры и
`REFUND_ON_REPORT_FAILED` не тронуты.

## Что и почему

Дверь к доступу одна — `AccessService.hasAccess`. В ней пять фич:
`full_forecast`, `ask`, `report`, `compat`, `solar`. Диагностика показала, что для
разбора дверь **не видела двух источников из трёх**:

* `getEntitlements` в ветке «всё включено» поднимал `isActive`, `fullForecast`,
  `askPerDay`, `compatPerMonth`, `solarIncluded` — и **не поднимал `fullReport`**.
  Четыре флага из пяти: совместимость открылась ровно потому, что её флаг был в
  списке, а разбора в списке не было;
* `reportAccess` для разбора конкретной карты смотрел оплаченный разбор этой
  карты и `single_report`, а грант `all_access` не спрашивал вовсе — то есть
  даже с `fullReport: true` карта осталась бы платной;
* при этом `single_report` дверь видела и **пропускала** заказ. Значит «второй код
  не сработал» — не про сервер: сервер отвечал `202` и начинал разбор. Цену
  показывал клиент, читая другое поле.

Плюс два дефекта, найденные по ходу и не связанные с симптомом (оба на платёжном
пути, поэтому чинились здесь же): расход `single_report` не происходил **никогда**
(право не сгорало, а значит один подарок давал бесконечные бесплатные разборы), и
активация кода не была одной транзакцией, хотя комментарий обещал именно это.

## Диагноз: гипотезы по очереди

Всё воспроизведено на чистом аккаунте в реальной базе (PGlite, схема из миграций
репозитория), через настоящий `POST /charts`, настоящие коды в `access_codes` и
`AccessCodesService.activate`. Значения ниже — из ответов и из `SELECT`.

### H1 — «`hasAccess('report')` не учитывает `single_report` вовсе». **Не подтвердилась**

`single_report` дверь видит. После активации кода на разбор:

```
grants:        [{kind: "single_report", source: "partner", consumed_at: null, revoked_at: null}]
/me:           single_reports: 1, full_report: false, full_report_chart_id: null
hasAccess:     full_forecast false, ask false, report TRUE, compat false, solar false
POST /reports: 202 (report_id f8a6b120-…, status queued)
```

То есть сервер заказ **принимал**. Симптом «разбор всё равно платный» в этой части
живёт на клиенте (см. H5).

### H2 — «`all_access` не включает фичу `report`». **Подтвердилась**

```
grants:  [{kind: "all_access", source: "partner",
           starts_at: 2026-11-24T11:48:56.735Z, expires_at: 2026-12-08T11:48:56.735Z,
           consumed_at: null, revoked_at: null}]
код:     {code: "ALLL2222", kind: "all_access", days: 14}
/me:     is_active true, full_forecast true, ask_per_day 5, compat_per_month 1,
         solar_included true, all_access_until 2026-12-08T11:48:56.735Z,
         full_report FALSE, full_report_chart_id null, single_reports 0
hasAccess: full_forecast true, ask true, report FALSE, compat true, solar true
POST /reports:          402 PAYMENT_REQUIRED, reason report_not_paid
POST /billing/invoice:  201 (счёт one_149 создан), payments: 0
```

Право действует (`all_access_until` в будущем, `is_active: true`), четыре фичи
открыты, `full_report: false`, разбор — `402`. Матрица пяти фич для одного и того
же гранта — это и есть доказательство: дело не в активации и не в сроке.

### H3 — «право списывается при активации». **Не подтвердилась**

`consumed_at` пуст у обеих строк (`all_access` и `single_report`) сразу после
активации; `POST /reports` не меняет его тоже. Обратная беда оказалась хуже: право
не списывалось **вообще никогда** (см. «Что сделано», п. 3).

### H4 — «код на разбор создаётся с другим `kind`». **Не подтвердилась**

`access_codes.kind = 'single_report'`, `grants.kind = 'single_report'`,
`source = 'partner'`, `code_id` связан. Код был правильный.

### H5 — «гейт стоит в двух местах: API говорит «есть», UI смотрит на другое поле». **Подтвердилась**

Сервер: `hasAccess(userId,'report',{chartId}) = true` (при `single_report`) и
`/me.entitlements.single_reports = 1`. Клиент: кнопку «Открыть» или «Купить»
выбирает **`Me.entitlements.full_report_chart_id`** — функция `hasReportFor` в
`apps/web/src/lib/plans.ts`, используется в `apps/web/src/App.tsx` (проп
`fullReport` у экрана карты). Грант эту карту не называет, поэтому
`full_report_chart_id = null` → приложение показывает цену, хотя сервер заказ
примет.

Второй, «денежный» конец этой же гипотезы: `POST /billing/invoice` для плана
`one_149` отвечал `201` и создавал счёт человеку, у которого право уже есть, —
потому что в биллинге стояла **своя** проверка `hasActiveReportGrant` (читала
`entitlements` и не знала ни про `single_report`, ни про «всё включено»).

### H6 — «оплата проверяется по `reports`/`payments`, а не через `hasAccess`». **Не подтвердилась**

`ReportsService.order` спрашивает дверь (`hasAccess(…, {consume: false})`) и
отдаёт `402 report_not_paid` при отказе. Другой вопрос, что дверь отвечала
неверно (H2). Вторая проверка была не в `reports`, а в биллинге (H5).

## Что сделано

1. **`EntitlementsService.getEntitlements`: «всё включено» включает разбор.**
   В ветку `allAccess` добавлен `fullReport: true`. `fullReportChartId` остаётся
   `null` осознанно: право не привязано к карте, «оплаченного» разбора нет, и
   подставлять туда последнюю карту было бы подлогом.
2. **`AccessService.reportAccess`: грант спрашивается до карты.**
   Действующий `all_access` (`getGrantEntitlements().allAccessUntil !== null`)
   открывает разбор **любой** карты. Проверка стоит перед веткой «оплачено
   конкретной карте», потому что грант карте не принадлежит.
3. **`ReportsService.settleGrantFor`: расход права по-настоящему.**
   Здесь стояла проверка `getEntitlements().fullReport`, которая в этот момент
   **всегда истинна**: `fullReport` включает «есть готовый разбор», а строка
   `ready` пишется прямо перед вызовом. Значит `single_report` не списывался
   никогда. Теперь пропуск только по двум настоящим причинам: разбор оплачен
   этой карте (`reportPaidFor`) или действует `all_access`. Тест, который это
   «проверял», был пустым: он ждал расхода и проверял `consumed_at`, не убедившись,
   что строка найдена (`undefined` проходил мимо `not.toBeNull`) — исправлено, в
   нём теперь `expect(grant).toBeDefined()`.
4. **`BillingService.createInvoice`: одна дверь вместо второго гейта.**
   `hasActiveReportGrant` удалён из `billing.repository.ts`; биллинг спрашивает
   `access.hasAccess(userId,'report',{chartId})`. Отказ — `422 VALIDATION_FAILED`
   с `details.reason = report_already_owned` (причина уже есть в контракте 1.6.16,
   новых кодов не вводим). Заодно исправлено, что `invalidFields` перезаписывал
   `details` и `details.reason` из ответа пропадал — ответ собирается явно, как у
   `compat_already_owned`.
5. **Активация кода стала одной транзакцией.** `AccessCodesService.activate`
   передаёт `client` в `GrantsService.issue`, а `issue` передаёт его в
   `BonusBudgetService.ensureAvailable` и `hasChart`. До этого `issue` открывал
   **свою** транзакцию: обещание «если выдача упадёт, ROLLBACK вернёт и счётчик, и
   строку активации» было неправдой, а на однопоточной сессии (PGlite) активация
   просто вешалась — из-за этого успешная активация и была «непроверяемой».
   Побочный эффект: `test/grants.spec.ts` (24 теста) теперь проходит.

Ни одного нового гейта не добавлено; удалён один (`hasActiveReportGrant`).

## Как проверял

Новый файл `apps/api/test/report-access-grants.spec.ts` — **38 тестов**:

| Блок | Что проверяет |
|---|---|
| матрица | 6 состояний × 5 фич = 30 тестов: чистый аккаунт, `all_access` активен, `all_access` истёк, `single_report`, `single_compat`, оплаченный готовый разбор. Ожидания — таблицей в самом тесте |
| `ask` | у бесплатного уровня `askPerDay = 1`, но `hasAccess('ask') = false`: дверь смотрит на `isActive`, а не на число |
| `single_report` | код → `hasAccess = true`, `consumed_at` пуст; успешный разбор → право израсходовано; вторая карта снова платная |
| провал | генерация упала → `consumed_at IS NULL`, право доступно |
| двойное право | `all_access` + `single_report` → разбор готов, у `single_report` `consumed_at` пуст, `singleReports = 1` |
| checkout | `single_report` и `all_access` → `422 report_already_owned`, в `invoices` и `payments` **ноль строк**; истёкшее `all_access` покупку не блокирует |

`test/report-single-grant.spec.ts` (4) — расход на `ready` теперь настоящий;
тест «подписчик с подарком подарок не теряет» заменён на «подписка разбор не
оплачивает: подарок тратится», потому что его предпосылка была неверной
(подписка разбор не включает), а зелёным он был из-за той же дыры.

`test/grants-access-guard.spec.ts` (+2) — закрытый список файлов, читающих
`payments`; запрет второго гейта в биллинге (`this.access.hasAccess(` обязателен,
`hasActiveReportGrant(` запрещён, `FROM entitlements` в `billing.service.ts`
запрещён).

Прогоны (PGlite, каждый файл отдельно):

| Файл | Тестов |
|---|---|
| `report-access-grants` (новый) | 38 ✅ |
| `report-single-grant` | 4 ✅ |
| `grants` | 24 ✅ (был красный/висящий) |
| `grants-access-guard` | 8 ✅ |
| `reports` | 18 ✅ |
| `pdf` | 17 ✅ |
| `me` | 19 ✅ |
| `questions` | 22 ✅ |
| `forecast-day` | 11 ✅ |
| `admin-ops` | 19 ✅ |
| `admin-support` | 25 ✅ |
| `contract-errors` | 15 ✅ |
| `ops-alerts` | 16 ✅ |
| `plan-test-only` | 9 ✅ |

`pnpm lint`, `pnpm typecheck` (включая `gen:contracts:check` и `gen:api:check` —
контракт не менялся, сгенерированные типы совпадают), `pnpm build` — чисто.

## Что проверять QA

1. **Код «всё включено».** Чистый аккаунт, карта, код на 14 дней →
   `GET /me`: `entitlements.is_active = true`, `all_access_until` в будущем,
   `full_report = true`, `full_report_chart_id = null`. `POST /reports` → `202`,
   `GET /reports/{id}` → `ready`. Кнопка покупки на экране разбора **всё ещё
   может показываться** — это клиент, см. «Контракт и клиент».
2. **Код «только разбор».** `POST /reports` → `202`; после `ready` →
   `SELECT consumed_at FROM grants` заполнен, `Me.entitlements.single_reports`
   стал `0`. Повторный заказ на **другой** карте → `402 report_not_paid`.
3. **Провал генерации.** Право остаётся: `consumed_at IS NULL`, повторный заказ
   проходит.
4. **Два права сразу.** `all_access` + `single_report` → после разбора
   `single_report.consumed_at IS NULL`, `single_reports = 1`.
5. **Попытка купить при праве.** `POST /billing/invoice {plan_code:"one_149",
   chart_id}` → `422`, `details.reason = report_already_owned`; в `invoices` и
   `payments` по этому человеку ничего не появилось.
6. **Бан сильнее права.** Забаненный с `all_access` → `hasAccess('report') =
   false` (проверка бана стоит первой, не менялась).

## Контракт и клиент

Контракт **не менялся**: `info.version` = `1.6.18`, новых полей и кодов нет,
`report_already_owned` переиспользован.

Просьба ТЗ была «`409 already_entitled`». Такой код потребовал бы правки
контракта (новый `reason`), а он в этой итерации заморожен — поэтому отказ отдаётся
существующей причиной `report_already_owned` (422). Если владелец хочет именно
`409` и отдельную причину — это отдельным решением по контракту, одна строка в
`Problem.details.reason` и один тест.

**Что осталось на клиенте (отдельный PR фронта, `apps/web` не трогал).**
Сервер уже отдаёт всё нужное: `Me.entitlements.all_access_until`,
`single_reports`, `full_report`. Но `hasReportFor` (`apps/web/src/lib/plans.ts`)
смотрит только на `full_report_chart_id`, поэтому грант не открывает кнопку.
Правка: «разбор доступен» = `full_report_chart_id === chartId` **или**
`all_access_until !== null` **или** `single_reports > 0`. Поля в контракте есть с
1.6.14 — новых не нужно.

## Отдельной строкой: какая гипотеза подтвердилась и чем именно

**H2 и H5 вместе.** H2: `getEntitlements` не поднимал `fullReport` для
`all_access` (`full_report: false` при `is_active: true` и действующем
`all_access_until`), а `reportAccess` не спрашивал грант вообще — отсюда
`402 report_not_paid` при активном праве. H5: `single_report` дверь видела
(`hasAccess = true`, заказ `202`), но клиент решает по `full_report_chart_id`,
которого у гранта нет.

## Отдельной строкой: почему `all_access` открывал совместимость, но не разбор

Потому что «всё включено» реализовано как **список поднятых флагов**, а не как
«все фичи». В этом списке было четыре пункта из пяти: `fullForecast`, `askPerDay`,
`compatPerMonth`, `solarIncluded`. Совместимость открылась именно потому, что её
флаг в списке был; разбора в списке не было — и `fullReport` остался `false`.
Дальше сработала вторая половина: разбор — единственная фича, которую дверь
проверяет не по флагу, а по источнику (оплата карты / одноразовое право), и грант
`all_access` в этой проверке не участвовал. То есть право работало ровно там, где
его читали через `getEntitlements`, и не работало там, где читали через
`reportAccess`.

## Отдельной строкой: что стало с уже активированным кодом на аккаунте A

Ничего не потеряно, повторная активация **не нужна**:

* `all_access` — право на месте (`starts_at`/`expires_at`, `consumed_at` пуст),
  достаточно выкатить правку: разбор откроется сам, срок не менялся;
* `single_report` — `consumed_at` пуст (расход не работал вообще), поэтому право
  тоже на месте. Если человек уже успел получить разбор по этому праву, он
  останется и право сохранится — то есть он получит на один бесплатный разбор
  больше, чем собирался. Это следствие дефекта №3, и отзывать право задним числом
  мы не будем: это подарок, а не выручка.

Если на каком-то аккаунте право всё же помечено израсходованным
(`consumed_at IS NOT NULL`) без готового разбора — выдать вручную, одним из двух
способов:

```bash
# 1) админский маршрут (тот же, что у панели; нужен ADMIN_TG_ID)
curl -sS -X POST "$API/api/v1/admin/grants" \
  -H "X-Telegram-Init-Data: <initData админа>" -H 'Content-Type: application/json' \
  -d '{"user_id":"<uuid>","kind":"single_report"}'
```

```sql
-- 2) одной строкой в базе (source='admin' — ручная выдача, бюджета не касается)
INSERT INTO grants (user_id, kind, source) VALUES ('<uuid>', 'single_report', 'admin');
```

## Данные владельца: нет ли ещё аккаунтов с той же картиной

Запрос «право потрачено, а разбора нет» (искать бессмысленно израсходованные
права):

```sql
SELECT g.user_id, g.id AS grant_id, g.consumed_at, g.created_at,
       (SELECT count(*)::int FROM reports r
         WHERE r.user_id = g.user_id AND r.kind = 'report' AND r.status = 'ready') AS ready_reports
  FROM grants g
 WHERE g.kind = 'single_report'
   AND g.consumed_at IS NOT NULL
   AND g.revoked_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM reports r
                    WHERE r.user_id = g.user_id AND r.kind = 'report' AND r.status = 'ready');
```

Результат на локальной базе разработки: **0 строк** (база пустая, к проду у меня
доступа нет — запрос надо выполнить владельцу).

Второй запрос — кто вообще был затронут (у кого есть право, но нет готового
разбора; эти люди как раз не пострадали, право цело):

```sql
SELECT g.user_id, g.kind, g.consumed_at, g.expires_at,
       (SELECT count(*)::int FROM reports r
         WHERE r.user_id = g.user_id AND r.kind = 'report' AND r.status = 'ready') AS ready_reports
  FROM grants g
 WHERE g.revoked_at IS NULL
   AND (g.kind = 'all_access'
        OR (g.kind = 'single_report' AND g.consumed_at IS NULL));
```

Поскольку расход `single_report` до этой правки не происходил никогда,
`consumed_at IS NOT NULL` в проде должно быть **пусто** — если там окажутся строки,
это данные из другой эпохи (ручная правка), и их стоит разобрать отдельно.

## Какие ещё места решают «доступно / платно»

Список, чтобы третий раз не искать:

| Место | Что решает |
|---|---|
| `apps/api/src/modules/entitlements/access.service.ts` | дверь: `hasAccess`, `reportAccess`, `compatAccess`, `reportPaidFor`, `consumeSingleReport`, `consumeSingleCompat`, `accessPeriod` |
| `apps/api/src/modules/entitlements/entitlements.service.ts` | `getEntitlements` (флаги для `/me` и `is_paid`), `getGrantEntitlements` (гранты), `fullReportChartId` |
| `apps/api/src/modules/entitlements/entitlements.dto.ts` | `Me.entitlements` — то, что реально видит клиент |
| `apps/api/src/modules/reports/reports.service.ts` | `order` (402), `view` (`is_paid`, главы), `settleGrantFor` (расход права) |
| `apps/api/src/modules/billing/billing.service.ts` | `createInvoice`: «надо ли платить» (теперь через дверь); `hasUnusedCompatGrant` — тот же второй гейт, но для совместимости |
| `apps/api/src/modules/pdf/pdf.service.ts` | право на PDF: `hasAccess('report', {chartId})` |
| `apps/api/src/modules/compat/compat.service.ts` + `compat-quota.ts` | окно «одна совместимость в 30 дней» и расход разового кредита |
| `apps/api/src/modules/daily/daily-forecast.service.ts`, `questions.service.ts` | `full_forecast`, `ask` |
| `packages/shared/src/quotas.ts` | `report_month` — производное от `fullReport` |
| `apps/web/src/lib/plans.ts` (`hasReportFor`, `grants`) + `apps/web/src/App.tsx` | **клиент**: «Открыть» или цена; читает `full_report_chart_id` |
| `apps/web/src/api/index.ts` | нормализация `Me.entitlements` (грантовые поля проходят как есть) |

## Не проверено

* **Прод-база.** Доступа нет: оба запроса из раздела «Данные владельца» надо
  выполнить владельцу. Утверждение «`consumed_at IS NOT NULL` в проде пусто»
  следует из кода, а не из выгрузки.
* **Клиент.** Правка кнопки — отдельный PR фронта (по ТЗ `apps/web` не трогаем).
  До неё симптом «кнопка предлагает покупку» остаётся видимым, хотя сервер заказ
  принимает, а платёж отклоняет.
* **`test/compat.spec.ts` целиком** под PGlite не доходит до конца: файл
  зависает/краснеет каскадом таймаутов (то же было до этой итерации — долг,
  известный с round41; отдельные тесты файла в изоляции зелёные). Поведение
  совместимости этой правкой не менялось.
* **`409 already_entitled`** не сделан: это правка контракта, см. «Контракт и
  клиент».
