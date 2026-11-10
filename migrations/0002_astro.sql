-- 0002_astro.sql
-- Натальные карты, разборы, прогнозы, вопросы к карте.

CREATE TABLE charts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Хеш нормализованного входа (дата, время, место) — идемпотентность POST /charts
  input_hash     text NOT NULL,
  -- Полный ответ движка: планеты, дома, аспекты, балансы (см. Chart в контракте)
  data           jsonb NOT NULL,
  engine_version text NOT NULL,
  -- false, если время рождения неизвестно: дома и ASC = null
  time_known     boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, input_hash)
);

COMMENT ON COLUMN charts.input_hash IS 'hashInput() из packages/astro; повторный запрос с тем же входом возвращает эту же карту';

CREATE TYPE report_kind AS ENUM ('report', 'compat', 'solar');
CREATE TYPE report_status AS ENUM ('queued', 'planning', 'writing', 'ready', 'failed', 'refunded');

CREATE TABLE reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chart_id        uuid NOT NULL REFERENCES charts (id) ON DELETE CASCADE,
  -- Денормализация для DELETE /me и отчётов без джойна
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            report_kind NOT NULL DEFAULT 'report',
  status          report_status NOT NULL DEFAULT 'queued',
  -- Главы от LLM, прошедшие валидацию схемой: [{ id, title, text }]
  chapters        jsonb,
  -- Стоимость всех LLM-вызовов по этому разбору, USD (лимит 0.35)
  llm_cost_usd    numeric(10, 4) NOT NULL DEFAULT 0,
  -- Для парных разборов (compat) — вторая карта
  partner_chart_id uuid REFERENCES charts (id) ON DELETE SET NULL,
  error_code      text,
  -- Количество ретраев уже израсходовано (при провале схемы — один)
  retry_count     smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reports_chart_id_idx ON reports (chart_id);
CREATE INDEX reports_status_idx ON reports (status) WHERE status IN ('queued', 'planning', 'writing');
CREATE UNIQUE INDEX reports_one_ready_per_chart_kind
  ON reports (chart_id, kind)
  WHERE status = 'ready';

CREATE TABLE forecasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chart_id      uuid NOT NULL REFERENCES charts (id) ON DELETE CASCADE,
  -- Дата, на которую прогноз (по часовому поясу места рождения)
  date          date NOT NULL,
  -- Текст для бесплатного пользователя: 1–2 предложения
  teaser        text,
  -- Полный текст для подписки: 3–6 предложений + фокус дня
  full_text     text,
  focus         text,
  llm_cost_usd  numeric(10, 4) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Ночной джоб пишет upsert'ом именно по этой паре
  UNIQUE (chart_id, date)
);

CREATE INDEX forecasts_date_idx ON forecasts (date);

CREATE TABLE asks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chart_id      uuid NOT NULL REFERENCES charts (id) ON DELETE CASCADE,
  question      text NOT NULL,
  answer        text,
  -- «На чём основано»: позиции карты, на которые опирался ответ
  basis         jsonb,
  llm_cost_usd  numeric(10, 4) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asks_question_len CHECK (char_length(question) BETWEEN 3 AND 500)
);

CREATE INDEX asks_user_created_idx ON asks (user_id, created_at DESC);
