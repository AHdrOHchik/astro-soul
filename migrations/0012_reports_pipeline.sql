-- Разбор: версионирование, стоимость в рублях, идемпотентность и прогресс
-- (P0-7, контракт 1.5.1 `POST /reports`, `GET /reports/{report_id}`).
--
-- Без версий через месяц нельзя понять, по какой структуре и каким промптам
-- сделан проданный разбор, — а именно это нужно при первой жалобе.
ALTER TABLE reports
  ADD COLUMN report_structure_version text NOT NULL DEFAULT 'structure_v1',
  ADD COLUMN prompt_version text NOT NULL DEFAULT 'prompts_v1',
  -- Модель вместе с версией: GigaChat-3-Ultra.
  ADD COLUMN model text,
  -- Хэш нормализованных chart_facts: воспроизводимость и дедупликация.
  ADD COLUMN chart_hash text,
  -- Ответ стадии «план»: thesis, focuses, avoid.
  ADD COLUMN plan jsonb,
  -- Сводки глав: вход для «Итога» и для «Спроси карту».
  ADD COLUMN digests jsonb,
  -- Провалы попыток: пункт, цитата, номер попытки, версия промптов.
  ADD COLUMN validation jsonb,
  -- По каждой главе: ok | regenerated | failed.
  ADD COLUMN section_status jsonb,
  -- Сколько вызовов LLM ушло на разбор — прямые деньги.
  ADD COLUMN attempts smallint NOT NULL DEFAULT 0,
  -- Первые 400 знаков `core`: тизер показывается до оплаты.
  ADD COLUMN teaser text,
  -- Стоимость в рублях: контракт 1.5.1 считает деньги в рублях, не в долларах.
  ADD COLUMN llm_cost_rub numeric(10, 4) NOT NULL DEFAULT 0,
  -- `Idempotency-Key` заказа: три тапа по кнопке — один разбор.
  ADD COLUMN idempotency_key text,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz;

-- Один и тот же ключ от одного пользователя даёт один разбор (TTL 24 ч —
-- на стороне API: ключ живёт, пока живёт разбор).
CREATE UNIQUE INDEX reports_idempotency_idx
  ON reports (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN reports.llm_cost_rub IS
  'Стоимость вызовов LLM по этому разбору в рублях (0.5 ₽ / 1000 токенов)';
COMMENT ON COLUMN reports.chart_hash IS
  'Хэш нормализованных chart_facts: одинаковый вход → одинаковая стоимость и текст';
