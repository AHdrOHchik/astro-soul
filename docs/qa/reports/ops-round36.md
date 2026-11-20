# Итерация 36 — прод-гард, наблюдаемость, эксплуатационная готовность

Контракт **1.6.10 → 1.6.11** (бамп аддитивный: ни одно существующее поле и ни
одно `required` не изменены; версия поднята потому, что появились новые
маршруты — `/admin/alerts`, `POST /me/notifications`, — а не только поля).

Прогон: Postgres 5433 (`astro_soul_test`), API-тесты 58 файлов / 697,
web 45 / 900, astro 90 (pytest), `pnpm lint` / `typecheck` / `build` — зелёные.

---

## 1. Что сделано

### Задача 1 — прод-гард на старте (блокер Б-5)

`apps/api/src/modules/ops/prod-guard.service.ts` + вызов в `main.ts` **до**
`listen`. В `NODE_ENV=production` отказ старта, если:

| Код нарушения | Условие | Как чинится |
|---|---|---|
| `test_plans_flag` | `PAYMENTS_TEST_PLANS=1` | убрать переменную из прод-окружения |
| `test_plan_rows` | в `plans` есть `test_only AND is_active` | `UPDATE plans SET is_active = false WHERE code = …` или удалить строки |
| `report_breaker_off` | `REPORT_BREAKER_ENABLED=0` | вернуть `1` |
| `compat_breaker_off` | `COMPAT_BREAKER_ENABLED=0` | вернуть `1` |

Отказ печатает нумерованный список «проблема → исправление» с именами строк
таблицы (`test_1`, `test_report_1`), затем `app.close()` и `process.exit(1)`.
Вне прода гард не проверяет ничего.

### Задача 2 — `/health` для мониторинга и `GET /admin/alerts`

`GET /health` (аддитивно): `status: ok|degraded`, `db`, `llm`, `astro`,
`telegram_webhook`, **`flags: {test_plans, report_breaker}`**,
**`checked_at`**. `degraded` — если `db != ok`, `astro != ok` или
`telegram_webhook != ok`. Коды: **200** при `degraded`, **503** только при
`db: down` (описано в схеме).

`GET /admin/alerts` (только `ADMIN_TG_ID`, иначе `403`) отдаёт шесть правил
`{id, level, value, threshold, since, fired}`:

| `id` | уровень | порог | единица `value` |
|---|---|---|---|
| `payment_not_arriving` | critical | 0 | штук за 24 ч |
| `telegram_webhook` | critical | 10 | минут не в порядке |
| `subscription_cancel_blocked` | critical | 0 | штук за 24 ч |
| `llm_spend` | warning | 500 | ₽ за 24 ч |
| `generations_failing` | warning | 5 | штук за 24 ч |
| `backup_stale` | warning | 36 | часов с последнего успеха |

Ничего не хранится: значения считаются из тех же таблиц/событий, что
`/admin/metrics` (+ время проверки вебхука и mtime маркера бэкапа). В
`/admin/metrics` добавлена `compat_cost_rub_24h` — третий источник трат LLM.

### Задача 3 — бэкап вне сервера

`scripts/db-dump.sh`: `pg_dump -Fc` → `.<имя>.partial` → атомарное
переименование в `astro-soul-YYYYMMDDTHHMMSSZ.dump` → выгрузка (`aws s3 cp`
или `scp`) → **после выгрузки** перезапись `BACKUP_STATE_FILE` → ротация
локальных копий старше 7 дней. Коды выхода: 2 конфиг, 3 место, 4 `pg_dump`,
5 выгрузка, 6 маркер. При ошибке выгрузки локальный файл удаляется.

Операционная инструкция — `docs/BACKUP.md` (запуск, переменные, размер,
диагностика по кодам, восстановление — **не проверено**).

### Задача 4 — подготовка пуша 08:00

Миграция `0031_push_log.sql`: `push_log (user_id, local_date, kind, sent_at,
error)`, уникальный ключ `(user_id, local_date, kind)`, каскад по `users`;
`users.push_enabled boolean not null default true`. Контракт:
`Me.notifications {daily_forecast}` + `POST /me/notifications`, тело заменяет
состояние целиком. Самого пуша нет: в `EngagementService.runPush` стоит
пометка `// round37`.

---

## 2. Тесты

