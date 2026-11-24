/*
 * Тест-страж реестра маршрутов. Он не проверяет интерфейс — он проверяет, что
 * панель не врёт себе про то, что умеет бэкенд.
 *
 * Падает в трёх случаях:
 *   • маршрут появился в `api.openapi.yaml`, а в реестре ещё `inContract:
 *     false` — экран надо включать;
 *   • маршрут помечен доступным, а в контракте его нет — экран построен на
 *     выдуманном адресе; такое отклоняется на ревью без разговоров;
 *   • экран начал звать адрес из списка «маршрута нет» — заглушка протекла в
 *     запрос.
 *
 * Сверка идёт по паре `МЕТод + путь`, а не по пути: `/api/v1/admin/plans` в
 * контракте есть (`GET`, `PATCH/{code}`), а `POST /api/v1/admin/plans` — нет, и
 * «такого маршрута нет» обязано означать именно это.
 */

// Контракт читается через vite-загрузчик `?raw`: тест смотрит ровно в тот же
// `api.openapi.yaml`, из которого генерируется `schema.gen.d.ts`, и при этом не
// тянет node-типы в сборку фронтенда. Если файла нет — импорт упадёт, и тест
// не пройдёт молча.
import contractSource from '../../../../api.openapi.yaml?raw';
import apiSource from './admin.ts?raw';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROUTES, missingRoutesFor, SCREEN_READINESS, route, type ScreenKey } from './routes';
import { callableRoutes } from './http';
import { config } from '../env';

const source = contractSource;

/** Ключи `paths:` вместе с методами: `GET /api/v1/admin/plans`. */
function contractOperations(text: string): Set<string> {
  const ops = new Set<string>();
  let inside = false;
  let current: string | null = null;
  for (const line of text.split('\n')) {
    if (line === 'paths:') {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line !== '' && !line.startsWith('  ')) break;
    const pathMatch = /^ {2}(\/[^\s:]+):$/.exec(line);
    if (pathMatch?.[1]) {
      current = pathMatch[1];
      continue;
    }
    const methodMatch = /^ {4}(get|post|patch|put|delete):$/.exec(line);
    if (methodMatch?.[1] && current !== null) {
      ops.add(`${methodMatch[1].toUpperCase()} ${current}`);
    }
  }
  return ops;
}

function contractVersion(text: string): string {
  const match = /^info:\n(?:^[ \t].*\n)*?^[ \t]+version:\s*(\S+)\s*$/m.exec(text);
  if (!match?.[1]) throw new Error('В api.openapi.yaml не нашёлся info.version');
  return match[1].replaceAll('"', '');
}

const ops = contractOperations(source);

/** Как реестр называет маршрут: `GET /api/v1/admin/plans`. */
function label(item: { method: string; path: string }): string {
  return `${item.method} ${item.path}`;
}

const missing = ADMIN_ROUTES.filter((item) => !item.inContract);

