# Утренний пуш 08:00 — эксплуатация (итерация 38, контракт 1.6.13)

Что это: раз в местные сутки бот присылает в личный чат короткое сообщение
«Доброе утро» с фактом дня и кнопками «Открыть разбор дня» и «Отключить».
Модель **не вызывается**: текст собирается из констант (`MOON_ADVICE`) и фактов
`/forecast/facts` на полдень местного дня.

## Кто получает

Все три условия обязательны:

1. есть карта (`charts`, последняя по `created_at`) с **валидным** поясом в
   `charts.data.chart.birth.place.tz`;
2. `users.push_enabled = true` — то же поле, что `Me.notifications.daily_forecast`
   и `POST /me/notifications`;
3. есть `users.telegram_id`.

Не получают: люди без карты, отключившие пуш, удалившие аккаунт (`DELETE /me`),
заблокировавшие бота (`403`/`chat not found` → `push_enabled = false`), и те, кто
в это утро уже открывал приложение после 07:30 по своему поясу.

## Когда

Окно `PUSH_SEND_HOUR:00 … PUSH_SEND_HOUR + PUSH_WINDOW_MINUTES - 1` по поясу
рождения (по умолчанию 08:00–08:04). Планировщик тикает каждую минуту. Вне окна
пуш не отправляется и **не догоняется**: «доброе утро» в обед хуже, чем молчание.
Ровно один пуш за местные сутки — гарантия уникального ключа
`push_log (user_id, local_date, kind)`.

## Порядок выпуска (важно: флаги живут в разных местах)

`PUSH_ENABLED` читается **в рантайме**, `VITE_NOTIFICATIONS_UI` **запекается в
бандл при сборке**. Поэтому «включить оба» — две разные процедуры, и путать их
нельзя: рестарт API не покажет тумблер в кабинете, а пересборка web не включит
рассылку.

1. `PUSH_ENABLED=1` в окружении API → **рестарт API**. `/health.flags.push.enabled`
   становится `true`, планировщик создаётся при старте.
2. Убедиться, что `/health` не `degraded` из-за пуша: через минуту после рестарта
   `flags.push.last_run_at` не `null`.
3. `VITE_NOTIFICATIONS_UI=1` → **пересборка web** (`pnpm --filter @astro-soul/web
   run build`) → деплой статики.
4. Проверить на своём аккаунте: тумблер в кабинете, «Отключить» в чате, `/health`.

Выключение — в обратном порядке (`VITE_NOTIFICATIONS_UI=0` + пересборка web, затем
`PUSH_ENABLED=0` + рестарт API). Если выключить только бэкенд, тумблер в кабинете
останется, а рассылки не будет — это не поломка, но объяснять её придётся.

## Наблюдаемость

| Где | Что |
|---|---|
| `/health` → `flags.push` | `enabled`, `last_run_at`, `last_sent_count`. Включённый пуш без прогонов **дольше 2 часов** → `status: degraded` |
| `/admin/metrics` | `push_sent_24h`, `push_failed_24h`, `push_skipped_no_tz_24h` (состояние, а не поток), `push_duplicate_prevented_24h` |
| `/admin/alerts` | `push_failed` (warning): `push_failed_24h > 20`. `blocked` и `chat not found` не считаются — это отказ человека |
| лог | одна строка на цикл: `push_run: candidates=… sent=… skipped=… failed=… ms=…`; плюс `push_throttled`, `push_retry`, `push_off`, `push_tick_skipped` |

**Если планировщик умер**, это видно в `/health` (`flags.push.last_run_at`
перестал двигаться, `status: degraded` через 2 часа) и в логах (`push_run`
не появляется). Молчания недостаточно: отсутствие сообщения человек не замечает
и не жалуется.

## Если что-то не приходит

1. `SELECT push_enabled, last_seen_at, telegram_id FROM users WHERE id = …` —
   согласие, утренний заход, чат.
2. `SELECT * FROM push_log WHERE user_id = … ORDER BY local_date DESC LIMIT 3` —
   была ли попытка и что ответил Bot API (`error`).
3. `SELECT * FROM push_runs ORDER BY started_at DESC LIMIT 5` — тикал ли цикл и
   сколько было получателей.
4. Пояс карты: `SELECT data->'chart'->'birth'->'place'->>'tz' FROM charts …` —
   без валидного пояса человек навсегда в `push_skipped_no_tz_24h`; лечится
   исправлением карты (пересохранением места рождения).

## Чего в этой итерации нет

- текста от модели, чисел, рейтингов, картинки в пуше;
- догоняющей отправки за пропущенный день;
- ручной рассылки по всей базе из этого механизма (`POST /internal/jobs/run?job=
  forecast_push` запускает обычный цикл с теми же фильтрами, а не broadcast);
- push-уведомлений в приложении и web-push: только чат бота.
