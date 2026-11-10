-- 0001_core_users.sql
-- Пользователи и профиль рождения.
--
-- users.id — детерминированный UUID, выведенный из telegram_id и серверного
-- перца (HMAC-SHA256). Смысл: ПДн (профиль, карты, разборы) удаляются по
-- DELETE /me, а подписка и платежи остаются и остаются связанными с тем же
-- субъектом, когда он вернётся в мини-апп. Обратно из UUID telegram_id не
-- восстанавливается, поэтому идентификатор не является ПДн.

-- Общий триггер для updated_at: приложение не обязано помнить про это поле.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  telegram_id   bigint NOT NULL UNIQUE,
  language_code text,
  -- Антифрод (payments.md §5): 2+ возврата — помечаем, триал не даём.
  risk_flag     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN users.id IS 'Детерминированный UUID = HMAC_SHA256(PSEUDONYM_PEPPER, telegram_id)';
COMMENT ON COLUMN users.risk_flag IS 'Два и более возврата: покупки разрешены, триал — нет';

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE time_accuracy AS ENUM ('exact', 'approx', 'unknown');
CREATE TYPE onboarding_step AS ENUM ('birth_date', 'birth_time', 'birth_place', 'done');

CREATE TABLE profiles (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  birth_date       date NOT NULL,
  -- null, если время неизвестно или известно «примерно» без минут
  birth_time       time,
  time_accuracy    time_accuracy NOT NULL,
  place_name       text NOT NULL,
  place_region     text,
  place_country    text NOT NULL,
  place_lat        double precision NOT NULL,
  place_lon        double precision NOT NULL,
  place_tz         text NOT NULL,
  -- Факт согласия на обработку ПДн (152-ФЗ), время фиксируется
  consent_at       timestamptz NOT NULL,
  onboarding_step  onboarding_step NOT NULL DEFAULT 'done',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_lat_range CHECK (place_lat BETWEEN -90 AND 90),
  CONSTRAINT profiles_lon_range CHECK (place_lon BETWEEN -180 AND 180),
  -- Время без даты невозможно, а «не знаю» не должно нести время
  CONSTRAINT profiles_time_consistency CHECK (
    (time_accuracy = 'unknown' AND birth_time IS NULL)
    OR (time_accuracy <> 'unknown' AND birth_time IS NOT NULL)
  )
);

COMMENT ON COLUMN profiles.birth_time IS 'Локальное время места рождения; NULL при time_accuracy = unknown';

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
