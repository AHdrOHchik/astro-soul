import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonLogger, redact } from '../src/common/logger';
import { requestPath } from '../src/common/request-context';
import {
  MASK,
  TELEGRAM_WEBHOOK_PATH,
  maskSecretPath,
  maskSecrets,
  maskWebhookUrl,
} from '../src/common/secret-url';
import { applyTestEnv, TEST_WEBHOOK_SECRET } from './test-env';

/**
 * Б-4, итерация 45: секрет вебхука не должен попадать в логи.
 *
 * Почему это отдельный спек, а не строка в `admin-ops.spec.ts`: утечка была не
 * в одном месте, а в четырёх (access-лог API, access-лог nginx, лог
 * переустановки, аудит админки), и «проверить одну ручку» оставило бы три
 * открытыми. Поэтому проверяется **механизм** (маска внутри логгера и
 * `requestPath`) плюс конфиг nginx как текст.
 *
 * Ловушка, из-за которой утечка жила: ранее считалось, что «логируем `$uri` без
 * query string» = «секретов в логе нет». Секрет вебхука лежит в **пути**, а не
 * в query, поэтому и `$uri`, и `$request_uri`, и `req.path` содержали его
 * целиком.
 */

const URL_WITH_SECRET = `https://app.example.test${TELEGRAM_WEBHOOK_PATH}/${TEST_WEBHOOK_SECRET}`;

function captureLogs(run: () => void): string[] {
  const write = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  };

  try {
    run();
  } finally {
    process.stdout.write = write;
  }

  return lines;
}

afterEach(() => {
  applyTestEnv();
});

