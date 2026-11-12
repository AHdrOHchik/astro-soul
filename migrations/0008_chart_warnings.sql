-- Контракт 1.4.0: `ChartResponse.warnings`.
--
-- Предупреждения о качестве входных данных храним вместе с картой: часть из
-- них (approximate_place) нельзя восстановить по самой карте, а клиенту нужен
-- одинаковый ответ и сразу после создания, и через месяц.
--
-- Коды: no_birth_time | approximate_time | approximate_place.
-- Список расширяемый: новый код добавляется в контракт и в
-- WARNING_CODES (apps/api/src/modules/charts/charts.warnings.ts) одним PR.
--
-- Карты, созданные до 1.4.0, получают пустой массив — ровно то, что требует
-- контракт («pre-field charts → []»).
ALTER TABLE charts
  ADD COLUMN warnings text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN charts.warnings IS
  'Коды предупреждений ChartResponse.warnings: no_birth_time | approximate_time | approximate_place';
