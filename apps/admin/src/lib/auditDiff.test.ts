/*
 * Сведение `before`/`after` в строки различий. Чистая функция — потому что
 * именно здесь легче всего начать «дорисовывать» то, чего сервер не присылал.
 */

import { describe, expect, it } from 'vitest';
import { auditDiffs, isServiceActor } from './auditDiff';

describe('auditDiffs', () => {
  it('поля — union по алфавиту, значения как строки', () => {
    expect(auditDiffs({ b: 1, a: 'x' }, { b: 2 })).toEqual([
      { field: 'a', from: 'x', to: '—' },
      { field: 'b', from: '1', to: '2' },
    ]);
  });

  it('пустые снимки — пустой список: экран поставит «—» сам', () => {
    expect(auditDiffs(null, null)).toEqual([]);
    expect(auditDiffs({}, {})).toEqual([]);
    expect(auditDiffs(undefined, null)).toEqual([]);
  });

  it('пустое значение не рисуется пустотой', () => {
    expect(auditDiffs({ note: '' }, { note: null })).toEqual([{ field: 'note', from: '—', to: '—' }]);
  });

  it('вложенные объекты показываются JSONом, а не [object Object]', () => {
    expect(auditDiffs({}, { win: { days: 3 } })).toEqual([{ field: 'win', from: '—', to: '{"days":3}' }]);
  });

  it('порядок ключей в снимке на результат не влияет', () => {
    const a = auditDiffs({ x: 1, y: 2 }, { y: 3, x: 4 });
    const b = auditDiffs({ y: 2, x: 1 }, { x: 4, y: 3 });
    expect(a).toEqual(b);
  });
});

describe('isServiceActor', () => {
  it('нулевой actor — служебная запись, всё остальное — человек', () => {
    expect(isServiceActor('0')).toBe(true);
    expect(isServiceActor('777001')).toBe(false);
    // «0 » с пробелом из строки поиска — не человек и не сервис: пусть будет
    // человек, это честнее, чем выдать чужое действие за планировщик.
    expect(isServiceActor(' 0')).toBe(false);
  });
});
