# QA-002 — как воспроизвести

Всё, что нужно, чтобы повторить отчёт `qa-002-acceptance.md` с нуля.

> **Принимается PR #20, а не `main`.** Исправления после 001 лежат в ветке
> `arena/12b48f91-astro-soul` (PR #20, контракт 1.5.2). В `main` на момент приёмки их нет:
> прогон по `main` даёт «ничего не исправлено» и к приёмке отношения не имеет. Поэтому стенд
> разворачивается из отдельного worktree, а харнессу указывается `QA_REPO`. Ни одна
> команда не требует боевого токена: Bot API — собственный стаб, платёж
> настоящими звёздами не производится (запрет владельца).

## 1. Стенд

```bash
# дерево PR #20 отдельно: приёмка идёт по нему, а не по main
git worktree add /tmp/pr20 origin/pr20
cd /tmp/pr20 && pnpm install --frozen-lockfile && pnpm build
# Postgres (в песочнице — через pgserver, в обычном окружении — обычный сервер)
pg_ctl -D /tmp/pgdata2 -l /tmp/pg2out.log start   # запускается из дерева стенда
export LD_LIBRARY_PATH=/tmp/qa-venv/lib/python3.11/site-packages/pgserver/pginstall/lib

npm install -g pnpm@9.12.3
createdb astro_pr20
pnpm --filter @astro-soul/api run db:migrate && pnpm --filter @astro-soul/api run db:seed   # 12 миграций, 6 планов

# астро-сайдкар
cd packages/astro && ASTRO_ENGINE=fallback uvicorn astro.service:app --port 8001

# стаб Bot API (журналирует каждый вызов) — запускается из дерева с e2e/qa
node e2e/qa/bot-stub.mjs 8091

# API
set -a; . /tmp/pr20.env; set +a                   # DATABASE_URL на astro_pr20, PORT=8082
node apps/api/dist/main.js                       # :8082
curl -s localhost:8082/api/v1/health             # db:ok astro:ok
```

Переменные стенда (`/tmp/qa2.env`) — тестовые, не боевые:
`PSEUDONYM_PEPPER`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_JOB_SECRET`,
`ADMIN_TG_ID`, `GEO_PROVIDER=bundled`, `ASTRO_ENGINE=fallback`.
**Токен бота** берётся из блока владельца (`TEST_BOT_TOKEN`) и передаётся только
через переменную окружения стенда — в репозиторий и в отчёт он не попадает.

> Важно: `QA_PEPPER` в харнессе должен **совпадать с `PSEUDONYM_PEPPER` стенда**,
> иначе `user_id` вычисляется другой, и `DELETE /me` выглядит как «прошёл, хотя
> не должен». Именно на этом расхождении в ходе приёмки был получен ложный
> результат «204 вместо 409»; после сверки переменных `dp1` даёт 409, как и
> должен. Значение по умолчанию в харнессе — заглушка, для стенда его надо
> переопределить.

## 2. Переменные для харнесса

```bash
export QA_PSQL=<pgbin>/psql QA_DB=astro_pr20
export QA_API=http://127.0.0.1:8082/api/v1
export QA_REPO=/tmp/pr20          # из какого дерева поднимать контекст для support-refund.ts
export QA_ENV_FILE=/tmp/pr20.env  # те же переменные, что у API стенда
export QA_BOT_TOKEN=<TEST_BOT_TOKEN владельца>
export QA_PEPPER=<PSEUDONYM_PEPPER стенда>
export QA_WEBHOOK_SECRET=<TELEGRAM_WEBHOOK_SECRET стенда>
export QA_JOBS_SECRET=<INTERNAL_JOB_SECRET стенда>
```

## 3. Прогоны

| Команда | Что проверяет | Раздел отчёта |
|---|---|---|
| `node e2e/qa/acceptance-002.mjs all` | M11, M11b, M11c, DP1, DP2, V1–V7, платёж после удаления, контракт, `unknown`/гео, R-1, CR1 | §3–§9 |
| `node e2e/qa/acceptance-002.mjs m11` | платёж без инвойса за 1 ⭐ | QA-11 |
| `node e2e/qa/acceptance-002.mjs m11b` | чужой инвойс | QA-11b |
| `node e2e/qa/acceptance-002.mjs m11c` | сумма больше цены | QA-11c |
| `node e2e/qa/acceptance-002.mjs dp1` | `DELETE /me` при зависшем платеже (закрыт: 204 после разрешения) | QA-14, QA-21 |
| `node e2e/qa/acceptance-002.mjs dp2` | джоб → `DELETE /me` | DP2 |
| `node e2e/qa/acceptance-002.mjs vectors` | семь векторов, V5 — через `support-refund.ts` | §5 |
| `node e2e/qa/acceptance-002.mjs delete-then-pay` | оба порядка «удаление → оплата» — **единственный блокер 002** | §6, QA-15 |
| `node e2e/qa/acceptance-002.mjs contract` | `occurred_at`, серверные события, `Me`, `X-Request-Id` | §8 |
| `node e2e/qa/acceptance-002.mjs report` | `unknown` без домов/ASC, колесо, гео | §9 |
| `node e2e/qa/acceptance-002.mjs r1` | три оплаты подряд | R-1 |
| `node e2e/qa/acceptance-002.mjs cr1` | три параллельных прогона джоба | CR1 |
| `node e2e/qa/client-access-audit.mjs` | решения о доступе на клиенте, обещания в текстах | §7 |
| `node e2e/qa/rubric-check.mjs` | антипримеры §3.1–3.5 против рубрики | §9 |
| `cd apps/web && pnpm exec vitest run --config ../../e2e/qa/vitest.config.ts` | jsdom: экран ошибки и пейволл | §7, QA-19, QA-20 |
| `cd apps/web && pnpm run gen:api:check` | отставание сгенерированных типов | §8 |

## 4. Тесты UI вне тестов фронта

`e2e/qa/vitest.config.ts` — единственный конфиг для этих проверок. Он живёт в
`e2e/qa/`, `apps/web/vitest.config.ts` не тронут (у фронта свои тесты, AGENTS.md §0).
`root` указывает на `apps/web` (там `node_modules` и setup-файл), `include` — на
`../../e2e/qa/**/*.qa.test.*`, поэтому файлы остаются в `e2e/qa/`.
`resolve.alias` — не косметика: без явных путей Vite из `e2e/qa` не находит
`react/jsx-dev-runtime` и `@testing-library/react`.

Два файла:
- `error-states.qa.test.tsx` — шесть состояний экрана ошибки. **Один тест красный
  намеренно**: он фиксирует находку QA-19 (на 409 нет пути решения). Пока
  находка не исправлена, красный тест — это доказательство, а не поломка стенда.
- `paywall.qa.test.tsx` — три состояния тизера, все зелёные.

## 5. Чего делать нельзя

- Платить настоящими звёздами (149 ⭐) — прямой запрет владельца.
- Трогать боевой токен бота. Только `TEST_BOT_TOKEN` стенда.
- Использовать реальные данные рождения. Все фикстуры в харнессе вымышленные.
- Править прод-код: приёмка теряет независимость (AGENTS.md §0). Писать можно
  только в `e2e/`, `docs/qa/`, `tests/qa-*`.
