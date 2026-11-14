-- `report_refund`: у разбора, за который вернули звёзды, должна быть отметка.
--
-- Без неё джоб не отличит «ещё не возвращали» от «возвращали, но платёж не
-- нашёлся», и повторный запуск пытался бы вернуть звёзды второй раз.
-- `status = 'refunded'` уже есть в enum `report_status`.
ALTER TABLE reports
  ADD COLUMN refunded_at timestamptz;

-- Частичный индекс: джоб ищет ровно провалившиеся и ещё не возвращённые.
CREATE INDEX reports_refund_pending_idx ON reports (updated_at)
  WHERE status = 'failed' AND refunded_at IS NULL;
