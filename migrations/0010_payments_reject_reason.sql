-- QA-11: причины отказа и разрешение платежа без плана.
--
-- `reject_reason` — код из контракта (`payment_rejected.props.code`):
-- no_invoice | amount_mismatch | unknown_plan. Пишется только у `rejected`.
--
-- `plan_code` становится nullable только для `rejected`: при неизвестном плане
-- плана в справочнике нет, а платёж всё равно нужно записать — иначе отказ по
-- деньгам существует лишь в логах и не виден ни поддержке, ни метрикам.
ALTER TABLE payments
  ADD COLUMN reject_reason text;

ALTER TABLE payments
  ALTER COLUMN plan_code DROP NOT NULL;

ALTER TABLE payments
  ADD CONSTRAINT payments_rejected_reason_ck
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL);

ALTER TABLE payments
  ADD CONSTRAINT payments_plan_required_ck
  CHECK (plan_code IS NOT NULL OR status = 'rejected');

COMMENT ON COLUMN payments.reject_reason IS
  'Причина отказа по деньгам: no_invoice | amount_mismatch | unknown_plan';

-- Поддержка ищет отказы по дате, разбор инцидента — по charge_id.
CREATE INDEX payments_rejected_idx ON payments (paid_at DESC)
  WHERE status = 'rejected';