describe('реестр маршрутов админки', () => {
  it('ключи реестра уникальны', () => {
    expect(new Set(ADMIN_ROUTES.map((item) => item.key)).size).toBe(ADMIN_ROUTES.length);
  });

  it('каждый маршрут реестра описан честно против api.openapi.yaml', () => {
    const wrong = ADMIN_ROUTES.filter((item) => ops.has(label(item)) !== item.inContract).map(
      (item) => `${label(item)}: в контракте ${ops.has(label(item)) ? 'есть' : 'нет'}, в реестре ${item.inContract ? 'есть' : 'нет'}`,
    );
    expect(wrong).toEqual([]);
  });

  it('число отсутствующих маршрутов известно: это список задач бэкенду', () => {
    // Со сменой контракта список обязан сокращаться руками: он и есть перечень
    // того, что панели не разрешено. 1.6.15 забрал вход (3 маршрута) и журнал
    // (1) — было 20, стало 16; 1.6.17 закрыл §5 (6) — стало 10; 1.6.16–1.6.18
    // привезли «Пользователей», «Тарифы» и «Платежи/генерации» (9) — осталось 4.
    // Это то, чего панель просит, но не делает: карточка платежа, CSV, создание
    // тарифа, массовые действия.
    expect(missing).toHaveLength(4);
    expect(missing.map((item) => item.path).sort()).toEqual(
      [
        '/api/v1/admin/payments/{id}',
        '/api/v1/admin/payments/export.csv',
        '/api/v1/admin/plans',
        '/api/v1/admin/users/bulk',
      ].sort(),
    );
  });

  it('в прод-сборке панель дергает вход и аудит: их нет в списке «недоступно»', () => {
    // Страж сверяется с `paths:` сгенерированного контракта — этот тест падает
    // и если флаг подняли зря, и если забыли поднять, когда маршрут приехал.
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

  it('пришедшее в 1.6.15–1.6.18 помечено рабочим: флаги подняты на всех десяти экранах', () => {
    // Этот тест падает, если кто-то «временно» вернёт флаг назад, и чинится
    // только вместе с реестром: «Сервер ещё не принимает сессии» и «ждём
    // /admin/users» больше не имеют права появляться как дефолт.
    for (const key of [
      'authTelegram',
      'authMe',
      'authLogout',
      'auditList',
      // 1.6.16: «Пользователи» и «Тарифы».
      'usersSearch',
      'userCard',
      'userRefund',
      'userBan',
      'userPush',
      'plansList',
      'plansPatch',
      'plansAudit',
      // 1.6.16–1.6.17: «Платежи и генерации», «Основатели», «Эксплуатация».
      'paymentsList',
      'reportsList',
      'reportRegenerate',
      'foundersList',
      'partnersStats',
      'backupNow',
      'webhookSet',
      'alertsAck',
    ]) {
      expect(route(key).inContract, `${key} есть в контракте — флаг обязан быть поднят`).toBe(true);
    }
    // Разбан — не отдельный маршрут: его в `paths:` нет и в реестре тоже нет,
    // и появление `userUnban` здесь означало бы экран на выдуманном адресе.
    expect(ops.has('POST /api/v1/admin/users/{id}/unban')).toBe(false);
    expect(ADMIN_ROUTES.some((item) => item.key === 'userUnban')).toBe(false);
  });

  it('панель не дергает маршруты, которых нет: они помечены как отсутствующие', () => {
    // Список отсутствующих маршрутов = задачи бэкенду. Он проверяется, потому
    // что «забыли выключить флаг» — это ровно тот путь, по которому экран
    // начинает показывать выдуманные данные.
    expect(missing.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        '/api/v1/admin/payments/{id}',
        '/api/v1/admin/payments/export.csv',
        '/api/v1/admin/plans',
        '/api/v1/admin/users/bulk',
      ]),
    );
    for (const item of missing) {
      expect(ops.has(label(item)), `маршрут ${label(item)} уже появился в контракте — реестр устарел`).toBe(false);
    }
  });

  it('заглушка не протечёт в запрос: ни один ключ из списка отсутствующих в AdminApi не вызывается', () => {
    // `createAdminApi` обращается к маршрутам по ключу (`http.call('userCard', …)`),
    // поэтому достаточно посмотреть, что ключей из `GAPS` в тексте нет:
    // запрос на несуществующий адрес не появится «случайно».
    for (const item of missing) {
      expect(apiSource.includes(`'${item.key}'`), `ключ ${item.key} появился в AdminApi — а маршрута нет`).toBe(false);
    }
  });

  it('то, что панель заявляет рабочим, действительно есть в контракте', () => {
    const used = ADMIN_ROUTES.filter((item) => item.inContract).map((item) => label(item));
    expect(used).toEqual(
      expect.arrayContaining([
        'GET /api/v1/health',
        'GET /api/v1/founders/count',
        'GET /api/v1/admin/metrics',
        'GET /api/v1/admin/alerts',
        'GET /api/v1/admin/codes',
        'GET /api/v1/admin/grants',
        'POST /api/v1/admin/auth/telegram',
        'GET /api/v1/admin/me',
        'POST /api/v1/admin/auth/logout',
        'GET /api/v1/admin/audit',
        // 1.6.16–1.6.18: всё, что приехало последней волной.
        'GET /api/v1/admin/users',
        'GET /api/v1/admin/users/{id}',
        'POST /api/v1/admin/users/{id}/refund',
        'POST /api/v1/admin/users/{id}/ban',
        'POST /api/v1/admin/users/{id}/push',
        'GET /api/v1/admin/plans',
        'PATCH /api/v1/admin/plans/{code}',
        'GET /api/v1/admin/plans/{code}/history',
        'GET /api/v1/admin/reports',
        'POST /api/v1/admin/reports/{id}/regenerate',
        'GET /api/v1/admin/payments',
        'GET /api/v1/admin/founders',
        'GET /api/v1/admin/partners',
        'POST /api/v1/admin/backup/run',
        'POST /api/v1/admin/telegram/webhook',
        'POST /api/v1/admin/alerts/{id}/ack',
      ]),
    );
  });

  it('версия контракта в шапке совпадает с api.openapi.yaml', () => {
    expect(config.contractVersion).toBe(contractVersion(source));
  });

  it('готовность раздела согласована с реестром, а список «чего нет» — с контрактом', () => {
    const screens = Object.keys(SCREEN_READINESS) as ScreenKey[];
    for (const screen of screens) {
      const live = ADMIN_ROUTES.some((item) => item.inContract && item.screens.includes(screen));
      // 'ready' — есть хотя бы один живой маршрут, которым экран заполняется.
      // 'waiting-for-routes' — живых нет вовсе, и показывать, кроме ожидания, нечего.
      expect(SCREEN_READINESS[screen] === 'ready', `${screen}: живых маршрутов ${live ? 'нет' : 'есть'}, а флаг другой`).toBe(live);
      for (const item of missingRoutesFor(screen)) {
        expect(item.inContract).toBe(false);
        expect(ops.has(label(item))).toBe(false);
      }
    }
    // Восьми разделов коснулся контракт: «ждём маршруты» не осталось ни у одного.
    expect(screens.filter((screen) => SCREEN_READINESS[screen] === 'waiting-for-routes')).toEqual([]);
    // Четыре пробела — ровно на тех экранах, где они видны текстом «маршрута нет».
    expect(missingRoutesFor('payments').map((item) => item.key).sort()).toEqual(['paymentDetail', 'paymentsExport']);
    expect(missingRoutesFor('plans').map((item) => item.key)).toEqual(['plansCreate']);
    expect(missingRoutesFor('users').map((item) => item.key)).toEqual(['usersBulk']);
    for (const screen of ['overview', 'codes', 'founders', 'ops', 'audit', 'login'] as const) {
      expect(missingRoutesFor(screen), `${screen} не должен врать про отсутствие маршрутов`).toHaveLength(0);
    }
  });

  it('route() не выдумывает маршрут по неизвестному ключу', () => {
    expect(() => route('/api/v1/admin/whatever')).toThrow(/Неизвестный маршрут/);
  });
});
