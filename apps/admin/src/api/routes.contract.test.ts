/*
 * Тест-страж реестра маршрутов. Он не проверяет интерфейс — он проверяет, что
 * панель не врёт себе про то, что умеет бэкенд.
 *
 * Падает в двух случаях:
 *   • маршрут появился в `api.openapi.yaml`, а в реестре ещё `inContract:
 *     false` — экран надо включать;
 *   • маршрут помечен доступным, а в контракте его нет — экран построен на
 *     выдуманном адресе; такое отклоняется на ревью без разговоров.
 */

// Контракт читается через vite-загрузчик `?raw`: тест смотрит ровно в тот же
// `api.openapi.yaml`, из которого генерируется `schema.gen.d.ts`, и при этом не
// тянет node-типы в сборку фронтенда. Если файла нет — импорт упадёт, и тест
// не пройдёт молча.
import contractSource from '../../../../api.openapi.yaml?raw';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROUTES, missingRoutesFor, route } from './routes';
import { callableRoutes } from './http';
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

  it('число отсутствующих маршрутов известно: это список задач бэкенду', () => {
    // Со сменой контракта список обязан сокращаться руками: он и есть перечень
    // того, что панели не разрешено. 1.6.15 забрал вход (3 маршрута) и журнал
    // (1) — было 20, стало 16; 1.6.17 забрал последнюю волну §5 (6) — стало 10.
    const missing = ADMIN_ROUTES.filter((item) => !item.inContract);
    expect(missing).toHaveLength(10);
    expect(missing.map((item) => item.path).sort()).toEqual([
      '/api/v1/admin/plans',
      '/api/v1/admin/plans/{code}',
      '/api/v1/admin/plans/{code}/history',
      '/api/v1/admin/reports',
      '/api/v1/admin/reports/{id}/regenerate',
      '/api/v1/admin/users',
      '/api/v1/admin/users/{id}',
      '/api/v1/admin/users/{id}/ban',
      '/api/v1/admin/users/{id}/push',
      '/api/v1/admin/users/{id}/refund',
    ].sort());
  });

  it('в прод-сборке панель дергает вход и аудит: их нет в списке «недоступно»', () => {
    // Страж сверяется с `paths:` сгенерированного контракта 1.6.15 — этот тест
    // падает и если флаг подняли зря, и если забыли поднять, когда маршрут приехал.
    // `callableRoutes()` — тот же список, по которому `http` пропускает запросы.
    const live = new Set(callableRoutes().map((item) => item.key));
    expect([...live].filter((key) => key.startsWith('auth') || key === 'auditList').sort()).toEqual([
      'auditList',
      'authLogout',
      'authMe',
      'authTelegram',
    ]);
    // Публичные маршруты доступны и до входа — на них стоит «Обзор» без сессии.
    expect(live.has('health')).toBe(true);
    expect(live.has('foundersCount')).toBe(true);
  });

  it('пришедшее в 1.6.15 помечено рабочим: вход и аудит — в боевом списке', () => {
    // Этот тест падает, если кто-то «временно» вернёт флаг назад, и чинится
    // только вместе с реестром: «Сервер ещё не принимает сессии» больше не
    // имеет права появляться как дефолт.
    for (const key of ['authTelegram', 'authMe', 'authLogout', 'auditList']) {
      expect(route(key).inContract, `${key} в 1.6.15 есть — флаг обязан быть поднят`).toBe(true);
    }
  });

  it('панель не дергает маршруты, которых нет: они помечены как отсутствующие', () => {
    // Список отсутствующих маршрутов = задачи бэкенду. Он проверяется, потому
    // что «забыли выключить флаг» — это ровно тот путь, по которому экран
    // начинает показывать выдуманные данные.
    const missing = ADMIN_ROUTES.filter((item) => !item.inContract).map((item) => item.path);
    expect(missing).toEqual(
      expect.arrayContaining([
        '/api/v1/admin/users',
        '/api/v1/admin/users/{id}',
        '/api/v1/admin/users/{id}/refund',
        '/api/v1/admin/users/{id}/push',
        '/api/v1/admin/reports/{id}/regenerate',
        '/api/v1/admin/reports',
        '/api/v1/admin/plans',
        '/api/v1/admin/plans/{code}',
        // 1.6.17: этих шести здесь больше нет — они пришли в контракт и
        // переключены в реестре. Осталось то, что ещё не сделано бэкендом
        // (планы/пользователи/разборы — 1.6.16), это задачи панели.
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
        '/api/v1/admin/auth/telegram',
        '/api/v1/admin/me',
        '/api/v1/admin/auth/logout',
        '/api/v1/admin/audit',
        // 1.6.17: последняя волна §5 — маршруты есть, экраны придут в PR панели.
        '/api/v1/admin/founders',
        '/api/v1/admin/partners',
        '/api/v1/admin/payments',
        '/api/v1/admin/backup/run',
        '/api/v1/admin/telegram/webhook',
        '/api/v1/admin/alerts/{id}/ack',
      ]),
    );
  });

  it('версия контракта в шапке совпадает с api.openapi.yaml', () => {
    expect(config.contractVersion).toBe(contractVersion(source));
  });

  it('несуществующие экраны перечисляют именно отсутствующие маршруты', () => {
    // «Аудит» ушёл в 1.6.15, «Основатели» и «Операции» — в 1.6.17: у них больше
    // нет ни одного отсутствующего маршрута, поэтому ждать маршрутов им нечего.
    const planned = ['users', 'payments', 'plans'] as const;
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
    for (const screen of ['overview', 'codes', 'audit', 'founders', 'ops'] as const) {
      expect(ADMIN_ROUTES.some((item) => item.inContract && item.screens.includes(screen))).toBe(true);
    }
  });

  it('route() не выдумывает маршрут по неизвестному ключу', () => {
    expect(() => route('/api/v1/admin/whatever')).toThrow(/Неизвестный маршрут/);
  });
});
