/*
 * Три маленькие вещи, на которых держится панель: роутер, буфер обмена и
 * «что считать пустым/недоступным». Каждая — без React, чтобы падала на
 * конкретной причине, а не на «где-то в дереве».
 */

import { describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';
import { parseHash, toHref } from './router';
import { failed, isOk, loading, ok, unavailable } from '../api/state';
import { ApiError } from '../api/errors';

describe('роутер на хэше', () => {
  it('неизвестный адрес ведёт на Обзор, а не на пустоту', () => {
    expect(parseHash('#/нет-такого').screen).toBe('overview');
    expect(parseHash('').screen).toBe('overview');
  });

  it('читает query и отдаёт его экрану', () => {
    const location = parseHash('#/users?telegram_id=42');
    expect(location.screen).toBe('users');
    expect(location.query.telegram_id).toBe('42');
  });

  it('пустые параметры в ссылку не попадают', () => {
    expect(toHref('users', { telegram_id: '42', empty: '' })).toBe('#/users?telegram_id=42');
    expect(toHref('overview')).toBe('#/overview');
  });
});

describe('буфер обмена', () => {
  it('пустое значение не копируется', async () => {
    const writeText = vi.fn();
    expect(await copyText('', { writeText } as unknown as Clipboard)).toBe('unsupported');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('без Clipboard API — честный «unsupported», а не «скопировано»', async () => {
    expect(await copyText('K7M2P9X4', undefined)).toBe('unsupported');
  });

  it('отказ браузера не превращается в успех', async () => {
    const clipboard = { writeText: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) };
    expect(await copyText('K7M2P9X4', clipboard as unknown as Clipboard)).toBe('denied');
  });
});

describe('состояния блока', () => {
  it('unavailable и error — не ok', () => {
    expect(loading<number>().kind).toBe('loading');
    expect(isOk(loading<number>())).toBe(false);
    expect(isOk(ok(1))).toBe(true);
    expect(failed<number>(new ApiError({ code: 'INTERNAL', status: 500, message: 'упало' })).kind).toBe('error');
  });

  it('unavailable знает, каких маршрутов не хватает', () => {
    const state = unavailable<number[]>('usersSearch', 'userCard');
    if (state.kind !== 'unavailable') throw new Error('ожидался unavailable');
    expect(state.routes.map((item) => item.path)).toEqual(['/api/v1/admin/users', '/api/v1/admin/users/{id}']);
  });
});
