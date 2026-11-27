import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Страж единственной двери к доступу (итерация 39, контракт 1.6.14).
 *
 * Идея: с появлением третьего источника прав (гранты) проверок стало бы
 * слишком много, и одна забытая означала бы «человек с подарком видит кнопку,
 * а маршрут отвечает 402». Поэтому дверь одна — `AccessService.hasAccess`, — и
 * этот тест следит за ней статически:
 *
 *   • список файлов, где вообще есть `FROM subscriptions`, зафиксирован. Новый
 *     прямой запрос к подпискам вне списка — красный тест, а не «странность,
 *     которую заметят на проде»;
 *   • маршруты-гейты обязаны спрашивать `hasAccess`, а не читать
 *     `entitlements`/`subscriptions` сами;
 *   • модуль грантов не имеет права писать в `subscriptions`: грант — не
 *     подписка, иначе `subscription_cancel_no_charge_id_24h` начнёт врать.
 *
 * Тест намеренно текстовый: он ловит забывчивость, а не поведение. Поведение
 * проверяют `grants.spec.ts`, `compat.spec.ts`, `forecast-day.spec.ts` и
 * `pdf.spec.ts`.
 */

const SRC = join(__dirname, '..', 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }

  return out;
}

/**
 * Убирает `//`- и `/* *\/`-комментарии, чтобы статические стражи не срабатывали
 * на текст объяснений. Грубо, но для «есть ли SQL» этого достаточно: строковые
 * литералы с `//` внутри в этом репозитории встречаются редко и не влияют на
 * искомые шаблоны.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function modulePath(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/**
 * Где прямой запрос к `subscriptions` разрешён и почему.
 *
 * Ключ — путь от `src/`, значение — причина. Список закрытый: добавить сюда
 * строку можно только вместе с объяснением, зачем маршруту подписки, а не
 * права.
 */
const SUBSCRIPTIONS_ALLOWED: Readonly<Record<string, string>> = {
  'modules/billing/billing.repository.ts': 'биллинг — владелец таблицы',
  'modules/billing/subscription-cancel.service.ts': 'отмена подписки',
  'modules/entitlements/entitlements.service.ts': 'слияние источников прав',
  'modules/entitlements/access.service.ts': 'период доступа для окна совместимости',
  // Джоб прогноза: один SQL-предикат `paid` на всю выборку. Здесь `EXISTS
  // (subscriptions) OR EXISTS (grants)` — это производительность (один запрос
  // на батч), а не забытая проверка; рядом стоит такой же `EXISTS` по грантам.
  'modules/engagement/engagement.repository.ts': 'джоб прогноза: пакетный предикат paid',
  // Метрика «сколько совместимостей можно продать» — агрегат по всем
  // пользователям, а не гейт конкретного человека.
  'modules/compat/compat.repository.ts': 'агрегат compat_credits_left',
  // Админ-метрики: считают подписки массово, никого не пуская внутрь.
  'modules/ops/admin-metrics.service.ts': 'админ-метрики',
};

/**
 * Где прямой запрос к `payments` разрешён и почему.
 *
 * Требование round44 звучало как «только `AccessService` и биллинг», но в
 * реальности платёжную таблицу читают ещё три места, и каждое — агрегат, а не
 * гейт: метрики/алерты эксплуатации и две админские выборки. Поэтому список
 * закрытый и с причинами: новый читатель — красный тест, а не «странность».
 */
const PAYMENTS_ALLOWED: Readonly<Record<string, string>> = {
  'modules/billing/billing.repository.ts': 'биллинг — владелец таблицы',
  'modules/billing/subscription-cancel.service.ts': 'отмена подписки сверяет платёж',
  'modules/entitlements/entitlements.service.ts': '`stars_paid_total` в состоянии подписки',
  'modules/ops/admin-metrics.service.ts': 'админ-метрики: возвраты за 24 часа',
  'modules/ops/alerts.service.ts': 'алерт о возвратах',
  'modules/ops/jobs.service.ts': 'ночные джобы',
  'modules/admin-support/admin-users.repository.ts': 'карточка человека в панели',
  'modules/admin-support/admin-directory.repository.ts': 'лента платежей в панели',
};

/**
 * Где разрешено **менять** `subscriptions`. Тот же закрытый список, но по
 * записи: чтение в агрегате — не то же самое, что `INSERT` подписки из
 * маршрута, который на самом деле выдаёт грант.
 */
const SUBSCRIPTIONS_WRITE_ALLOWED: Readonly<Record<string, string>> = {
  'modules/billing/billing.repository.ts': 'оплата и продление',
  'modules/billing/subscription-cancel.service.ts': 'отмена',
  // Удаление аккаунта: подписку надо погасить до удаления пользователя.
  'modules/me/me.service.ts': 'удаление аккаунта',
  // Ночной джоб: истёкшие подписки переводятся в `expired`.
  'modules/ops/jobs.service.ts': 'ночные джобы',
};

/** Файлы-гейты: право проверяется только здесь и только через `hasAccess`. */
const GATE_FILES: readonly string[] = [
  'modules/compat/compat.service.ts',
  'modules/daily/daily-forecast.service.ts',
  'modules/daily/questions.service.ts',
  'modules/pdf/pdf.service.ts',
  'modules/reports/reports.service.ts',
];

