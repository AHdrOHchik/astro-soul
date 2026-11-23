-- 0033_push_morning.sql
-- Итерация 38: утренний пуш 08:00 по поясу рождения (контракт 1.6.13).
--
-- Заготовка из 0031 (`users.push_enabled`, `push_log`) уже есть, и сам пуш
-- начинает работать в этой миграции. Нужны две вещи, которых в схеме нет:
--
--   1) `users.last_seen_at` — когда человек последний раз открывал приложение.
--      Правило «не мешать тем, кто уже зашёл утром» проверяет его по поясу
--      рождения: `last_seen_at` после 07:30 местного — значит человек сейчас в
--      приложении и сам увидит разбор дня. Без этой колонки правило пришлось бы
--      выводить из `events` (аналитика), где события могут не прийти вовсе.
--   2) `push_runs` — одна строка на цикл планировщика: сколько было
--      получателей, сколько ушло, сколько пропущено и почему, сколько заняло.
--      Без неё `/health` не может ответить «планировщик жив?», а это тихая
--      поломка: люди просто перестают получать сообщения и не жалуются.
--
-- Приватность: в `push_runs` только агрегаты — ни `user_id`, ни текста, ни
-- `telegram_id`. Ошибки отправки лежат в `push_log.error` (там уже есть
-- `user_id`-псевдоним и текст ошибки Bot API, но не текст пуша).
--
-- Идемпотентность файла: `IF NOT EXISTS` — миграцию можно накатить повторно на
-- стенде, где её применяли вручную.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN users.last_seen_at IS
  'Когда человек последний раз обращался к API (итерация 38). Нужно правилу «не пушить того, кто уже зашёл утром»';

-- Ночной джоб ищет «кто заходил недавно» по `last_seen_at`; без индекса это
-- seq scan по `users` на каждый запуск.
CREATE INDEX IF NOT EXISTS users_last_seen_at_idx ON users (last_seen_at);

CREATE TABLE IF NOT EXISTS push_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  -- Сколько получателей попало в окно 08:00–08:04 по своему поясу.
  candidates          integer NOT NULL DEFAULT 0,
  sent                integer NOT NULL DEFAULT 0,
  -- Пропущены: уже открывали приложение утром (правило «не мешать»).
  skipped_seen        integer NOT NULL DEFAULT 0,
  -- Пропущены: у карты нет валидного пояса — 08:00 по местному не вычислить.
  skipped_no_tz       integer NOT NULL DEFAULT 0,
  -- Второй запуск в ту же минуту: `push_log` уже содержал строку за эти сутки.
  duplicate_prevented integer NOT NULL DEFAULT 0,
  -- 403 и `chat not found`: чат мёртв, пуш отключён до включения руками.
  blocked             integer NOT NULL DEFAULT 0,
  -- Telegram держал 429 дольше, чем мы готовы ждать в этом цикле.
  deferred            integer NOT NULL DEFAULT 0,
  failed              integer NOT NULL DEFAULT 0,
  ms                  integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE push_runs IS
  'Агрегаты одного цикла утреннего пуша (итерация 38). Ни `user_id`, ни текста: только счётчики';
COMMENT ON COLUMN push_runs.skipped_no_tz IS
  'Люди с согласием и картой, но без валидного пояса: пуш им не отправить никогда';

CREATE INDEX IF NOT EXISTS push_runs_started_at_idx ON push_runs (started_at);
