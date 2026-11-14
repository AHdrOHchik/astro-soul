-- QA-15: инвойс, по которому уже нельзя оплатить (данные удалены).
--
-- Значение enum добавляется отдельным файлом: `ALTER TYPE ... ADD VALUE`
-- нельзя использовать в той же транзакции, где оно добавлено, а мигратор
-- выполняет каждый файл в BEGIN/COMMIT.
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'invalidated';
