# QA-16 — разбор, который не собирался: фокусы, форма, коды, возврат

Живой прогон **2026-11-16** на тестовом тарифе: главы `core` и `emotions`
легли в базу, `talents` провалила валидаторы дважды, разбор ушёл в
`status: failed`, `error_code: validation`.

```
attempt 1: paragraphs: 1 вне 3–6; paragraph_sentences: абзац 1: 7 предл. вне 2–4
attempt 2: paragraphs: 2 вне 3–6
```

## 1. Причина — вход, а не валидатор

План возвращал **семь** фокусов, и каждая глава получала **все семь**
(`focusBlock()` рендерил `plan.focuses` целиком). Глава — 950–1 200 знаков и
3–6 абзацев по 2–4 предложения. Семь тем в этот объём не помещаются, и
единственный выход, который находила модель, — один плотный абзац. Валидатор
поймал симптом; лечить надо было вход.

## 2. Что изменено

| Что | Где |
|---|---|
| Раскладка «фактор → глава», ≤3 фокуса на главу | `apps/api/src/modules/reports/focus-map.ts:90` (`chaptersForFactor`), `:111` (`focusesForSection`), `:21` (`MAX_FOCUSES_PER_CHAPTER`) |
| В промпт главы идёт только её доля фокусов | `apps/api/src/modules/reports/reports.service.ts:491` (`focusBlock(plan, key)`) |
| Форма текста в промпте главы (v1.3, дословно) | `apps/api/src/modules/reports/prompts.ts:65` (`CHAPTER_FORM`), в шаблоне — `:136` |
| Запрет терминов в первых 400 знаках `core` | `apps/api/src/modules/reports/prompts.ts` (`SECTION_RULES.core`) + предупреждение `teaser_terms` в `validators.ts:93` |
| Версия промптов — одна константа | `apps/api/src/modules/reports/prompts.ts:17` (`PROMPT_VERSION = 'prompts_v1.3'`) |
| Сырой ответ модели на провал | `report_section_invalid` в лог, `reports.debug_json` (миграция `0022`), `RAW_EXCERPT_LENGTH = 2 000` — `reports.service.ts:107`, запись `:633` |
| Шесть кодов провала | `validators.ts:350` (`failureCategory`), `:372` (`failureErrorCodeForCategories`) |
| `too_short` / `too_long` вместо `length` | `validators.ts:419` |
| Предохранитель: 3 провала подряд → 503 | `reports.service.ts:110` (порог), `:252` (`assertPipelineHealthy`) |
| Автовозврат за провал выключен флагом | `apps/api/src/modules/ops/jobs.service.ts:256` (`refundFailedReports`), гейт `:266`; флаг — `apps/api/src/config/env.ts:177` |
| Контракт 1.5.10 | `api.openapi.yaml` (503 на `POST /reports`, `refunded`, changelog) |

## 3. Прогон

Стенд: PostgreSQL 18 (npm-бинарники `embedded-postgres`, те же миграции 0001–0022),
API на `tsx src/main.ts`, карта — `apps/api/test/fixtures/measure-chart.json`
(та же тестовая карта, что в `docs/llm-test/README.md`), провайдер —
`LLM_FAKE=1` (ключа GigaChat в песочнице нет).

**Главы: 7/7 `ok`, `status: ready`, `validation: []`, `debug_json: null`.**

| Глава | Знаков | Абзацев |
|---|---|---|
| core | 1 262 | 5 |
| emotions | 1 099 | 4 |
| talents | 1 053 | **4** |
| relations | 1 123 | 4 |
| money | 1 193 | 5 |
| purpose | 1 057 | 4 |
| summary | 606 | 3 |

`talents`: 4 абзаца, предложений по абзацам — **[3, 3, 3, 2]** (было 1 абзац
на 7 предложений).

**Тизер:** первые 400 знаков `core` (и `teaser` из API) — ни одного термина:
`teaserTerms()` вернул `[]`. Глазами: «Ты не любишь показывать, сколько
решения…» — планет, знаков, домов, аспектов, стихий и крестов нет.

**Токены (подставной провайдер, по 800 вход / 200 выход на вызов):** по главам
— 800/200 каждая, план — 800/200; суммарно в БД `llm_tokens_in = 6 400`,
`llm_tokens_out = 1 600`, `attempts = 8`. `cost_rub = 0`: подставной провайдер
бесплатный, это записано в лог `llm_fake_provider`. При цене **0,5 ₽ / 1 000
токенов** те же 8 000 токенов стоили бы **4,0 ₽** (по 0,5 ₽ на вызов), но это
арифметика на подставных числах, а не измерение.

**`prompt_version` в БД:** `prompts_v1.3` — совпадает с `PROMPT_VERSION`.

**Провал на стенде** (отдельная проверка, глава с одним абзацем): `error_code =
validation:paragraphs`, в `debug_json` две записи с `attempt: 1, 2`,
`key: "core"`, `raw` ≤ 2 000 знаков, `cats: ["paragraphs"]`; `attempts = 3`
(план + две попытки, третьей нет).

**Автовозврат:** джоб `report_refund` при выключенном флаге вернул
`report_refunds_done: 0`, в лог ушло `report_refund_disabled`,
`{"failed":1,"flag":"REFUND_ON_REPORT_FAILED"}`, строка осталась `failed`.
С флагом `REFUND_ON_REPORT_FAILED=1` возврат работает (тест
`ops.spec.ts` + `reports.spec.ts`).

**Предохранитель:** после трёх `validation`-провалов подряд `POST /reports`
вернул `503` `UPSTREAM_LLM` с `details.reason: validation_breaker`, новой
строки в `reports` не появилось.

## 4. Чего прогон не показал

- **Реальный GigaChat 3 Ultra не запускался**: в песочнице нет
  `GIGACHAT_AUTH_KEY`. Все числа по токенам и стоимости выше — от
  подставного провайдера; поведение модели на новом промпте (уложит ли она
  семь тем в 1–2 фокуса на главу, не вернутся ли термины в тизер) на живой
  модели **не проверено**.
- Живой прогон 2026-11-16 шёл на карте пользователя; здесь — на тестовой
  карте из фикстур, поэтому сравнение «до/после» по одной и той же карте
  ограничено структурой, а не содержанием.

## 5. Расхождение с пользовательским текстом (не правил)

`apps/web/src/i18n/ru.ts:311`: «Если товар не был предоставлен из-за
технической ошибки, звёзды возвращаются автоматически». Это обещание
автовозврата, а решением владельца от 2026-11-16 автовозврат за провал
выключен. Текст юридический (`legal.md` §4 п.5) — не тронут; решать владельцу:
переписать обещание или включать `REFUND_ON_REPORT_FAILED=1`.

## 6. Тесты

1 120 → **1 142** (api 300 → 322). Новые: `report-pipeline-v13.spec.ts` (5),
`report-prompt-v13.spec.ts` (8), блок «коды провала и тизер» в
`report-validators.spec.ts` (4), плюс обновлённые `reports.spec.ts`,
`ops.spec.ts`, `chart-facts-budget.spec.ts`, `report-validators.spec.ts`.