| Задача | Файл | Тестов | Что доказывает |
|---|---|---|---|
| 1 | `test/prod-guard-startup.spec.ts` | 6 | прод + `test_only` падает, dev не падает, `PAYMENTS_TEST_PLANS=1` падает, сообщение содержит код строки, три флага сразу, `report()` |
| 1 | `test/prod-guard.spec.ts` (существовал) | 9 | `check.sh --prod` не сломан |
| 2 | `test/ops-alerts.spec.ts` | 16 | каждое правило на пороге и ниже, `since` = первое превышение, `value: null` у вебхука/бэкапа, `/admin/alerts` 200 и 403, `/health` 200 при `degraded` и 503 при `db: down` |
| 3 | `test/db-dump-script.spec.ts` | 10 | успешный дамп + выгрузка + маркер, ротация 7 дней, `scp`-путь, отказ выгрузки → код 5 без файла и маркера, `pg_dump` упал → код 4 без файла, нет места → 3, нет выгрузки → 2, нет `DATABASE_URL`/`pg_dump` → 2 |
| 4 | `test/me-notifications.spec.ts` | 13 | умолчание `true`, сохранение и чтение, `422` для пропуска/строки/лишнего ключа, `401` без initData, `DELETE /me` стирает согласие, `push_log` не даёт второй пуш за сутки, каскад удаления |

Итого API: **58 файлов / 697 тестов** (было 54 / 652). Web 900, astro 90.

---

## 3. Контракт (1.6.11, аддитивно)

- `GET /health`: добавлены `flags`, `checked_at`; `status` расширен смыслом
  (включает вебхук); описаны коды 200/503. В `required` ничего не добавлено.
- `GET /admin/alerts` — новый маршрут (internal), схемы `AlertsResponse`,
  `Alert`.
- `Me.notifications` (`Notifications`) — новое поле, **не** в `required`.
- `POST /me/notifications` — новый маршрут профиля.
- `POST /me/notifications` 422 описан: пропущенное поле / не boolean / лишний
  ключ (поле в `field_errors` = имя ключа).
- `/admin/metrics`: `compat_cost_rub_24h`.
- `gen:contracts:check` и `gen:api:check` — без расхождений; фронт получает
  `Me.notifications?` в `schema.gen.d.ts` и не обязан его читать.

---

## 4. Миграции и данные

`migrations/0031_push_log.sql` (новая, единственная):

- `users.push_enabled boolean not null default true` — существующие
  пользователи получают `true` (согласие считается данным по умолчанию; пуш
  всё равно появится только в итерации 37);
- `push_log` — новый журнал, каскад по `users`, уникальность
  `(user_id, local_date, kind)`, индекс по `sent_at`;
- `IF NOT EXISTS` — файл можно накатить повторно на стенде, где его применяли
  вручную.

Данные не переписываются, `UPDATE` в миграции нет. `DELETE /me` теперь
каскадом удаляет `push_log` (проверено тестом).

---

## 5. Что проверять QA

### 5.1. Прод-гард действительно не пускает

```bash
# 1. Окружение как в проде, но с флагом тестовых тарифов
NODE_ENV=production PAYMENTS_TEST_PLANS=1 REPORT_BREAKER_ENABLED=1 \
DATABASE_URL=... TELEGRAM_BOT_TOKEN=... PSEUDONYM_PEPPER=... \
pnpm --filter @astro-soul/api run start
echo "exit=$?"      # ожидается 1

# 2. Только строка в БД (флаг выключен) — виноват именно тариф
psql "$DATABASE_URL" -c "UPDATE plans SET test_only = true WHERE code = 'test_1';"
NODE_ENV=production PAYMENTS_TEST_PLANS=0 ... pnpm --filter @astro-soul/api run start
# ожидается: сообщение с «test_1» и подсказкой UPDATE ... / DELETE, exit=1

# 3. Убрать строку — процесс стартует
psql "$DATABASE_URL" -c "DELETE FROM plans WHERE code = 'test_1';"
# ожидается: старт без отказа, в логе нет prod_guard_failed
```

Сообщение обязано называть строку: «есть тестовые тарифы» без `code` —
недостаточно. В dev (`NODE_ENV` не `production`) гард молчит при тех же
переменных.

### 5.2. Алерт видно в `/admin/alerts`

