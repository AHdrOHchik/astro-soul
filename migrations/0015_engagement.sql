-- Итерация 10: удержание — ночной прогноз, пуш и «спроси карту».
--
-- 1) `forecasts` получает признак платного варианта и стоимость в рублях
--    (одна формула: токены × цена модели), плюс отметку отправленного пуша.
-- 2) `asks` больше не хранит текст вопроса: это ПДн-риск («у меня депрессия»,
--    «муж изменил»). Для аналитики остаются длина и тема, текст живёт только
--    в памяти обработчика и в промпте.
-- 3) `charts.push_blocked_at` — «бот заблокирован»: после 403 Bot API карту
--    больше не пушим.
-- 4) `llm_cost_usd` в этих таблицах не считалась (как и в `reports`), её
--    заменяет рублёвая колонка + токены.

ALTER TABLE forecasts
  ADD COLUMN is_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN llm_cost_rub numeric(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN llm_tokens_in integer NOT NULL DEFAULT 0,
  ADD COLUMN llm_tokens_out integer NOT NULL DEFAULT 0,
  ADD COLUMN push_sent_at timestamptz;

ALTER TABLE forecasts DROP COLUMN llm_cost_usd;

COMMENT ON COLUMN forecasts.is_paid IS
  'Полный вариант (подписка) или урезанный бесплатный; решает, что отдаст GET /engagement/forecast';
COMMENT ON COLUMN forecasts.push_sent_at IS
  'Когда отправлен пуш 08:00 по местному времени; NULL — ещё не отправляли';

-- Пуш ищет «сегодняшний прогноз без пуша» — частичный индекс ровно под это.
CREATE INDEX forecasts_push_pending_idx ON forecasts (date)
  WHERE push_sent_at IS NULL;

ALTER TABLE charts ADD COLUMN push_blocked_at timestamptz;

COMMENT ON COLUMN charts.push_blocked_at IS
  'Bot API ответил 403 (бот заблокирован): карту больше не пушим, прогнозы продолжаем';

ALTER TABLE asks
  ADD COLUMN question_length integer NOT NULL DEFAULT 0,
  ADD COLUMN topic text,
  ADD COLUMN llm_cost_rub numeric(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN llm_tokens_in integer NOT NULL DEFAULT 0,
  ADD COLUMN llm_tokens_out integer NOT NULL DEFAULT 0;

ALTER TABLE asks DROP CONSTRAINT asks_question_len;
ALTER TABLE asks DROP COLUMN question;
ALTER TABLE asks DROP COLUMN llm_cost_usd;

COMMENT ON COLUMN asks.question_length IS
  'Длина вопроса в знаках. Сам текст не хранится: ПДн (health, измена и т.п.)';
COMMENT ON COLUMN asks.topic IS
  'Тема по ключевым словам: health | death | money | legal | love | work | self | other';

-- Тема нужна метрикам «о чём спрашивают», без текста.
CREATE INDEX asks_topic_idx ON asks (topic);
