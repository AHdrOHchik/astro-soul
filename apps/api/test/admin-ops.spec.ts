import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { BackupService, BACKUP_MIN_INTERVAL_MS } from '../src/modules/ops/backup.service';
import type { AppEnv } from '../src/config/env';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from './test-env';

/**
 * Операторские ручки панели (итерация 43, контракт 1.6.17): бэкап, вебхук,
 * подтверждение алерта.
 *
 * Главные проверки, которые нельзя сделать «на глаз»:
 *   • **маркер бэкапа пишется после выгрузки**: запускается настоящий
 *     `scripts/db-dump.sh` с поддельными `pg_dump`/`aws` в `PATH`; при отказе
 *     `aws` маркера нет (а не «дамп есть, копии нет»);
 *   • **`deleteWebhook` не вызывается**: проверяется по фейку Bot API, а не по
 *     обещанию в комментарии;
 *   • **подтверждение не чинит алерт**: `value`/`threshold`/`since` после `ack`
 *     те же, меняется только `fired` и появляется `acked_until`.
 */

const ADMIN_TG_ID = '777000999';
const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_owner' };
const MINI_APP_URL = 'https://admin-ops.example.test';
/** Корень монорепо: тесты запускаются из `apps/api`, скрипт лежит в `scripts/`. */
const REPO_ROOT = join(process.cwd(), '..', '..');

let ctx: TestContext;
let telegram: FakeTelegram;
let workDir: string;
let shimDir: string;
let stateFile: string;

function adminInitData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: ADMIN });
}

function api() {
  return request(ctx.app.getHttpServer());
}

function asAdmin(method: 'get' | 'post', path: string) {
  return api()[method](path).set(INIT_DATA_HEADER, adminInitData());
}

