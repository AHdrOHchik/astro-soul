import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/db-dump.sh` — бэкап БД (итерация 36, задача 3).
 *
 * `pg_dump` и `aws` подменяются заглушками в `PATH`: проверяется контракт самого
 * скрипта (коды выхода, отсутствие недописанного файла, момент записи маркера,
 * ротация), а не поведение `pg_dump` — его проверять нечего.
 *
 * Скрипт ни разу не вызывается с настоящей базой: у него на входе строка
 * подключения, а на выходе файл и код возврата.
 */

const run = promisify(execFile);
const script = resolve(__dirname, '../../../scripts/db-dump.sh');

interface RunResult {
  readonly code: number;
  readonly stderr: string;
}

async function runDump(env: Record<string, string>): Promise<RunResult> {
  try {
    const { stderr } = await run('bash', [script], {
      env: { ...process.env, ...env },
      cwd: env['WORKDIR'] ?? process.cwd(),
    });
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? '' };
  }
}

let dir: string;
let binDir: string;
let backupDir: string;
// Журнал вызовов заглушек свой у каждого теста: иначе «команду не звали»
// проверить нельзя — в файле останутся строки предыдущего теста.
let seq = 0;
let logPath = '';

/** Заглушка команды: пишет в `$FAKE_LOG` строку «имя аргументы» и отдаёт код из `$FAKE_EXIT_N`. */
async function stub(name: string, body: string): Promise<void> {
  const file = join(binDir, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  await chmod(file, 0o755);
}

const pgDumpOk = `
printf '%s\\n' "$*" >> "$FAKE_LOG"
out=""
for arg in "$@"; do
  case "$arg" in
    --file=*) out="\${arg#--file=}" ;;
  esac
done
printf 'PGDMP fake dump\\n' > "$out"
exit 0
`;

const awsOk = `
printf 'aws %s\\n' "$*" >> "$FAKE_LOG"
exit 0
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'astro-dump-'));
  binDir = join(dir, 'bin');
  backupDir = join(dir, 'backups');
  await mkdir(binDir, { recursive: true });
});

afterAll(() => {
  // Каталог в /tmp: временный по определению, чистить нечего при успехе.
});

beforeEach(async () => {
  seq += 1;
  logPath = join(dir, `calls-${String(seq)}.log`);
  // Каталог бэкапов свой у каждого теста. Раньше он был один на файл, и
  // утверждение «при отказе файла нет» проверяло не отказ, а то, что до него
  // ничего не успели создать: на успешных прогонах в каталоге уже лежал дамп,
  // и в CI (полный `pnpm check`, второй запуск того же набора) пять тестов на
  // отказы краснели из-за чужого файла. Нашла итерация 44.
  backupDir = join(dir, `backups-${String(seq)}`);
  await mkdir(binDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await stub('pg_dump', pgDumpOk);
  await stub('aws', awsOk);
  await stub('scp', `printf 'scp %s\\n' "$*" >> "$FAKE_LOG"\nexit 0`);
});

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    WORKDIR: dir,
    DATABASE_URL: 'postgres://user@example.invalid/db',
    BACKUP_DIR: backupDir,
    BACKUP_STATE_FILE: join(dir, 'state', 'backup-last-success'),
    BACKUP_S3_URL: 's3://bucket/astro-soul',
    FAKE_LOG: logPath,
    ...overrides,
  };
}

async function dumps(): Promise<string[]> {
  const names = await readdir(backupDir);
  return names.filter((name) => name.endsWith('.dump')).sort();
}

