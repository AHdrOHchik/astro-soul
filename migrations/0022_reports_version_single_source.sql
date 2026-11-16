-- Версии разбора — только из кода (итерация 17, задача C).
--
-- Живой прогон 16.11.2026 записал в `reports.prompt_version` значение
-- `prompts_v1.1`, хотя в документации уже были `prompts_v1.2`/`v1.3`. Причина
-- не в генерации, а в двух источниках версии: константа в коде плюс `DEFAULT`
-- у колонки. Пока `DEFAULT` существует, строка в БД может назвать версию,
-- которой в коде нет, и все выводы о качестве текста сделаны на неизвестном
-- промпте.
--
-- `INSERT` в `reports` всегда передаёт обе версии явно (`reports.repository.ts`),
-- поэтому `DEFAULT` не нужен никому. NOT NULL остаётся: разбор без версии —
-- это разбор, который нельзя расследовать.
ALTER TABLE reports
  ALTER COLUMN prompt_version DROP DEFAULT,
  ALTER COLUMN report_structure_version DROP DEFAULT;

COMMENT ON COLUMN reports.prompt_version IS
  'Версия промптов на момент заказа. Пишется только из PROMPT_VERSION (apps/api/src/modules/reports/prompts.ts), DEFAULT снят миграцией 0022';
COMMENT ON COLUMN reports.report_structure_version IS
  'Версия структуры разбора на момент заказа. Пишется только из STRUCTURE_VERSION (validators.ts), DEFAULT снят миграцией 0022';