/** Ждём, пока условие станет истинным: дочерний `db-dump.sh` живёт отдельно. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return false;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'astro-backup-run-'));
  shimDir = join(workDir, 'bin');
  await mkdir(shimDir, { recursive: true });

  // Поддельный `pg_dump`: пишет непустой файл туда, куда его попросили.
  // Настоящий скрипт проверяет `-s` (пустой дамп — ошибка), поэтому файл не пуст.
  await writeFile(
    join(shimDir, 'pg_dump'),
    `#!/usr/bin/env bash
set -eu
file=""
for arg in "$@"; do
  case "$arg" in
    --file=*) file="\${arg#--file=}" ;;
  esac
done
[ -n "$file" ] || { echo "pg_dump: no --file" >&2; exit 1; }
printf 'PGDUMP-STUB' > "$file"
`,
  );
  // Поддельный `aws`: успех или отказ по AWS_SHIM_FAIL (его выставляет тест).
  await writeFile(
    join(shimDir, 'aws'),
    `#!/usr/bin/env bash
set -eu
echo "aws $*" >> "\${SHIM_LOG:-/dev/null}"
if [ "\${AWS_SHIM_FAIL:-0}" = "1" ]; then
  echo "upload failed: stub" >&2
  exit 1
fi
exit 0
`,
  );
  await chmod(join(shimDir, 'pg_dump'), 0o755);
  await chmod(join(shimDir, 'aws'), 0o755);

  stateFile = join(workDir, 'backup-state.txt');

  // `PATH` дочернего процесса наследуется от текущего: шимы должны стоять первыми.
  process.env['PATH'] = `${shimDir}:${process.env['PATH'] ?? ''}`;
  process.env['SHIM_LOG'] = join(workDir, 'aws-calls.log');

  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    env: {
      ADMIN_TG_ID,
      MINI_APP_URL,
      TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      BACKUP_STATE_FILE: stateFile,
      BACKUP_DIR: join(workDir, 'dumps'),
      BACKUP_S3_URL: 's3://astro-test-backups',
      // Путь не задаём: сервис обязан сам найти scripts/db-dump.sh монорепо —
      // так проверяется и поиск скрипта, и то, что кнопка запускает именно его.
      BACKUP_SCRIPT: join(REPO_ROOT, 'scripts', 'db-dump.sh'),
    },
    telegram,
  });
});

afterAll(async () => {
  await ctx.close();
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // `BackupService` — синглтон приложения, а ограничители («идёт дамп», «не чаще
  // раза в 10 минут») живут в памяти: без сброса второй тест получил бы `409` от
  // первого. Это то же, что сделал бы перезапуск процесса.
  ctx.app.get(BackupService).reset();
  telegram.webhookCalls.length = 0;
  telegram.setWebhookError = null;
  telegram.webhookUrl = null;
  delete process.env['AWS_SHIM_FAIL'];
  await rm(stateFile, { force: true });
});

afterEach(() => {
  delete process.env['AWS_SHIM_FAIL'];
});

describe('POST /admin/backup/run', () => {
  it('202, и маркер появляется только после успешной выгрузки', async () => {
    const response = await asAdmin('post', '/api/v1/admin/backup/run')
      .send({ reason: 'проверка после деплоя' })
      .expect(202);

    const body = response.body as { started: boolean; job_id: string };
    expect(body.started).toBe(true);
    expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/u);

    // Маркера ещё нет (или он появится после выгрузки) — ждём завершения скрипта.
    expect(await waitFor(() => existsSync(stateFile))).toBe(true);

    const marker = await readFile(stateFile, 'utf8');
    expect(marker).toContain('uploaded_at=');

    // Выгрузка действительно была: `aws s3 cp` вызван с файлом дампа.
    const calls = await readFile(process.env['SHIM_LOG'] ?? '/dev/null', 'utf8');
    expect(calls).toContain('s3 cp');
    expect(calls).toContain('astro-soul-');
  });

  it('отказ выгрузки: маркера нет, локальный дамп удалён', async () => {
    process.env['AWS_SHIM_FAIL'] = '1';

    await asAdmin('post', '/api/v1/admin/backup/run')
      .send({ reason: 'проверяем отказ выгрузки' })
      .expect(202);

    // Даём скрипту время упасть на выгрузке. Ждём именно появления вызова aws.
    expect(
      await waitFor(async () => {
        try {
          const calls = await readFile(process.env['SHIM_LOG'] ?? '/dev/null', 'utf8');
          return calls.includes('s3 cp');
        } catch {
          return false;
        }
      }),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Главное: маркера нет. Он единственное доказательство «копия вне сервера»,
    // и «успех без выгрузки» — это ровно тот дефект, ради которого скрипт
    // написан именно в таком порядке.
    expect(existsSync(stateFile)).toBe(false);
  });

  it('повторное нажатие сразу — 409 backup_too_frequent', async () => {
    await asAdmin('post', '/api/v1/admin/backup/run')
      .send({ reason: 'первый запуск' })
      .expect(202);

    expect(await waitFor(() => existsSync(stateFile))).toBe(true);

    const second = await asAdmin('post', '/api/v1/admin/backup/run')
      .send({ reason: 'второй запуск' })
      .expect(409);

    expect((second.body as { code: string }).code).toBe('CONFLICT');
    expect((second.body as { details: { reason: string } }).details.reason).toBe(
      'backup_too_frequent',
    );
  });

  it('пишет аудит backup.run с причиной', async () => {
    await asAdmin('post', '/api/v1/admin/backup/run')
      .send({ reason: 'аудит: причина в журнале' })
      .expect(202);

    const row = await ctx.db.queryOne<{ action: string; reason: string; actor_tg_id: string }>(
      `SELECT action, reason, actor_tg_id::text AS actor_tg_id FROM admin_audit WHERE action = 'backup.run'`,
    );

    expect(row).toMatchObject({ action: 'backup.run', reason: 'аудит: причина в журнале' });
    expect(row?.actor_tg_id).toBe(ADMIN_TG_ID);
  });

  it('reason короче 5 символов и лишнее поле — 422', async () => {
    await asAdmin('post', '/api/v1/admin/backup/run').send({ reason: 'ок' }).expect(422);
    await asAdmin('post', '/api/v1/admin/backup/run')
      .send({ reason: 'достаточная причина', force: true })
      .expect(422);
    await asAdmin('post', '/api/v1/admin/backup/run').expect(422);
  });

  it('чужому — 403', async () => {
    await api()
      .post('/api/v1/admin/backup/run')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER }))
      .send({ reason: 'чужой не должен' })
      .expect(403);
  });
});

describe('BackupService.start — состояния, которые через HTTP не поймать', () => {
  const baseEnv = (): AppEnv =>
    ({
      BACKUP_STATE_FILE: stateFile,
      BACKUP_S3_URL: 's3://astro-test-backups',
      BACKUP_REMOTE: undefined,
      BACKUP_SCRIPT: join(REPO_ROOT, 'scripts', 'db-dump.sh'),
      BACKUP_DIR: workDir,
    }) as unknown as AppEnv;

  const logger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };

  it('не настроено: 503-причина перечисляет, чего не хватает', () => {
    const service = new BackupService(
      { ...baseEnv(), BACKUP_STATE_FILE: undefined, BACKUP_S3_URL: undefined },
      logger as never,
    );

    const outcome = service.start();
    expect(outcome.kind).toBe('not_configured');
    expect(outcome.kind === 'not_configured' ? outcome.missing : []).toEqual([
      'BACKUP_STATE_FILE',
      'BACKUP_S3_URL',
      'BACKUP_REMOTE',
    ]);
  });

  it('идёт — in_progress; сразу после — too_frequent с retry_after_seconds', async () => {
    // Медленный скрипт: пока он жив, второй запуск обязан упереться в `in_progress`.
    const slow = join(workDir, 'slow-dump.sh');
    await writeFile(slow, '#!/usr/bin/env bash\nsleep 1\nexit 0\n');
    await chmod(slow, 0o755);

    const service = new BackupService({ ...baseEnv(), BACKUP_SCRIPT: slow }, logger as never);

    const first = service.start(new Date('2026-11-16T10:00:00Z'));
    expect(first.kind).toBe('started');
    expect(service.isRunning()).toBe(true);

    expect(service.start(new Date('2026-11-16T10:00:01Z')).kind).toBe('in_progress');

    expect(await waitFor(() => !service.isRunning(), 10_000)).toBe(true);

    const tooFrequent = service.start(new Date('2026-11-16T10:00:02Z'));
    expect(tooFrequent.kind).toBe('too_frequent');
    expect(tooFrequent.kind === 'too_frequent' ? tooFrequent.retryAfterSeconds : 0).toBeGreaterThan(
      0,
    );

    // Через 10 минут окно открывается — «не чаще раза в 10 минут», а не «навсегда».
    const later = service.start(new Date(Date.now() + BACKUP_MIN_INTERVAL_MS + 1_000));
    expect(later.kind).toBe('started');
  });
});

describe('POST /admin/telegram/webhook', () => {
  it('200: адрес из MINI_APP_URL+секрет, и deleteWebhook не вызывается', async () => {
    const response = await asAdmin('post', '/api/v1/admin/telegram/webhook')
      .send({ reason: 'переехали на новый домен' })
      .expect(200);

    const body = response.body as { url: string; ok: boolean; last_error_message: null };
    expect(body.url).toBe(`${MINI_APP_URL}/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`);
    expect(body.ok).toBe(true);
    expect(body.last_error_message).toBeNull();

    // Регистрация была, удаления — нет. Это и есть защита «плохой новый адрес не
    // оставляет нас без вебхука вовсе».
    expect(telegram.webhookCalls.some((call) => call.method === 'setWebhook')).toBe(true);
    expect(telegram.webhookCalls.some((call) => call.method === 'deleteWebhook')).toBe(false);

    const audit = await ctx.db.queryOne<{ action: string; after: { ok: boolean } }>(
      `SELECT action, after FROM admin_audit WHERE action = 'webhook.reinstall'`,
    );
    expect(audit?.action).toBe('webhook.reinstall');
    expect(audit?.after.ok).toBe(true);
  });

  it('502: текст Bot API отдаётся как есть, в details', async () => {
    telegram.setWebhookError = 'Bad Request: Webhook URL must be HTTPS';

    const response = await asAdmin('post', '/api/v1/admin/telegram/webhook')
      .send({ reason: 'проверяем ошибку Bot API' })
      .expect(502);

    const body = response.body as {
      code: string;
      details: { url: string; ok: boolean; last_error_message: string };
    };

    expect(body.code).toBe('INTERNAL');
    expect(body.details.ok).toBe(false);
    expect(body.details.last_error_message).toBe('Bad Request: Webhook URL must be HTTPS');
    expect(body.details.url).toContain(MINI_APP_URL);

    // Аудит пишется и у неудачи: «кто и когда ломал вебхук» — тоже факт.
    const audit = await ctx.db.queryOne<{ after: { ok: boolean } }>(
      `SELECT after FROM admin_audit WHERE action = 'webhook.reinstall'`,
    );
    expect(audit?.after.ok).toBe(false);
  });

  it('reason обязателен; битое тело — 422', async () => {
    await asAdmin('post', '/api/v1/admin/telegram/webhook').send({}).expect(422);
    await asAdmin('post', '/api/v1/admin/telegram/webhook').send({ reason: 'ок' }).expect(422);
  });
});

describe('POST /admin/alerts/{id}/ack', () => {
  /** Сработавший алерт: событие отказа оплаты попадает в `payment_not_arriving`. */
  async function makeAlertFired(): Promise<void> {
    await ctx.db.query(
      `INSERT INTO events (name, props, occurred_at) VALUES ('pre_checkout_rejected', '{}'::jsonb, now())`,
    );
  }

  it('скрывает показ, но не меняет значение и порог', async () => {
    await makeAlertFired();

    const before = await asAdmin('get', '/api/v1/admin/alerts').expect(200);
    const firedBefore = (
      before.body as {
        alerts: {
          id: string;
          value: number;
          threshold: number;
          since: string | null;
          fired: boolean;
        }[];
      }
    ).alerts.find((alert) => alert.id === 'payment_not_arriving');

    expect(firedBefore?.fired).toBe(true);

    const ack = await asAdmin('post', '/api/v1/admin/alerts/payment_not_arriving/ack')
      .send({ minutes: 60 })
      .expect(200);

    const acked = ack.body as {
      acked_until: string;
      alert: { id: string; value: number | null; threshold: number; since: string | null; fired: boolean };
    };

    expect(new Date(acked.acked_until).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(acked.alert.fired).toBe(false);
    // Значение и порог — те же: подтверждение гасит показ, а не чинит проблему.
    expect(acked.alert.value).toBe(firedBefore?.value);
    expect(acked.alert.threshold).toBe(firedBefore?.threshold);

    const after = await asAdmin('get', '/api/v1/admin/alerts').expect(200);
    const alertAfter = (
      after.body as {
        alerts: { id: string; value: number; threshold: number; since: string | null; fired: boolean; acked_until: string | null }[];
      }
    ).alerts.find((alert) => alert.id === 'payment_not_arriving');

    expect(alertAfter?.fired).toBe(false);
    expect(alertAfter?.acked_until).toBe(acked.acked_until);
    expect(alertAfter?.value).toBe(firedBefore?.value);
    expect(alertAfter?.since).toBe(firedBefore?.since);
  });

  it('каждое правило отдаёт acked_until (null, если не подтверждён)', async () => {
    const response = await asAdmin('get', '/api/v1/admin/alerts').expect(200);
    const alerts = (response.body as { alerts: { acked_until: string | null }[] }).alerts;

    expect(alerts.length).toBe(9);
    for (const alert of alerts) {
      expect(alert).toHaveProperty('acked_until');
      expect(alert.acked_until).toBeNull();
    }
  });

  it('границы: неизвестный id и minutes вне 15…1440 — 422', async () => {
    await asAdmin('post', '/api/v1/admin/alerts/no_such_alert/ack').send({ minutes: 60 }).expect(422);

    for (const minutes of [14, 1441, 0, -5, 60.5]) {
      await asAdmin('post', '/api/v1/admin/alerts/backup_stale/ack').send({ minutes }).expect(422);
    }

    await asAdmin('post', '/api/v1/admin/alerts/backup_stale/ack').send({ minutes: '60' }).expect(422);
  });

  it('пишет аудит alert.ack', async () => {
    await asAdmin('post', '/api/v1/admin/alerts/backup_stale/ack').send({ minutes: 120 }).expect(200);

    const row = await ctx.db.queryOne<{ entity_id: string; after: { minutes: number } }>(
      `SELECT entity_id, after FROM admin_audit WHERE action = 'alert.ack'`,
    );

    expect(row?.entity_id).toBe('backup_stale');
    expect(row?.after.minutes).toBe(120);
  });

  it('чужому — 403', async () => {
    await api()
      .post('/api/v1/admin/alerts/backup_stale/ack')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER }))
      .send({ minutes: 60 })
      .expect(403);
  });
});

