-- 0021: тестовый тариф за 1 звезду (payments.md §1.1).
--
-- Признак «тестовый» нужен в двух местах и по одной причине: не дать
-- тестовой звезде владельца попасть туда, где её примут за продажу.
--
--   plans.test_only      — зеркало `testOnly` из packages/shared/src/plans.ts.
--                          Строка в `plans` обязательна: на неё ссылаются
--                          `invoices.plan_code` и `payments.plan_code`, и без
--                          неё инвойс тестового тарифа не создать. В каталог
--                          пейволла строка не попадает: его собирает код
--                          (`PLANS_ORDERED`), а не запрос к таблице.
--   payments.is_test     — отметка на самом платеже: метрики считают такие
--                          платежи отдельно и не включают их в выручку.
--
-- `is_active = false` у тестового плана ставит сид: если однажды появится
-- админский список «планы из БД», тестовый тариф в нём не всплывёт.

ALTER TABLE plans ADD COLUMN test_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN plans.test_only IS
  'План существует только при PAYMENTS_TEST_PLANS=1; в каталог для клиента не попадает никогда';

ALTER TABLE payments ADD COLUMN is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN payments.is_test IS
  'Платёж по тестовому тарифу: исключается из выручки, конверсии и counts отказов';

-- Метрики спрашивают «сколько тестовых платежей за 30 дней» — выборка мала,
-- частичный индекс держит её дешёвой независимо от размера таблицы.
CREATE INDEX payments_test_paid_at_idx ON payments (paid_at) WHERE is_test;
