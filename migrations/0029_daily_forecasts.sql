-- Итерация 30: прогноз дня и «спроси карту».
--
-- Обе функции — содержимое подписки и обе стоят денег на каждый вызов. Поэтому
-- в схеме две вещи, без которых расходы не удержать:
--
--   1. **Одна строка на человека в сутки** (`daily_forecasts`, уникальный
--      индекс по `user_id + local_date + prompt_version`). Вставка идёт
--      `insert … on conflict do nothing`: кто первый вставил, тот и генерирует,
--      остальные читают. Два параллельных открытия мини-аппа не должны давать
--      два вызова модели — это буквально двойные деньги.
--   2. **Один вопрос в работе** (`questions`, частичный уникальный индекс по
--      `status = 'pending'`). Второй вопрос, пока первый не готов, — `409`;
--      ограничение держит база, а не только сервис, иначе два одновременных
--      POST проходят проверку и оба платят.
--
-- `local_date` — дата в часовом поясе **места рождения** (`profiles.place_tz`),
-- считается на сервере: у человека в Новосибирске «сегодня» наступает раньше,
-- чем на сервере, и ключ квоты должен совпадать с его календарём.
--
-- Смена `PROMPT_VERSION_FORECAST` создаёт новую строку на ту же дату — это
-- ожидаемо (новая версия промпта = другой продукт), а не миграция данных.

create table daily_forecasts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  local_date date not null,
  timezone text not null,
  engine_version text not null,
  prompt_version text not null,
  status text not null check (status in ('pending', 'ready', 'failed')),
  body_md text,
  chars int,
  -- `warnings` сохраняются вместе с текстом: сервер обязан отдавать один и тот
  -- же ответ на повторный запрос, а `length_off` считается при генерации.
  warnings jsonb not null default '[]'::jsonb,
  facts jsonb not null,
  cost_rub numeric(10,4) not null default 0,
  -- Почему `failed`: `llm_error`, `validation_failed`, `timeout`, `astro_unavailable`.
  -- Отдельной колонкой, а не в `facts`: факты — вход, это — исход.
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index daily_forecasts_user_date_pv
  on daily_forecasts (user_id, local_date, prompt_version);

-- Метрики за сутки и «кто ждёт повтора»: выборка по дате и статусу.
create index daily_forecasts_date_status_idx on daily_forecasts (local_date, status);

create trigger daily_forecasts_set_updated_at
  before update on daily_forecasts
  for each row execute function set_updated_at();

comment on table daily_forecasts is
  'Прогноз дня: один на человека в сутки на версию промпта; факты считает Python';
comment on column daily_forecasts.facts is
  'Факты дня из сайдкара (Луна, ретро, транзиты, окна) — вход модели, не её вывод';
comment on column daily_forecasts.local_date is
  'Дата в поясе места рождения, а не серверная';

-- «Спроси карту». Вопрос хранится, потому что человек должен видеть историю
-- (SPEC §7: до удаления аккаунта, в логи и события не пишется — только хеш,
-- длина и класс темы).
create table questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  local_date date not null,
  timezone text not null,
  question text not null,
  -- sha256 от текста, первые 16 знаков: по нему в логе видно «тот же вопрос»,
  -- и по нему же нельзя восстановить сам вопрос.
  question_hash text not null,
  question_len int not null check (question_len > 0),
  -- Класс темы: health | death | money | legal | third_party | adult | none.
  topic text not null,
  status text not null check (status in ('pending', 'ready', 'failed', 'refused')),
  -- Для `refused` — из закрытого списка, для `failed` — код сбоя.
  reason text,
  body_md text,
  chars int,
  warnings jsonb not null default '[]'::jsonb,
  -- Ключ идемпотентности: тот же ключ → тот же id, второго вызова модели нет.
  idem_key text not null,
  engine_version text not null,
  prompt_version text not null,
  cost_rub numeric(10,4) not null default 0,
  duration_ms int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idem_key)
);

create index questions_user_created_idx on questions (user_id, created_at desc);

-- Один вопрос в работе на человека. Частичный индекс, а не проверка в коде:
-- два одновременных POST иначе оба проходят «нет ли pending» и оба платят.
create unique index questions_one_pending_per_user
  on questions (user_id) where status = 'pending';

-- Метрики за сутки: статусы и стоимость.
create index questions_created_status_idx on questions (created_at, status);

create trigger questions_set_updated_at
  before update on questions
  for each row execute function set_updated_at();

comment on table questions is
  'Вопросы «спроси карту»: хранятся до удаления аккаунта, в логи — только хеш';
comment on column questions.question_hash is
  'sha256(text)[:16]: в логах и событиях только он, сам текст — никогда';

-- Дневная квота вопросов по местной дате. Отдельная таблица, а не count(*) по
-- `questions`: отказы квоту не тратят, а удаление вопроса не должно возвращать
-- попытку (иначе «удалил — спросил снова» превращается в бесконечный лимит).
create table question_usage (
  user_id uuid not null references users(id) on delete cascade,
  local_date date not null,
  count int not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, local_date)
);

create trigger question_usage_set_updated_at
  before update on question_usage
  for each row execute function set_updated_at();

comment on table question_usage is
  'Дневная квота вопросов по дате места рождения (QUESTION_DAILY_LIMIT)';