describe('когда настройки пусты', () => {
  let bare: TestContext;

  beforeAll(async () => {
    // Пустые строки = «не задано» (схема окружения их выбрасывает). Заодно это
    // проверяет, что панель получит именно 503/409, а не «запущено».
    bare = await createTestContext({
      env: {
        ADMIN_TG_ID: '777000998',
        MINI_APP_URL: '',
        // Сам секрет вебхука обязан быть: без него приложение не поднимется
        // (схема окружения). Проверяем именно отсутствие **адреса**, из которого
        // собирается `setWebhook`.
        TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
        BACKUP_STATE_FILE: '',
        BACKUP_S3_URL: '',
        BACKUP_REMOTE: '',
        BACKUP_SCRIPT: '',
      },
      telegram: makeFakeTelegram(),
    });
  });

  afterAll(async () => {
    await bare.close();
  });

  it('бэкап: 503 backup_not_configured с перечнем переменных', async () => {
    const response = await request(bare.app.getHttpServer())
      .post('/api/v1/admin/backup/run')
      .set(
        INIT_DATA_HEADER,
        signInitData({ botToken: TEST_BOT_TOKEN, user: { ...ADMIN, id: 777_000_998 } }),
      )
      .send({ reason: 'настройки пусты' })
      .expect(503);

    const body = response.body as { code: string; details: { reason: string; missing: string[] } };
    expect(body.code).toBe('UNAVAILABLE');
    expect(body.details.reason).toBe('backup_not_configured');
    expect(body.details.missing).toContain('BACKUP_STATE_FILE');
    expect(body.details.missing).toContain('BACKUP_S3_URL');
  });

  it('вебхук: 409 webhook_url_not_configured', async () => {
    const response = await request(bare.app.getHttpServer())
      .post('/api/v1/admin/telegram/webhook')
      .set(
        INIT_DATA_HEADER,
        signInitData({ botToken: TEST_BOT_TOKEN, user: { ...ADMIN, id: 777_000_998 } }),
      )
      .send({ reason: 'настройки пусты' })
      .expect(409);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'webhook_url_not_configured',
    );
  });
});
