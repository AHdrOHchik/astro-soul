# Крон: что запускается, как часто и как проверить

Один вход — `POST /api/v1/internal/jobs/run` с заголовком `X-Jobs-Secret`
(значение — `INTERNAL_JOB_SECRET` из окружения API). Без переменной секрета
маршрут закрыт всегда: 403 на любой запрос.

`?job=<name>` запускает только названный джоб, без параметра — все по порядку.
Незнакомое имя — 403, а не «запустим что-нибудь».

Порядок внутри одного запуска важен: `pending_payments_resolve` доводит
зависшие платежи, и только то, что он не смог, забирает `refund_undelivered`.

| Джоб | Что делает | Как часто | Идемпотентность |
|---|---|---|---|
| `pending_payments_resolve` | Платёж `processed = false` старше 10 минут разрешается тем же кодом, что и вебхук: сверка инвойса и суммы, затем доступ или `rejected` с причиной. Звёзды автоматически не возвращает | каждые 5 минут | второй запуск не находит работы → нули |
| `refund_undelivered` | Страховка: платёж, который не удалось ни доставить, ни разрешить, возвращается через `refundStarPayment` | каждые 5 минут | повторный возврат отсекает `payments.status = 'refunded'` |
| `subscriptions_downgrade` | Истёкшие подписки → `expired`, одно сообщение «продлить?» (не чаще 1 раза в 30 дней) | каждые 5 минут | отметка в `events` держит троттлинг |
| `report_refund` | Провалившийся разбор (`reports.status = 'failed'`) → возврат звёзд за него, разбор помечается `refunded` + `refunded_at` | каждые 10 минут | `refunded_at` закрывает повтор |
| `pdn_retention_cleanup` | Пользователи без активности дольше 24 месяцев: ПДн удаляются, платежи обезличиваются (`telegram_id = NULL`). Под `pg_advisory_xact_lock` | раз в сутки, 04:00 UTC | удалённых пользователей второй запуск не находит |

Джоб `pdn_retention_cleanup` — это требование 152-ФЗ к сроку хранения, а не
оптимизация: без него «удалим, когда вспомним» не выполняется.

## Установка systemd

```bash
sudo install -d /etc/astro-soul /opt/astro-soul
sudo install -m 0644 infra/systemd/astro-jobs.service /etc/systemd/system/
sudo install -m 0644 infra/systemd/astro-jobs.timer   /etc/systemd/system/
sudo install -m 0600 infra/systemd/jobs.env.example   /etc/astro-soul/jobs.env
sudo editor /etc/astro-soul/jobs.env          # адрес API и секрет
sudo systemctl daemon-reload
sudo systemctl enable --now astro-jobs.timer
```

`jobs.env` — единственное место, где лежит секрет:

```ini
# Адрес API на том же хосте (или внутренний адрес за прокси).
ASTRO_JOBS_URL=http://127.0.0.1:8080/api/v1/internal/jobs/run
# Ровно INTERNAL_JOB_SECRET из окружения API.
ASTRO_JOBS_SECRET=change-me
```

Отдельный таймер на отдельный джоб (если суточный джоб хочется отвязать от
пятиминутного):

```bash
sudo mkdir -p /etc/systemd/system/astro-jobs.service.d
printf '[Service]\nEnvironment=JOBS_JOB=pdn_retention_cleanup\n' \
  | sudo tee /etc/systemd/system/astro-jobs.service.d/pdn.conf
sudo systemctl daemon-reload
```

## Как проверить, что крон работает

1. Ручной запуск и ответ — счётчики джобов, не «ок»:

   ```bash
   curl -sS -X POST -H "X-Jobs-Secret: $ASTRO_JOBS_SECRET" \
     "$ASTRO_JOBS_URL?job=pending_payments_resolve"
   # {"subscriptions_expired":0,...,"pending_payments_processed":0,"pending_payments_rejected":0,...}
   ```

2. Второй запуск подряд даёт нули по уже сделанной работе — это и есть проверка
   идемпотентности.

3. Таймер сработал: `systemctl list-timers astro-jobs.timer` и
   `journalctl -u astro-jobs.service -n 20`.

4. Висящих платежей нет: `GET /api/v1/admin/metrics` → `pending_payments_now = 0`
   (ненулевое значение дольше 10 минут означает, что крон не ходит).

5. Отказы по деньгам видны в метриках, а не только в логах:
   `payments_rejected_30d`, `amount_mismatch_30d`.

6. Удаление по сроку хранения: `pdn_retention_cleanup` в логе пишет
   `{"msg":"pdn_retention_cleanup","deleted":N,"months":24}`; ноль в `deleted` —
   норма, если неактивных пользователей нет.

## Что крон не делает

- Не возвращает звёзды за `rejected`-платежи: это реальные деньги, решение
  принимает владелец (QA-11, `docs/qa/reports/qa-001-initial.md`).
- Не ходит в LLM: генерация разборов — отдельная очередь (см. `docs/report`).
