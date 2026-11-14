-- Блокер A: удаление данных обнуляет псевдонимный ключ во всех таблицах, где он
-- есть. Раньше `DELETE /me` обезличивал только `payments.telegram_id`, а
-- `user_id` оставался — и возвращение того же человека (user_id детерминирован
-- из telegram_id) снова делало старые подписку и права живыми.
--
-- Что делаем:
--   1) `subscriptions`, `entitlements`, `events` — `user_id` становится
--      nullable, чтобы после удаления аккаунта строка осталась (бухгалтерия,
--      аудит), но уже без связи с человеком;
--   2) `subscriptions` получает суррогатный `id`: `user_id` был первичным
--      ключом, а первичный ключ не может быть NULL. `UNIQUE (user_id)` держит
--      «одна подписка на пользователя» и остаётся совместимым с
--      `INSERT ... ON CONFLICT (user_id)` (NULL-ы в UNIQUE не конфликтуют);
--   3) `anonymized_at` во всех четырёх таблицах — когда связь разорвана.
--
-- FK: ни в одной из четырёх таблиц нет внешнего ключа на `users` (0003 шапка),
-- поэтому удаление `users` их не трогает и ничего не каскадится. `payments.user_id`
-- и `events.user_id` в этой миграции менять не нужно — они уже nullable.

ALTER TABLE subscriptions
  DROP CONSTRAINT subscriptions_pkey;

ALTER TABLE subscriptions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

-- UNIQUE, а не частичный индекс: `INSERT ... ON CONFLICT (user_id)` выводит
-- ограничение по имени колонки, а по частичному индексу — только если предикат
-- выводится из запроса. NULL-ы в UNIQUE не конфликтуют между собой, поэтому
-- у удалённых пользователей строки спокойно сосуществуют.
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);

ALTER TABLE subscriptions ADD COLUMN anonymized_at timestamptz;

ALTER TABLE subscriptions ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE entitlements
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE entitlements
  ADD COLUMN anonymized_at timestamptz;

ALTER TABLE events
  ADD COLUMN anonymized_at timestamptz;

COMMENT ON COLUMN subscriptions.anonymized_at IS
  'Когда строку отвязали от человека (DELETE /me): user_id = NULL, status = cancelled';
COMMENT ON COLUMN entitlements.anonymized_at IS
  'Когда право снято и отвязано (DELETE /me): user_id = NULL, status = revoked';
COMMENT ON COLUMN events.anonymized_at IS
  'Когда событие отвязано от пользователя (DELETE /me): user_id = NULL';
