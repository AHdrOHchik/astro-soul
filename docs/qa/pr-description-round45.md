# Итерация 45: `Me.report_access` и шесть блокеров деплоя (контракт 1.6.19, аддитивно)

## Что это

«Право на разбор» отдельным ответом + закрытие шести блокеров деплоя, найденных в
прошлой итерации. Симптом: `/me` и заказ разбора отвечают на один вопрос
по-разному — потому что считают его в двух местах (`entitlements.full_report` и
дверь `AccessService`).

## Контракт

`api.openapi.yaml`: `info.version` **1.6.18 → 1.6.19**, только аддитивно.

* `Me.report_access` — **необязательное** поле → схема `ReportAccess`
  (`available`, `source`, `expires_at`, `chart_id`);
* `source`: `purchased` → `all_access` → `single_report` (порядок зафиксирован
  тестом), `null` — доступа нет;
* `full_report` уточнён и больше **не** решает доступ: это «есть оплаченный или
  готовый разбор», без «всё включено» и без подарков;
* новых кодов `Problem.code` нет; новая машинная причина одна — `banned`
  (`403` на `POST /billing/invoice`);
* миграций нет; форма существующих полей не менялась;
  `MAX_ATTEMPTS`, цены и брейкеры не тронуты;
* снапшоты перегенерированы (`packages/shared`, `apps/web`, `apps/admin`),
  `FALLBACK_CONTRACT_VERSION` панели → `1.6.19`.

## Состояние → ответ (проверено тестом на каждую строку)

| Состояние | `available` / `source` | `POST /reports` | `POST /billing/invoice` |
|---|---|---|---|
| оплачено на эту карту | `true` / `purchased` | `202` | `422 report_already_owned`, 0 строк в `invoices`/`payments` |
| оплачено на другую карту | `false` / `null` | `402` | `201` |
| «всё включено» | `true` / `all_access` | `202` | `422 report_already_owned`, 0 строк |
| подаренный разбор | `true` / `single_report` | `202` | `422 report_already_owned`, 0 строк |
| «всё включено» истекло | `false` / `null` | `402` | `201` |
| ничего | `false` / `null` | `402` | `201` |
| забанен | `false` / `null` | `403` | `403 banned`, 0 строк |

## Что изменено

**Доступ**

* `AccessService.reportAccess()` — единственное решение: покупка карты →
  «всё включено» → подаренный разбор. `hasAccess('report')` делегирует ей,
  `single_report` списывается только когда это единственный источник.
* `Me.report_access` собирается `toReportAccessDto` (одно место, страж в тестах).
* `POST /reports`, `GET /reports/{id}` (`is_paid`/`pdf_url`) и биллинг спрашивают
  ту же функцию.
* `getEntitlements().fullReport` больше не участвует в решении доступа.

**Платёжный путь**

* `invalidFields` не затирает `details`: `details.reason` у `422` биллинга снова
  доезжает до клиента, как обещает контракт.
* Забаненный не может создать счёт (`403 banned`).

**Блокеры деплоя**

* **Б-4** — секрет вебхука не попадает в логи: nginx (`map $uri $uri_logged`),
  access-лог API (`requestPath`), логи переустановки, аудит админки; одна маска
  (`common/secret-url.ts`) + `url`-ключи в `FORBIDDEN_KEYS`.
* **Б-1** — `VITE_NOTIFICATIONS_UI` доезжает до сборки web (`ARG` → `pnpm build`,
  `build.args` compose, `.env.example`).
* **Б-3** — `BACKUP_DUMP_MODE=host|exec`: на проде порт Postgres не опубликован,
  поэтому дамп делается внутри контейнера.
* **Б-2** — образ админки: `docker/admin.Dockerfile`, сервис `admin` в compose
  (профиль `admin`, порт только `127.0.0.1`), джоба CI `admin-image`, публикация в
  GHCR релизом.
* **Б-6** — `infra/cron.md`: строка cron для бэкапа и проверка.
* **Б-7** — `docs/DEPLOY.md`: таблица build-time vs runtime.
* **GHCR в нижнем регистре и на деплое**: `remote-release.sh` нормализует
  владельца (`${OWNER_RAW,,}`). Сборку владелец уже починил в `main`
  (`08b9255`), а деплой искал образ по `ghcr.io/AHdrOHchik/…` — то есть по имени,
  которого не существует. Ветка перебазирована на `a5ecad6`, конфликт в
  `release.yml` решён в стиле владельца (шаг `img`, admin добавлен туда же).
* **Б-5/Б-8** — в репозитории не тронуты, записаны как задачи деплоя.

## Тесты

Новые: `me-report-access.spec.ts` (18), `report-access-guard.spec.ts` (5),
`webhook-secret-leak.spec.ts` (9), `web-build-flags.spec.ts` (5),
`deploy-admin-image.spec.ts` (5), `deploy-ghcr-lowercase.spec.ts` (3),
`db-dump-script.spec.ts` +5.

Прогон после ребейза на `a5ecad6`: API 80 файлов / 1135 тестов, shared 31, ui 39,
web 984, admin 248, astro 118; `eslint --max-warnings=0` и `tsc` — 0.

Три теста, которые были «зелёными по ложной посылке» (подробно — в отчёте
`docs/qa/reports/round45-report-access.md` §6): страж, проверявший **имя** метода
двери вместо факта обращения к ней; подпись версии контракта в панели; и
`chart_required_for_report`, который контракт обещал, а `invalidFields` затирал.

## Не проверено

* Сборка образа админки локально — в песочнице агента нет Docker. Проверено
  CI: прогон `45437135315`, джоба `admin-image` (сборка образа + запуск
  контейнера + заголовки, 27 с) — зелёная вместе с основным `check` (12 мин 54 с);
  после ребейза на `a5ecad6` то же самое в прогоне `45443957795` (`admin-image`
  28 с, `check` 10 мин 19 с).
* `BACKUP_DUMP_MODE=exec` на настоящем Docker — в тестах `docker` заглушка.
* Клиент (`apps/web`/`apps/admin` по существу) не менялся: витрина старого
  клиента при `available: true` и `full_report: false` покажет цену — исправление
  в клиентском PR (§4 отчёта).

## Чек-лист

- [x] Контракт поднят и описан (1.6.19, аддитивно), снапшоты перегенерированы
- [x] Нет миграций, нет новых кодов ошибок, цены/`MAX_ATTEMPTS`/брейкеры не тронуты
- [x] `apps/web`/`apps/admin` не тронуты, кроме версии контракта в подписи панели
- [x] Тесты: 18 новых на матрицу состояний + стражи
- [x] CI: `check` (12 мин 54 с) и `admin-image` (27 с) — зелёные, прогон `45437135315`;
      после ребейза — прогон `45443957795` (`check` 10 мин 19 с, `admin-image` 28 с)
- [ ] Мерж — только по команде владельца
