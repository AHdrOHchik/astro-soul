-- 0006_profiles_consent_time_mode.sql
-- Приводим профиль к терминам контракта 1.2.1.
--
-- 1. `time_accuracy` → `time_mode`, значение 'approx' → 'approximate':
--    в API поле называется `time_precision` (exact | approximate | unknown),
--    и держать в БД третье имя («accuracy», «approx») значит гарантированно
--    перепутать его при первом же маппинге.
-- 2. `consent_version` — какую редакцию текста согласия принял пользователь.
--    Сам факт согласия (`consent_at`) уже был; без версии нельзя доказать,
--    на что именно согласились, если текст поменяется.

ALTER TYPE time_accuracy RENAME TO time_mode;
ALTER TYPE time_mode RENAME VALUE 'approx' TO 'approximate';

ALTER TABLE profiles RENAME COLUMN time_accuracy TO time_mode;

ALTER TABLE profiles DROP CONSTRAINT profiles_time_consistency;
ALTER TABLE profiles ADD CONSTRAINT profiles_time_mode_consistency CHECK (
  (time_mode = 'unknown' AND birth_time IS NULL)
  OR (time_mode <> 'unknown' AND birth_time IS NOT NULL)
);

ALTER TABLE profiles ADD COLUMN consent_version text;

COMMENT ON COLUMN profiles.time_mode IS 'Точность времени рождения; в API — ChartCreateRequest.time_precision';
COMMENT ON COLUMN profiles.consent_version IS 'Версия текста согласия на обработку ПДн, которую принял пользователь';