describe('Б-4: секрет вебхука не попадает в логи', () => {
  it('логгер вырезает секрет из строки адреса, пути и текста ошибки', () => {
    const line = JSON.stringify(
      redact({
        note: `setWebhook ${URL_WITH_SECRET}`,
        path: `${TELEGRAM_WEBHOOK_PATH}/${TEST_WEBHOOK_SECRET}`,
        error: new Error(`POST ${TELEGRAM_WEBHOOK_PATH}/${TEST_WEBHOOK_SECRET} → 403`),
      }),
    );

    expect(line).not.toContain(TEST_WEBHOOK_SECRET);
    expect(line).toContain(MASK);
    // Адрес читается: видно, куда шёл запрос, и видно, что секрет скрыт.
    expect(line).toContain(TELEGRAM_WEBHOOK_PATH);
  });

  it('ключи url/expected_url/actual_url/request_uri запрещены целиком', () => {
    const result = redact({
      url: URL_WITH_SECRET,
      expected_url: URL_WITH_SECRET,
      actual_url: URL_WITH_SECRET,
      request_uri: `${TELEGRAM_WEBHOOK_PATH}/${TEST_WEBHOOK_SECRET}?x=1`,
    }) as Record<string, unknown>;

    expect(Object.keys(result)).toEqual(['url', 'expected_url', 'actual_url', 'request_uri']);
    for (const value of Object.values(result)) {
      expect(value).toBe('[redacted]');
    }
  });

  it('значение секрета в произвольном поле маскируется по env, а не по ключу', () => {
    // Сценарий из Б-4: адрес не целиком, а отдельным полем — «secret: ...».
    const line = JSON.stringify(redact({ reason: `bad secret ${TEST_WEBHOOK_SECRET} given` }));
    expect(line).not.toContain(TEST_WEBHOOK_SECRET);
    expect(line).toContain(MASK);
  });

  it('access-лог API пишет замаскированный путь (это был открытый канал)', () => {
    expect(
      requestPath({ originalUrl: `${TELEGRAM_WEBHOOK_PATH}/${TEST_WEBHOOK_SECRET}`, path: '' }),
    ).toBe(`${TELEGRAM_WEBHOOK_PATH}/${MASK}`);

    // Хвост после секрета сохраняется: по нему видно, что запрос дошёл до ручки.
    expect(
      requestPath({
        originalUrl: `${TELEGRAM_WEBHOOK_PATH}/${TEST_WEBHOOK_SECRET}/extra`,
        path: '',
      }),
    ).toBe(`${TELEGRAM_WEBHOOK_PATH}/${MASK}/extra`);

    // Обычные пути не меняются — иначе лог перестал бы быть логом.
    expect(requestPath({ originalUrl: '/api/v1/charts?tab=1', path: '' })).toBe('/api/v1/charts');
  });

  it('строку лога переустановки вебхука можно читать: маска вместо адреса', () => {
    const lines = captureLogs(() => {
      const logger = new JsonLogger('info');
      logger.info('telegram_webhook_reinstalled', {
        url: URL_WITH_SECRET,
        confirmed: true,
      });
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(TEST_WEBHOOK_SECRET);
    expect(lines[0]).toContain('telegram_webhook_reinstalled');
  });

  it('маска не зависит от того, как ключ назвали', () => {
    // Прямая проверка обеих функций: имя поля не участвует в решении.
    expect(maskWebhookUrl(URL_WITH_SECRET)).toBe(
      `https://app.example.test${TELEGRAM_WEBHOOK_PATH}/${MASK}`,
    );
    expect(maskWebhookUrl(null)).toBeNull();
    expect(maskSecretPath('/api/v1/me')).toBe('/api/v1/me');
    expect(maskSecrets(TEST_WEBHOOK_SECRET)).toBe(MASK);
  });
});

/** Корень репозитория: спек лежит в apps/api/test. */
const REPO_ROOT = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('Б-4: гарды конфигурации и единственной реализации', () => {
  it('nginx логирует $uri_logged, а не $uri/$request_uri', () => {
    const conf = readFileSync(join(REPO_ROOT, 'docker/nginx.conf'), 'utf8');

    expect(conf).toMatch(/"uri":"\$uri_logged"/);
    expect(conf).not.toMatch(/"uri":"\$uri"/);
    expect(conf).not.toContain('"uri":"$request_uri"');
    // Маска объявлена именно для вебхука, иначе «замаскировать всё» сломало бы лог.
    expect(conf).toMatch(/map \$uri \$uri_logged/);
    expect(conf).toContain(`${TELEGRAM_WEBHOOK_PATH}/${MASK}`);
  });

  it('маску строит только secret-url.ts, а места логирования берут её оттуда', () => {
    const sources = walk(join(REPO_ROOT, 'apps/api/src')).filter((file) => file.endsWith('.ts'));

    // 1) Объявление маскирующей функции ровно одно: второе неизбежно разойдётся
    //    с первым (в main.ts такая копия уже была — она и осталась бы жить).
    const declaring = sources.filter((file) =>
      /function\s+mask(Secrets|WebhookUrl|SecretPath)\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(declaring.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([
      'apps/api/src/common/secret-url.ts',
    ]);

    // 2) Файлы, которые пишут адрес вебхука в лог/аудит, импортируют общую маску.
    for (const relative of [
      'apps/api/src/main.ts',
      'apps/api/src/modules/telegram/telegram-webhook.service.ts',
      'apps/api/src/modules/ops/admin-ops.service.ts',
    ]) {
      expect(readFileSync(join(REPO_ROOT, relative), 'utf8')).toContain('common/secret-url');
    }
  });

  it('адрес вебхука в ответе админки остаётся полным — это решение, не утечка', () => {
    // Ответ админке (`POST /admin/telegram/webhook`) отдаёт настоящий адрес:
    // без него нельзя сверить регистрацию. Маска — только в логах и аудите.
    const source = readFileSync(
      join(REPO_ROOT, 'apps/api/src/modules/ops/admin-ops.service.ts'),
      'utf8',
    );

    expect(source).toContain('return { url, ok: true, last_error_message: null };');
    expect(source).toContain('after: { url: maskWebhookUrl(url)');
  });
});