describe('единая дверь к доступу', () => {
  it('прямые запросы к `subscriptions` только в разрешённых файлах', () => {
    const found = listTsFiles(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('FROM subscriptions'))
      .map(modulePath)
      .sort();

    expect(found).toEqual(Object.keys(SUBSCRIPTIONS_ALLOWED).sort());
  });

  it('изменять `subscriptions` можно только владельцам', () => {
    const found = listTsFiles(SRC)
      .filter((file) =>
        /(INSERT INTO|UPDATE|DELETE FROM)\s+subscriptions\b/u.test(readFileSync(file, 'utf8')),
      )
      .map(modulePath)
      .sort();

    expect(found).toEqual(Object.keys(SUBSCRIPTIONS_WRITE_ALLOWED).sort());
  });

  it('прямые запросы к `payments` только в разрешённых файлах', () => {
    const found = listTsFiles(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('FROM payments'))
      .map(modulePath)
      .sort();

    expect(found).toEqual(Object.keys(PAYMENTS_ALLOWED).sort());
  });

  /**
   * Второй двери для разбора быть не должно (итерация 44).
   *
   * Дефект, который поймал владелец, был ровно про это: `entitlements`
   * читались в двух местах — в двери и в биллинге, — и второе место не знало
   * ни про `single_report`, ни про «всё включено». Человек с правом мог
   * заплатить за то, что у него уже было. Поэтому: «надо ли платить» отвечает
   * `AccessService`, а биллинг **обязан** спрашивать именно его.
   */
  it('биллинг спрашивает дверь, а не считает право сам', () => {
    const billing = readFileSync(join(SRC, 'modules/billing/billing.service.ts'), 'utf8');

    expect(billing).toMatch(/this\.access\.hasAccess\(/u);
    // Прежний второй гейт (`hasActiveReportGrant` читал `entitlements` прямо в
    // репозитории биллинга) удалён; его возвращение — красный тест.
    // Считаем вызовом, а не упоминанием: в комментарии объяснено, почему его
    // больше нет, и запрещать само слово было бы шумом.
    expect(billing).not.toMatch(/hasActiveReportGrant\s*\(/u);
    expect(billing).not.toContain('FROM entitlements');
  });

  it('каждый гейт спрашивает `AccessService`, а не таблицы', () => {
    // Не обязательно `hasAccess`: окно совместимости считается по
    // `accessPeriod` + `quotaOf`, а подаренное право гасится
    // `consumeSingleCompat`. С 1.6.19 у разбора своя функция —
    // `reportAccess`: она отдаёт не «да/нет», а решение с источником, и
    // именно его показывает `/me.report_access`. Два разных ответа на один
    // вопрос — это и был дефект round45, поэтому гейт обязан спрашивать
    // дверь, но не обязан спрашивать `hasAccess` буквально.
    const offenders: string[] = [];

    for (const file of GATE_FILES) {
      const text = readFileSync(join(SRC, file), 'utf8');

      if (
        !/this\.access\.(hasAccess|reportAccess|accessPeriod|consumeSingleCompat|singleCompatLeft)\(/u.test(
          text,
        )
      ) {
        offenders.push(`${file}: не спрашивает AccessService`);
      }
      if (text.includes('FROM subscriptions')) {
        offenders.push(`${file}: читает subscriptions напрямую`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('модуль грантов не пишет в подписки', () => {
    const offenders = listTsFiles(join(SRC, 'modules', 'grants'))
      .filter((file) => /INSERT INTO subscriptions|UPDATE subscriptions/u.test(readFileSync(file, 'utf8')))
      .map(modulePath);

    expect(offenders).toEqual([]);
  });

  /**
   * Бан — тоже дверь, и она должна стоять в том же месте (1.6.16).
   *
   * Если `banned_at` читает кто-то ещё (маршрут, джоб, «удобная» проверка в
   * сервисе), то однажды появится путь, который бана не видит. Поэтому запрос к
   * `users.banned_at` разрешён ровно в одном файле — `AccessService`.
   */
  it('`users.banned_at` читается только в `AccessService`', () => {
    // Смотрим на **SQL**, а не на имя поля: `banned_at` встречается и в DTO, и в
    // комментариях, и запрещать слово бессмысленно. Значимо другое — кто именно
    // ходит в таблицу `users` за этим флагом.
    const found = listTsFiles(SRC)
      .filter((file) => /(?:FROM|UPDATE|INSERT INTO)\s+users\b[\s\S]{0,400}?banned_at/u.test(
        stripComments(readFileSync(file, 'utf8')),
      ))
      .map(modulePath)
      .sort();

    // Запись бана живёт в админском репозитории, чтение — только в двери
    // доступа. Оба адреса закрытые и объяснены.
    expect(found).toEqual([
      'modules/admin-support/admin-users.repository.ts',
      'modules/entitlements/access.service.ts',
    ]);
  });

  it('списание одноразового права идёт через `consumeSingle`', () => {
    // Иначе два одновременных нажатия дают два бесплатных разбора.
    const access = readFileSync(join(SRC, 'modules/entitlements/access.service.ts'), 'utf8');

    expect(access).toContain('consumeSingle');
    expect(access).toContain('withTransaction');
  });
});