describe('db-dump.sh: успешный прогон', () => {
  it('делает датированный дамп, выгружает его и пишет маркер', async () => {
    const marker = join(dir, 'state', 'ok-marker');
    const result = await runDump(baseEnv({ BACKUP_STATE_FILE: marker }));

    expect(result.code).toBe(0);

    const files = await dumps();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^astro-soul-\d{8}T\d{6}Z\.dump$/u);

    // Недописанного файла не осталось: временный переименован.
    const all = await readdir(backupDir);
    expect(all.filter((name) => name.includes('partial'))).toHaveLength(0);

    // Выгрузка была именно этого файла, и до записи маркера.
    const calls = await readFile(logPath, 'utf8');
    expect(calls).toMatch(/^aws s3 cp .*astro-soul-\d{8}T\d{6}Z\.dump s3:\/\/bucket\/astro-soul\/astro-soul-/mu);

    const markerText = await readFile(marker, 'utf8');
    expect(markerText).toContain(`file=${files[0] ?? ''}`);
    expect(markerText).toMatch(/uploaded_at=\d{4}-\d{2}-\d{2}T/u);
  });

  it('ротация: дамп старше 7 дней удаляется, свежий остаётся', async () => {
    const old = join(backupDir, 'astro-soul-20200101T000000Z.dump');
    await writeFile(old, 'old dump\n');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(old, tenDaysAgo, tenDaysAgo);

    const result = await runDump(baseEnv());

    expect(result.code).toBe(0);
    const files = await dumps();
    expect(files).not.toContain('astro-soul-20200101T000000Z.dump');
    expect(files).toHaveLength(1);
  });

  it('выгрузка на отдельный хост через scp тоже считается успехом', async () => {
    const result = await runDump(
      baseEnv({ BACKUP_S3_URL: '', BACKUP_REMOTE: 'backup@example.invalid' }),
    );

    expect(result.code).toBe(0);
    const calls = await readFile(logPath, 'utf8');
    expect(calls).toMatch(/^scp .* backup@example\.invalid:$/mu);
  });
});

describe('db-dump.sh: отказы', () => {
  it('выгрузка не удалась → код 5, маркера нет, дампа в каталоге нет', async () => {
    await stub('aws', 'exit 1');
    const marker = join(dir, 'state', 'failed-marker');

    const result = await runDump(baseEnv({ BACKUP_STATE_FILE: marker }));

    expect(result.code).toBe(5);
    expect(result.stderr).toContain('aws s3 cp не удался');
    expect(await dumps()).toHaveLength(0);
    await expect(stat(marker)).rejects.toThrow();
  });

  it('scp не удался → тоже код 5 и никакого локального файла', async () => {
    await stub('scp', 'exit 1');

    const result = await runDump(baseEnv({ BACKUP_S3_URL: '', BACKUP_REMOTE: 'backup@example.invalid' }));

    expect(result.code).toBe(5);
    expect(await dumps()).toHaveLength(0);
  });

  it('pg_dump упал → код 4 и никакого файла, даже частичного', async () => {
    // Заглушка успевает создать файл и только потом падает: так проверяется,
    // что `partial` убирается, а не просто «pg_dump не создал файл».
    await stub(
      'pg_dump',
      `out=""
for arg in "$@"; do case "$arg" in --file=*) out="\${arg#--file=}" ;; esac; done
printf 'половина дампа\\n' > "$out"
exit 1`,
    );

    const result = await runDump(baseEnv());

    expect(result.code).toBe(4);
    const all = await readdir(backupDir);
    expect(all).toHaveLength(0);
  });

  it('нет места на диске → код 3, дамп не начинается', async () => {
    const result = await runDump(baseEnv({ BACKUP_MIN_FREE_MB: '100000000' }));

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('мало места');
    expect(await dumps()).toHaveLength(0);
    // pg_dump не запускался вовсе: проверка места стоит до дампа.
    await expect(stat(logPath)).rejects.toThrow();
  });

  it('выгрузка не настроена → код 2: локальная копия не считается бэкапом', async () => {
    const result = await runDump(baseEnv({ BACKUP_S3_URL: '', BACKUP_REMOTE: '' }));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('не настроена выгрузка');
    expect(await dumps()).toHaveLength(0);
  });

  it('нет DATABASE_URL → код 2', async () => {
    const result = await runDump(baseEnv({ DATABASE_URL: '' }));

    expect(result.code).toBe(2);
  });

  it('нет pg_dump → код 2, а не «пустой дамп»', async () => {
    const result = await runDump(baseEnv({ PG_DUMP_BIN: 'pg_dump-does-not-exist' }));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('не найден pg_dump');
  });
});
