-- Итерация 32: PDF разбора и карточки шеринга (контракт 1.6.8).
--
-- Две таблицы, и обе — про файлы, а не про текст. Общее правило одно: **в
-- базе лежит ключ в приватном хранилище, а не ссылка на файл**. Публичных URL
-- у файлов нет вообще: API подписывает ссылку на 24 часа при каждом чтении, и
-- она протухает. Поэтому `storage_key` — это путь внутри нашего хранилища, а
-- не адрес в интернете: утечка строки из БД не даёт доступа к документу.
--
-- `report_pdfs` — кэш сборки. Ключ `(report_id, engine_version,
-- prompt_version)`: та же карта, тот же движок и та же версия промпта дают тот
-- же документ, поэтому второй `POST /reports/{id}/pdf` не пересобирает файл, а
-- отдаёт существующий. Смена любой версии — законно другой документ, и старая
-- строка остаётся историей, а не перезаписывается.
--
-- `share_cards` — кэш по содержимому. Один и тот же день у сотни людей даёт
-- одну карточку: ключ `(kind, content_hash)`, а `short_id` выводится из этого
-- же хеша. Отсюда два свойства, которые важны для приватности:
--   • `short_id` не содержит ни `user_id`, ни `report_id` — по ссылке в
--     карточке нельзя получить чужой идентификатор;
--   • карточка не привязана к человеку в схеме. Удаление аккаунта не
--     «выдёргивает» картинку из чужого чата — в ней и так нет ПДн.
--
-- EXIF и прочие метаданные в карточках не пишутся (см. `astro/cards.py`):
-- «карточка без ПДн» проверяется тестом по байтам PNG, а не обещанием.

create table report_pdfs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  -- Денормализация: `DELETE /me` собирает ключи файлов одним запросом, не
  -- джойня `reports`. Файл при удалении аккаунта стирается из хранилища.
  user_id uuid not null references users(id) on delete cascade,
  engine_version text not null,
  prompt_version text not null,
  status text not null check (status in ('pending', 'ready', 'failed')),
  storage_key text,
  bytes integer,
  pages smallint,
  -- Сколько шла сборка: PDF собирается на CPU, и «стало медленнее» — это
  -- повод смотреть сюда, а не в логи.
  build_ms integer,
  -- Сколько раз файл скачали по подписанной ссылке (метрика `pdf_downloaded_24h`).
  downloads integer not null default 0,
  -- Почему `failed`: `pdf_failed`, `too_large`, `astro_unavailable`.
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index report_pdfs_version_idx
  on report_pdfs (report_id, engine_version, prompt_version);

create index report_pdfs_user_idx on report_pdfs (user_id);
create index report_pdfs_status_idx on report_pdfs (status, updated_at);

create table share_cards (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('day', 'wheel', 'insight')),
  -- Хеш содержимого карточки: одинаковый вход — одна карточка на всех.
  content_hash text not null,
  -- Хвост ссылки в карточке: `t.me/<bot>?start=sh_<short_id>`. Выводится из
  -- хеша содержимого и не связан с `user_id`/`report_id`.
  short_id text not null,
  storage_key text not null,
  bytes integer not null,
  width smallint not null,
  height smallint not null,
  created_at timestamptz not null default now()
);

create unique index share_cards_content_idx on share_cards (kind, content_hash);
create unique index share_cards_short_idx on share_cards (short_id);
