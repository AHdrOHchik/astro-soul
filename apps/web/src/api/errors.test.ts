import { describe, expect, it } from 'vitest';
import { ApiError, fieldErrorsOf } from './errors';

const rejected = (details?: Record<string, unknown>) => new ApiError('VALIDATION_FAILED', { status: 422, details });

describe('fieldErrorsOf', () => {
  it('returns the fields the server rejected, in its order', () => {
    const fields = [
      { field: 'birth_time', message: 'Укажи время рождения или отметь, что не знаешь' },
      { field: 'birth_place', message: 'Выбери город рождения из подсказок' },
    ];
    expect(fieldErrorsOf(rejected({ field_errors: fields }))).toEqual(fields);
  });

  it('skips entries that name no field or carry no text', () => {
    const list = [{ field: 'birth_date' }, { message: 'Текст без поля' }, { field: 'consent', message: '  ' }, null, 'birth_date'];
    expect(fieldErrorsOf(rejected({ field_errors: [...list, { field: 'birth_date', message: 'Сервис доступен с 18 лет' }] }))).toEqual([
      { field: 'birth_date', message: 'Сервис доступен с 18 лет' },
    ]);
  });

  it.each([
    ['no details', rejected()],
    ['details without the list', rejected({ reason: 'chart_create_invalid' })],
    ['a list that is not an array', rejected({ field_errors: { field: 'birth_date', message: 'Нет' } })],
    // Only a validation failure is about fields, whatever else an answer carries.
    ['another code', new ApiError('INTERNAL', { status: 500, details: { field_errors: [{ field: 'birth_date', message: 'Нет' }] } })],
    ['an error that is not from the API', new TypeError('Failed to fetch')],
    ['nothing', undefined],
  ])('is empty for %s', (_name, error) => {
    expect(fieldErrorsOf(error)).toEqual([]);
  });
});