```bash
# initData админа (ADMIN_TG_ID) — как обычно для /admin/metrics
curl -s -H "X-Telegram-Init-Data: $ADMIN_INIT_DATA" https://<host>/api/v1/admin/alerts | jq
```

1. У API нет `BACKUP_STATE_FILE` (или файла нет) → в ответе
   `backup_stale: {value: null, threshold: 36, fired: true}`: «не знаем» —
   это срабатывание.
2. `touch "$BACKUP_STATE_FILE"` → `fired: false`, `value` растёт.
3. `touch -d '40 hours ago' "$BACKUP_STATE_FILE"` → `fired: true`,
   `value ≈ 40`, `since` = «последний успех + 36 ч» (≈ 4 часа назад).
4. Вебхук: перезапустить API с неразрешимым `MINI_APP_URL`
   (`https://webhook-does-not-exist.invalid`) и вызвать любую диагностику
   вебхука → в `/admin/alerts` `telegram_webhook.fired: true`,
   `value > 10`; в `/health` — `status: degraded`, `telegram_webhook:
   unreachable`, HTTP **200**.
5. `curl -o /dev/null -w '%{http_code}' .../api/v1/health` при остановленной
   БД → **503**, тело той же формы, `db: down`.

Порог расхода LLM проверяется только тестом: гонять 500 ₽ трафика на стенде
незачем.

### 5.3. Дамп лежит вне сервера

```bash
export DATABASE_URL='postgres://…/astro_soul'
export BACKUP_S3_URL='s3://<bucket>/pg'
export BACKUP_STATE_FILE='/var/lib/astro-soul/backup-last-success'
./scripts/db-dump.sh; echo "exit=$?"          # 0

aws s3 ls "s3://<bucket>/pg/" | tail -3        # файл astro-soul-<UTC>.dump с ненулевым размером
cat "$BACKUP_STATE_FILE"                       # file=…, size_bytes=…, uploaded_at=…
ls -la var/backups | grep partial              # пусто
```

Отказ выгрузки (обязательный сценарий): подставить несуществующий бакет или
битые креды → `exit=5`, в каталоге дампа **нет**, маркер не обновлён:

```bash
BACKUP_S3_URL='s3://no-such-bucket-qa/pg' ./scripts/db-dump.sh; echo "exit=$?"
ls var/backups/*.dump                          # файла от этого прогона нет
```

Ротация: положить в `BACKUP_DIR` файл `astro-soul-20200101T000000Z.dump`,
`touch -d '10 days ago'`, прогнать скрипт → старый файл удалён.

Восстановление из дампа **не проверено** (см. `docs/BACKUP.md` §7) — это
отдельный пункт приёмки у владельца.

---

## 6. Расхождения с заданием и что не проверено

0. **Версия контракта 1.6.11, а не 1.6.10.** Задание разрешало оставить 1.6.10
   «кроме, возможно, нового поля в `/health`», но нужно было добавить два
   маршрута и поле в `Me`; по семверу это бамп. Изменения аддитивные.
1. **`APP_ENV=production` не проверяется.** В проекте `APP_ENV` — DI-токен
   конфигурации (`config/env.module.ts`), а не переменная окружения; условие
   на неё никогда бы не сработало. Проверяется `NODE_ENV=production`.
2. **Добавлен `COMPAT_BREAKER_ENABLED=0`** в прод-гард сверх списка задания —
   симметрично брейкеру разборов.
3. **`astro: down` по-прежнему даёт `degraded`.** Так было до итерации 36;
   задание перечисляло только вебхук и БД, но ослаблять существующую проверку
   ради буквы задания неправильно.
4. **`since` у `telegram_webhook` заполняется до пересечения порога** (момент
   поломки). Для остальных правил `since` — первое превышение, как в задании.
5. **`make backup` не изменён.** Новый скрипт — операционный (с выгрузкой);
   локальный `pg_dump` в `Makefile` остаётся для разработки.
6. **Пуш не реализован** — только миграция, поле в `Me`, маршрут и пометка
   `// round37`. `users.push_enabled` пока никем не читается при отправке.
7. **Восстановление из дампа не проверялось** — нет прод-данных в песочнице.
8. **Живой Bot API не проверялся**: состояния `ok/stale/unreachable` получены
   фейком клиента в тестах и на стенде с неразрешимым хостом; настоящий
   `setWebhook` в песочнице недоступен.
