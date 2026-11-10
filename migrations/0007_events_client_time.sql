-- 0007_events_client_time.sql
-- Клиентские события (контракт 1.3.0, `POST /api/v1/events`) приносят своё
-- время: без него воронку «открыл → согласился → ввёл дату → построил карту»
-- не выстроить, если Mini App отправляет батч с задержкой.
--
-- `created_at` остаётся временем прилёта на сервер — по нему считаются лимиты
-- и лаг доставки; `occurred_at` — время на устройстве.

ALTER TABLE events ADD COLUMN occurred_at timestamptz;

COMMENT ON COLUMN events.occurred_at IS
  'Время события на клиенте (ClientEvent.at); created_at — когда батч пришёл на сервер';

CREATE INDEX events_occurred_idx ON events (occurred_at DESC) WHERE occurred_at IS NOT NULL;
