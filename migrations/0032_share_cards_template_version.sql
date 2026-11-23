-- 0032_share_cards_template_version.sql
-- Итерация 37: шаблон сторис и два новых вида карточек (контракт 1.6.12).
--
-- 1) `share_cards.template_version` — версия вёрстки в ключе кэша. Зачем не
--    «пересобрать картинки потом»: ключ кэша был `(kind, content_hash)`, и
--    после смены шаблона тот же день/цитата дали бы старую карточку из кэша —
--    человек нажал «Поделиться» и получил вёрстку прошлого сезона. Теперь ключ
--    `(kind, content_hash, template_version)`: старые строки остаются историей
--    (файлы никто не удаляет), а новые запросы идут мимо них.
--
-- 2) `kind` расширяется на `identity` и `moon`. Существующее ограничение
--    приходится снимать и ставить заново: PostgreSQL не умеет «дополнить»
--    CHECK. Это единственная причина, по которой миграция трогает ограничение,
--    а не только добавляет колонку.
--
-- Что получают существующие строки:
--   • `day` — `legacy-0`: это карточки старой вёрстки. Отдавать их по новому
--     шаблону нельзя, поэтому они инвалидируются один раз;
--   • `wheel`/`insight` — `classic-1`: их вёрстка в этой итерации не меняется
--     (прямое требование задания), и кэш остаётся рабочим;
--   • файлы в хранилище не удаляются: старые ссылки, которые кто-то уже
--     сохранил, продолжают работать до истечения подписи.

ALTER TABLE share_cards
  ADD COLUMN IF NOT EXISTS template_version text;

UPDATE share_cards
   SET template_version = CASE
         WHEN kind = 'day' THEN 'legacy-0'
         ELSE 'classic-1'
       END
 WHERE template_version IS NULL;

ALTER TABLE share_cards
  ALTER COLUMN template_version SET NOT NULL;

ALTER TABLE share_cards
  ALTER COLUMN template_version SET DEFAULT 'classic-1';

COMMENT ON COLUMN share_cards.template_version IS
  'Версия вёрстки карточки в ключе кэша: stories-1 для day/identity/moon (итерация 37), classic-1 для wheel/insight, legacy-0 для day старой вёрстки';

-- CHECK на `kind`: снять и поставить заново с двумя новыми значениями.
ALTER TABLE share_cards DROP CONSTRAINT IF EXISTS share_cards_kind_check;

ALTER TABLE share_cards
  ADD CONSTRAINT share_cards_kind_check
  CHECK (kind IN ('day', 'wheel', 'insight', 'identity', 'moon'));

-- Ключ кэша теперь включает версию шаблона. Индекс пересоздаётся, а не
-- дополняется: старый уникальный индекс `(kind, content_hash)` запрещал бы
-- две версии одной карточки.
DROP INDEX IF EXISTS share_cards_content_idx;

CREATE UNIQUE INDEX IF NOT EXISTS share_cards_content_version_idx
  ON share_cards (kind, content_hash, template_version);

COMMENT ON TABLE share_cards IS
  'Кэш карточек шеринга по содержимому и версии шаблона. Связи с человеком нет: ни user_id, ни report_id, ни chart_id';
