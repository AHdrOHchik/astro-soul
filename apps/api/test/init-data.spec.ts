import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyInitData, INIT_DATA_MAX_AGE_SECONDS } from '../src/modules/auth/init-data';
import { ApiError } from '../src/common/api-error';
import { signFields, signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

const OTHER_BOT_TOKEN = '987654321:ANOTHER-BOT-TOKEN-for-tests';
/**
 * Фиксированное «сейчас». Раньше здесь был `Date.now()` на уровне модуля,
 * а `signInitData` брал реальные часы: если между этими двумя вызовами
 * переключалась секунда, тесты падали через раз. Теперь часы заморожены
 * на одном мгновении и подпись, и проверка видят одно и то же время.
 */
const NOW_SECONDS = 1_760_000_000;
const nowSeconds = NOW_SECONDS;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW_SECONDS * 1000) });
});

afterEach(() => {
  vi.useRealTimers();
});

function expectUnauthorized(fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe('UNAUTHORIZED');
    expect(apiError.details?.['reason']).toBe(reason);
    return;
  }
  throw new Error('ожидали ошибку UNAUTHORIZED, но проверка прошла');
}

describe('verifyInitData', () => {
  it('принимает валидный initData и достаёт user_id только из подписанных данных', () => {
    const initData = signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });

    const verified = verifyInitData(initData, TEST_BOT_TOKEN, { nowSeconds });

    expect(verified.telegramUserId).toBe(BigInt(FICTIONAL_USER.id));
    expect(verified.user.first_name).toBe(FICTIONAL_USER.first_name);
    expect(verified.authDate).toBeLessThanOrEqual(nowSeconds);
  });

  it('отклоняет битую подпись', () => {
    const initData = signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
    const tampered = initData.replace(/hash=[0-9a-f]+/, 'hash=' + 'a'.repeat(64));

    expect(tampered).not.toBe(initData);
    expectUnauthorized(
      () => verifyInitData(tampered, TEST_BOT_TOKEN, { nowSeconds }),
      'signature_mismatch',
    );
  });

  it('отклоняет подмену user_id: подпись другого пользователя не проходит', () => {
    // initData подписан для «чужого» user_id, но токеном другого бота:
    // подменить user_id в валидной строке нельзя — hash считается по всем полям.
    const foreign = signInitData({
      botToken: TEST_BOT_TOKEN,
      user: { ...FICTIONAL_USER, id: 999_888_777 },
    });
    expect(verifyInitData(foreign, TEST_BOT_TOKEN, { nowSeconds }).telegramUserId).toBe(
      BigInt(999_888_777),
    );

    const stolen = signInitData({
      botToken: OTHER_BOT_TOKEN,
      user: { ...FICTIONAL_USER, id: 999_888_777 },
    });
    expectUnauthorized(
      () => verifyInitData(stolen, TEST_BOT_TOKEN, { nowSeconds }),
      'signature_mismatch',
    );
  });

  it('отклоняет initData с auth_date старше 24 часов', () => {
    const stale = signInitData({
      botToken: TEST_BOT_TOKEN,
      user: FICTIONAL_USER,
      authDate: nowSeconds - INIT_DATA_MAX_AGE_SECONDS - 1,
    });

    expectUnauthorized(() => verifyInitData(stale, TEST_BOT_TOKEN, { nowSeconds }), 'auth_date_too_old');
  });

  it('отклоняет пустой заголовок', () => {
    expectUnauthorized(() => verifyInitData(undefined, TEST_BOT_TOKEN, { nowSeconds }), 'empty');
    expectUnauthorized(() => verifyInitData('   ', TEST_BOT_TOKEN, { nowSeconds }), 'empty');
  });

  it('отклоняет initData без hash и без user', () => {
    const noHash = new URLSearchParams({
      auth_date: String(nowSeconds),
      user: JSON.stringify(FICTIONAL_USER),
    }).toString();
    expectUnauthorized(
      () => verifyInitData(noHash, TEST_BOT_TOKEN, { nowSeconds }),
      'missing_hash',
    );

    // Подпись валидна, но поля user нет: такой initData не даёт пользователя.
    const noUser = signFields(TEST_BOT_TOKEN, { auth_date: String(nowSeconds) });
    expectUnauthorized(() => verifyInitData(noUser, TEST_BOT_TOKEN, { nowSeconds }), 'user_missing');
  });

  it('не принимает auth_date из будущего (перекос часов > 60 с)', () => {
    const future = signInitData({
      botToken: TEST_BOT_TOKEN,
      user: FICTIONAL_USER,
      authDate: nowSeconds + 120,
    });

    expectUnauthorized(
      () => verifyInitData(future, TEST_BOT_TOKEN, { nowSeconds }),
      'auth_date_in_future',
    );
  });
});
