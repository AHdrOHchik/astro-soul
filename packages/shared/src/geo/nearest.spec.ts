import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM, findNearestCity, haversineKm } from './nearest';

describe('haversineKm', () => {
  it('Москва — Санкт-Петербург ≈ 630 км', () => {
    const distance = haversineKm(55.7558, 37.6173, 59.9343, 30.3351);
    expect(distance).toBeGreaterThan(600);
    expect(distance).toBeLessThan(660);
  });

  it('одна и та же точка — ноль', () => {
    expect(haversineKm(55.75, 37.61, 55.75, 37.61)).toBe(0);
  });

  it('радиус Земли тот, что в формуле', () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
  });
});

describe('findNearestCity: пояс по координатам', () => {
  it('точка рядом с известным городом отдаёт его пояс', () => {
    // 20 км восточнее Москвы — всё ещё Europe/Moscow.
    const nearest = findNearestCity(55.7558, 37.85, 300);
    expect(nearest?.record.tz).toBe('Europe/Moscow');
    expect(nearest?.distanceKm).toBeLessThan(300);
  });

  it('точка в океане — null, а не «ближайший на глаз»', () => {
    // Середина Тихого океана: до любого города справочника тысячи километров.
    expect(findNearestCity(0, -140, 300)).toBeNull();
  });

  it('порог соблюдается: дальше него города нет', () => {
    // Свой список: в настоящем справочнике рядом с любой точкой есть посёлок,
    // и «ровно 30 км» проверять не на чем.
    const cities = [
      { name: 'Тест-город', country: 'RU', lat: 55.0, lon: 37.0, tz: 'Europe/Moscow' },
    ];
    // Полградуса к северу — около 55 км.
    expect(findNearestCity(55.5, 37.0, 30, cities)).toBeNull();
    expect(findNearestCity(55.5, 37.0, 100, cities)?.record.name).toBe('Тест-город');
  });
});
