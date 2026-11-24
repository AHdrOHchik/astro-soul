Итерация 44: «грант на разбор не открывает разбор». Сначала диагностика на реальной базе, потом правка — только того, что доказано.

**Контракт не менялся: 1.6.18** (`api.openapi.yaml`, сгенерированные типы и версия те же). Миграций нет — дефект в коде, данные в порядке. Цены, `plans`, `MAX_ATTEMPTS`, брейкеры, `REFUND_ON_REPORT_FAILED` не тронуты. Новых гейтов не добавлено; один удалён.

## Что показала диагностика

Аккаунт A, чистый, карта, код «всё включено» на 14 дней, через настоящий `POST /charts` и `AccessCodesService.activate`:

```
grants:   [{kind: "all_access", source: "partner", starts_at: 2026-11-24T11:48:56.735Z,
            expires_at: 2026-12-08T11:48:56.735Z, consumed_at: null}]
/me:      is_active true, all_access_until 2026-12-08T11:48:56.735Z,
          full_forecast true, ask_per_day 5, compat_per_month 1, solar_included true,
          full_report FALSE, full_report_chart_id null, single_reports 0
hasAccess full_forecast true, ask true, report FALSE, compat true, solar true
POST /reports          402 PAYMENT_REQUIRED, reason report_not_paid
POST /billing/invoice  201, счёт создан; payments: 0
```

Второй код (`single_report`) активировался и **сервер его видел**: `/me.single_reports = 1`, `hasAccess('report') = true`, `POST /reports → 202`. То есть «код не сработал» — не про бэкенд.

Гипотезы по очереди: H1 (дверь не видит `single_report`) — нет; **H2 (`all_access` не включает `report`) — да**; H3 (право списывается при активации) — нет, наоборот; H4 (код с другим `kind`) — нет; **H5 (две двери, клиент смотрит на другое поле) — да**; H6 (оплата мимо `hasAccess`) — нет.

## Правки

1. **«Всё включено» включает разбор.** В ветку `all_access` в `getEntitlements` добавлен `fullReport: true` — флагов было четыре из пяти; совместимость открывалась ровно потому, что её флаг в списке был. `fullReportChartId` остаётся `null`: право не привязано к карте.
2. **`access.reportAccess` спрашивает грант до карты.** Действующий `all_access` открывает разбор **любой** карты; раньше эта ветка смотрела только оплату карты и `single_report`.
3. **`settleGrantFor` расходует право по-настоящему.** Прежняя проверка `getEntitlements().fullReport` была всегда истинной: `fullReport` включает «есть готовый разбор», а строка `ready` пишется прямо перед вызовом. `single_report` не списывался **никогда** — один подарок давал бесконечные бесплатные разборы.
4. **Второй гейт в биллинге удалён.** `hasActiveReportGrant` (читал `entitlements`, не знал ни про `single_report`, ни про `all_access`) заменён на `AccessService.hasAccess(userId,'report',{chartId})`. Отказ — `422 VALIDATION_FAILED`, `details.reason = report_already_owned`, счёт и платёж не создаются. Попутно: `invalidFields` перезаписывал `details` и `reason` из ответа пропадал — ответ собирается явно, как у `compat_already_owned`.
5. **Активация кода — одна транзакция.** `PoolClient` протянут в `GrantsService.issue` → `BonusBudgetService.ensureAvailable` / `hasChart` / `state`. Раньше `issue` открывал свою транзакцию, и обещание «ROLLBACK вернёт и счётчик, и активацию» было неправдой; на однопоточной сессии активация просто вешалась — поэтому успешная активация и была «непроверяемой».

## Тесты

- `report-access-grants.spec.ts` (**новый, 38**): матрица 6 состояний × 5 фич (чистый, `all_access` активен/истёк, `single_report`, `single_compat`, оплаченный готовый разбор), активация → `hasAccess` → `ready` расходует право → вторая карта платная, провал не тратит право, двойное право тратит `all_access`, checkout при праве → `422` и **ноль строк** в `invoices`/`payments`.
- `report-single-grant.spec.ts` (**4**): тест «подписчик с подарком подарок не теряет» был зелёным по неверной причине (расхода не было никогда) и с неверной предпосылкой (подписка разбор не включает) — заменён на «подписка разбор не оплачивает: подарок тратится».
- `grants-access-guard.spec.ts` (**+2**): закрытый список файлов, читающих `payments`; запрет второго гейта в биллинге.
- `grants.spec.ts` (**24**) впервые зелёный — следствие правки транзакций.

Прогоны на PGlite (каждый файл отдельно): `report-access-grants` 38, `report-single-grant` 4, `grants` 24, `grants-access-guard` 8, `reports` 18, `pdf` 17, `me` 19, `questions` 22, `forecast-day` 11, `admin-ops` 19, `admin-support` 25, `contract-errors` 15, `ops-alerts` 16, `plan-test-only` 9 — всё зелёное. `pnpm lint`, `pnpm typecheck` (включая `gen:contracts:check`/`gen:api:check`), `pnpm build` — чисто.

## Что осталось

- **Фронт** (`apps/web`, по ТЗ не трогаю): `/me` уже отдаёт `all_access_until` и `single_reports`, но `hasReportFor` (`apps/web/src/lib/plans.ts`) смотрит только на `full_report_chart_id` — поэтому кнопка покупки видна, хотя сервер заказ примет, а платёж отклонит. Правка — отдельный PR фронта: «доступен» = `full_report_chart_id === chartId` **или** `all_access_until !== null` **или** `single_reports > 0`.
- **`409 already_entitled`** не сделан: это правка контракта, а он в этой итерации заморожен. Отдаём существующее `report_already_owned` (422).
- **Прод-данные**: приложены два запроса (право израсходовано без разбора; кто вообще затронут) и однострочник на ручную выдачу (`POST /admin/grants` либо `INSERT INTO grants (user_id, kind, source) VALUES (…, 'admin')`). Выполнить их должен владелец — доступа к проду у меня нет.

Полный отчёт с шестью разделами, значениями диагностики и списком **всех** мест, решающих «доступно / платно»: `docs/qa/reports/round44-report-grant.md`.
