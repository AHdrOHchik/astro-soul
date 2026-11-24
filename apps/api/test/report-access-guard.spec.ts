import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Страж `Me.report_access` (контракт 1.6.19, задача 4).
 *
 * Идея та же, что у `grants-access-guard.spec.ts`, и причина та же: дефект
 * round44/round45 родился не из одного неверного `if`, а из **двух** мест,
 * которые отвечали на один вопрос по-разному. Поэтому здесь статически
 * зафиксировано:
 *
 *   • блок `report_access` собирается ровно в одной функции (`toReportAccessDto`);
 *   • решение принимает ровно одна функция (`AccessService.reportAccess`), и
 *     список её вызовов закрытый — новый вызов виден ревью как красный тест;
 *   • флаг `entitlements.fullReport` не участвует в решении доступа ни в двери,
 *     ни в биллинге, ни в отчётах: он отвечает на другой вопрос.
 *
 * Тест текстовый: он ловит забывчивость, а не поведение. Поведение проверяют
 * `me-report-access.spec.ts` (шесть состояний), `report-access-grants.spec.ts`
 * (пять фич) и `billing*.spec.ts`.
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

function modulePath(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function sourceOf(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

describe('report_access: одна сборка, одно решение', () => {
  it('блок собирается только в `toReportAccessDto`', () => {
    // Ключ `report_access` в объекте ответа — ровно одно место: `me.service.ts`
    // кладёт готовый блок. Если бы `activate-code` или `founder-claim` собрали
    // свой, ключ появился бы и там — и формы разошлись бы.
    const builders = listTsFiles(SRC).filter((file) =>
      /report_access\s*:/u.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(builders.map(modulePath).sort()).toEqual(['modules/me/me.service.ts']);

    // Snake_case-поля блока строятся в единственной функции.
    const dto = stripComments(sourceOf('modules/entitlements/entitlements.dto.ts'));
    expect(dto).toMatch(/export function toReportAccessDto\(/u);
    expect(dto).toMatch(/available: access\.available/u);

    const mappers = listTsFiles(SRC)
      .filter((file) => /toReportAccessDto/u.test(stripComments(readFileSync(file, 'utf8'))))
      .map(modulePath)
      .sort();

    expect(mappers).toEqual(['modules/entitlements/entitlements.dto.ts', 'modules/me/me.service.ts']);
  });

  it('решение принимает только `AccessService.reportAccess`', () => {
    // Вызовы закрыты списком: каждый — точка, где `available` может разойтись
    // с `/me`. Новый вызов должен появиться вместе с ожиданием в тестах.
    const callers = listTsFiles(SRC)
      .filter((file) => /\.reportAccess\(/u.test(stripComments(readFileSync(file, 'utf8'))))
      .map(modulePath)
      .sort();

    expect(callers).toEqual([
      'modules/entitlements/access.service.ts', // сама дверь (и `hasAccess`)
      'modules/me/me.service.ts', // `Me.report_access`
      'modules/reports/reports.service.ts', // заказ и `GET /reports/{id}`
    ]);
  });

  it('`fullReport` не участвует в решении доступа', () => {
    const access = stripComments(sourceOf('modules/entitlements/access.service.ts'));
    const billing = stripComments(sourceOf('modules/billing/billing.service.ts'));
    const reports = stripComments(sourceOf('modules/reports/reports.service.ts'));

    // В двери допустим только `fullReportChartId` (карта покупки), а не флаг.
    expect(access).not.toMatch(/\.fullReport\b/u);
    expect(access).toMatch(/fullReportChartId/u);

    // Биллинг спрашивает дверь; флаг ему не нужен вовсе.
    expect(billing).not.toMatch(/fullReport\b/u);
    expect(billing).toMatch(/this\.access\.hasAccess\(/u);

    // Отчёты отдают `is_paid` из решения двери, а не из флага прав.
    expect(reports).not.toMatch(/entitlement\.fullReport/u);
    expect(reports).toMatch(/access\.available/u);
  });

  it('`full_report` в правах считается без «всё включено» и без подарков', () => {
    const entitlements = stripComments(sourceOf('modules/entitlements/entitlements.service.ts'));

    // Именно эта строка — предмет 1.6.19: флаг = «есть покупка/готовый разбор».
    expect(entitlements).toMatch(/fullReport: kinds\.has\('report'\) \|\| readyReport !== null/u);
    // Round44 поднимал флаг внутри ветки `all_access`; возврат — красный тест.
    expect(entitlements).not.toMatch(/fullReport: true/u);
  });

  it('`Me.report_access` в контракте необязательное поле со своей схемой', () => {
    const contract = readFileSync(join(__dirname, '../../../api.openapi.yaml'), 'utf8');

    // Необязательность — требование round45: старый клиент живёт без поля.
    expect(contract).toMatch(/^ {2}version: 1\.6\.19$/mu);
    const meSchema = /report_access:\s+\$ref: '#\/components\/schemas\/ReportAccess'/u;
    expect(contract).toMatch(meSchema);
  });
});
