-- QA-15: инвойс живёт до удаления данных, а платёж не воскрешает пользователя.
--
-- 1) `invalidated_at` — когда инвойс аннулирован (DELETE /me). Сам статус
--    `invalidated` добавлен миграцией 0013.
-- 2) `payments.refunded_at` разрешён и у `rejected`: отказ по QA-15 всегда
--    сопровождается автовозвратом, и это должно быть видно в строке платежа.
-- 3) Деньги LLM: одна формула вместо двух. `llm_cost_usd` считался не от той
--    же цены, что `llm_cost_rub` (и всегда оставался нулём), поэтому колонка
--    удаляется, а рядом с рублями появляются токены — по ним видно, из чего
--    сложилась сумма (QA-002, задача 2).

ALTER TABLE invoices
  ADD COLUMN invalidated_at timestamptz;

COMMENT ON COLUMN invoices.invalidated_at IS
  'Когда инвойс аннулирован (DELETE /me). status = invalidated, оплата невозможна';

-- Быстрый поиск живых инвойсов пользователя при удалении.
CREATE INDEX invoices_invalidated_idx ON invoices (user_id, invalidated_at)
  WHERE invalidated_at IS NOT NULL;

-- Отказ + возврат: status = 'rejected', refunded_at заполнен.
ALTER TABLE payments
  DROP CONSTRAINT payments_refund_consistency;

ALTER TABLE payments
  ADD CONSTRAINT payments_refund_consistency CHECK (
    (status <> 'refunded' OR refunded_at IS NOT NULL)
    AND (refunded_at IS NULL OR status IN ('refunded', 'rejected'))
  );

COMMENT ON COLUMN payments.refunded_at IS
  'Когда звёзды вернулись. Заполняется у status = refunded и у rejected с автовозвратом';

-- Токены LLM: сумма рублей объясняется ими, а не отдельной «долларовой» формулой.
ALTER TABLE reports
  ADD COLUMN llm_tokens_in integer NOT NULL DEFAULT 0,
  ADD COLUMN llm_tokens_out integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN reports.llm_tokens_in IS 'Токенов на входе (usage.prompt_tokens), сумма по вызовам';
COMMENT ON COLUMN reports.llm_tokens_out IS 'Токенов на выходе (usage.completion_tokens), сумма по вызовам';

ALTER TABLE reports DROP COLUMN llm_cost_usd;
