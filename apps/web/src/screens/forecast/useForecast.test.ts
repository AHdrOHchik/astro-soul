import { describe, expect, it } from 'vitest';
import { forecast } from '../../test/fixtures';
import { firstSentence, forecastDay } from './useForecast';

describe('firstSentence', () => {
  it.each([
    ['Первое предложение. Второе. Третье.', 'Первое предложение.'],
    ['Спокойный день! Не спеши.', 'Спокойный день!'],
    ['Что важно сегодня? Доделать начатое.', 'Что важно сегодня?'],
    ['Пауза… Потом действие.', 'Пауза…'],
    // A full stop inside a number ends nothing.
    ['Темп ниже на 1.5 шага, и это нормально. Дальше.', 'Темп ниже на 1.5 шага, и это нормально.'],
    // Line breaks and runs of spaces are one space: the card has one line.
    ['  Первая\nстрока   текста.\n\nВторая.  ', 'Первая строка текста.'],
  ])('%j → %j', (text, expected) => {
    expect(firstSentence(text)).toBe(expected);
  });

  it('is the whole text when no sentence ends in it', () => {
    expect(firstSentence('Текст без точки')).toBe('Текст без точки');
    expect(firstSentence('')).toBe('');
  });
});

describe('forecastDay', () => {
  // 22:30 UTC on 10 November: the 11th in Moscow, the 10th in Amsterdam.
  const evening = new Date('2026-11-10T22:30:00Z');

  it('is today when the date of the forecast is the calendar day at the birth place', () => {
    expect(forecastDay({ ...forecast, date: '2026-11-11' }, 'Europe/Moscow', evening)).toEqual({ today: true, day: '11 ноября' });
    expect(forecastDay({ ...forecast, date: '2026-11-10' }, 'Europe/Amsterdam', evening)).toEqual({ today: true, day: '10 ноября' });
  });

  it('is not today for any other date: yesterday\'s forecast is named by its day', () => {
    expect(forecastDay({ ...forecast, date: '2026-11-10' }, 'Europe/Moscow', evening)).toEqual({ today: false, day: '10 ноября' });
    expect(forecastDay({ ...forecast, date: '2026-11-11' }, 'Europe/Amsterdam', evening)).toEqual({ today: false, day: '11 ноября' });
  });

  it.each([null, 'Mars/Olympus'])('is not today without a zone to count the day in (%j): nobody can tell', (zone) => {
    expect(forecastDay({ ...forecast, date: '2026-11-10' }, zone, evening).today).toBe(false);
  });
});
