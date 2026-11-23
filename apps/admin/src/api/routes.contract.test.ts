/*
 * Тест-страж реестра маршрутов. Он не проверяет интерфейс — он проверяет, что
 * панель не врёт себе про то, что умеет бэкенд.
 *
 * Падает в двух случаях:
 *   • маршрут появился в `api.openapi.yaml`, а в реестре ещё `inContract:
 *     false` — экран надо включать;
 *   • маршрут помечен доступным, а в контракте его нет — экран построен на
 *     выдуманном адресе (AGENTS.md §5: «красный флаг»).
 */

// Контракт читается через vite-загрузчик `?raw`: тест смотрит ровно в тот же
// `api.openapi.yaml`, из которого генерируется `schema.gen.d.ts`, и при этом не
// тянет node-типы в сборку фронтенда. Если файла нет — импорт упадёт, и тест
// не пройдёт молча.
import contractSource from '../../../../api.openapi.yaml?raw';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROUTES, missingRoutesFor, route } from './routes';
import { config } from '../env';

const source = contractSource;

/** Ключи секции `paths:` — это и есть список того, что сервер умеет. */
function contractPaths(text: string): Set<string> {
  const paths = new Set<string>();
  let inside = false;
  for (const line of text.split('\n')) {
    if (line === 'paths:') {
      inside = true;
      continue;
    }
    if (inside) {
      if (line !== '' && !line.startsWith('  ')) break;
      const match = /^ {2}(\/[^\s:]+):$/.exec(line);
      if (match?.[1]) paths.add(match[1]);
    }
  }
  return paths;
}

function contractVersion(text: string): string {
  const match = /^info:\n(?:^[ \t].*\n)*?^[ \t]+version:\s*(\S+)\s*$/m.exec(text);
  if (!match?.[1]) throw new Error('В api.openapi.yaml не нашёлся info.version');
  return match[1].replaceAll('"', '');
}

const paths = contractPaths(source);

describe('реестр маршрутов админки', () => {
  it('ключи реестра уникальны', () => {
    expect(new Set(ADMIN_ROUTES.map((item) => item.key)).size).toBe(ADMIN_ROUTES.length);
  });

  it('каждый маршрут реестра описан честно против api.openapi.yaml', () => {
    const wrong = ADMIN_ROUTES.filter((item) => paths.has(item.path) !== item.inContract).map(
      (item) => `${item.method} ${item.path}: в контракте ${paths.has(item.path) ? 'есть' : 'нет'}, в реестре ${item.inContract ? 'есть' : 'нет'}`,
    );
    expect(wrong).toEqual([]);
  });

  it('панель не дергает маршруты, которых нет: они помечены как отсутствующие', () => {
    // Список отсутствует-маршрутов = задачи бэкенду. Он проверяется, потому что
    // «забыли выключить флаг» — это ровно тот путь, по которому экран
    // начинает показывать выдуманные данные.
    const missing = ADMIN_ROUTES.filter((item) => !item.inContract).map((item) => item.path);
    expect(missing).toEqual(
      expect.arrayContaining([
        '/api/v1/admin/auth/telegram',
        '/api/v1/admin/auth/logout',
        '/api/v1/admin/me',
        '/api/v1/admin/users',
        '/api/v1/admin/users/{id}',
        '/api/v1/admin/users/{id}/refund',
        '/api/v1/admin/users/{id}/push',
        '/api/v1/admin/reports/{id}/regenerate',
        '/api/v1/admin/reports',
        '/api/v1/admin/plans',
        '/api/v1/admin/plans/{code}',
        '/api/v1/admin/audit',
        '/api/v1/admin/founders',
        '/api/v1/admin/partners',
        '/api/v1/admin/backup/run',
        '/api/v1/admin/telegram/webhook',
        '/api/v1/admin/alerts/{id}/ack',
      ]),
    );
    for (const path of missing) {
      expect(paths.has(path), `маршрут ${path} уже появился в контракте — реестр устарел`).toBe(false);
    }
  });

  it('то, что панель заявляет рабочим, действительно есть в контракте', () => {
    const used = ADMIN_ROUTES.filter((item) => item.inContract).map((item) => item.path);
    expect(used).toEqual(
      expect.arrayContaining([
        '/api/v1/health',
        '/api/v1/founders/count',
        '/api/v1/admin/metrics',
        '/api/v1/admin/alerts',
        '/api/v1/admin/codes',
        '/api/v1/admin/grants',
      ]),
    );
  });

  it('версия контракта в шапке совпадает с api.openapi.yaml', () => {
    expect(config.contractVersion).toBe(contractVersion(source));
  });

  it('несуществующие экраны перечисляют именно отсутствующие маршруты', () => {
    const planned = ['users', 'payments', 'plans', 'founders', 'ops', 'audit'] as const;
    for (const screen of planned) {
      const missing = missingRoutesFor(screen);
      expect(missing.length, `экран ${screen} обязан ждать хотя бы один маршрут`).toBeGreaterThan(0);
      for (const item of missing) {
        expect(item.inContract).toBe(false);
        expect(paths.has(item.path)).toBe(false);
      }
    }
    // У живых экранов тоже могут быть недостающие маршруты (Обзор ждёт /admin/reports),
    // но хотя бы один рабочий обязан быть.
    for (const screen of ['overview', 'codes'] as const) {
      expect(ADMIN_ROUTES.some((item) => item.inContract && item.screens.includes(screen))).toBe(true);
    }
  });

  it('route() не выдумывает маршрут по неизвестному ключу', () => {
    expect(() => route('/api/v1/admin/whatever')).toThrow(/Неизвестный маршрут/);
  });
});
