/*
 * Двухшаговое подтверждение опасных действий (ТЗ §2.3).
 *
 * Второй шаг — не «OK/Отмена» в том же диалоге: `window.confirm()` с текстом
 * «Точно?» снимает ответственность с человека и ничего не доказывает. Здесь два
 * механизма, и оба проверяются тестами:
 *
 *   • `hold` — кнопка нажимается дважды с паузой. Раньше срока второе нажатие
 *     ничего не делает; «вооружение» само сбрасывается, если человек отвлёкся.
 *   • `typed` — значение нужно напечатать (новая цена, сумма возврата). Пока
 *     напечатанное не совпало с серверным, действие не выполняется.
 *
 * Модуль ничего не знает про React и про сеть: это конечный автомат, который
 * можно проверить без DOM. Компоненты обязаны спрашивать разрешение здесь, а не
 * «на глаз» в обработчике клика.
 */

/** Минимальная пауза между первым и вторым нажатием. */
export const HOLD_MS = 2_000;
/** Через сколько «вооружение» сгорает: открытый диалог не должен жить вечно. */
export const ARM_TTL_MS = 15_000;

export type ConfirmMode = 'hold' | 'typed';
export type ConfirmStage = 'idle' | 'armed' | 'done';

export interface ConfirmState {
  readonly mode: ConfirmMode;
  readonly stage: ConfirmStage;
  /** Когда было первое нажатие; `null` — не вооружено. */
  readonly armedAt: number | null;
  /** Что напечатал человек (для `typed`). */
  readonly typed: string;
  /** Сколько осталось ждать до права на второе нажатие, мс. */
  readonly waitMs: number;
  /** Сработал ли сброс по таймауту — чтобы показать причину. */
  readonly expiredOnce: boolean;
}

export interface HoldResult {
  readonly state: ConfirmState;
  /** `true` ровно один раз — во втором своевременном нажатии. */
  readonly execute: boolean;
}

export function createConfirmState(mode: ConfirmMode): ConfirmState {
  return { mode, stage: 'idle', armedAt: null, typed: '', waitMs: 0, expiredOnce: false };
}

/** Первое нажатие вооружает, второе — выполняет. Раньше паузы — не выполняет никогда. */
export function press(state: ConfirmState, now: number): HoldResult {
  if (state.mode !== 'hold') return { state, execute: false };

  if (state.stage !== 'armed' || state.armedAt === null) {
    return { state: { ...state, stage: 'armed', armedAt: now, waitMs: HOLD_MS, expiredOnce: false }, execute: false };
  }

  const waited = now - state.armedAt;
  if (waited < HOLD_MS) {
    // Не сбрасываем: человек уже сделал шаг, пусть видно, сколько осталось.
    return { state: { ...state, waitMs: HOLD_MS - waited }, execute: false };
  }

  return { state: { ...state, stage: 'done', armedAt: null, waitMs: 0 }, execute: true };
}

/** Проверка таймаута: вызывается на тике таймера, пока состояние `armed`. */
export function tick(state: ConfirmState, now: number): ConfirmState {
  if (state.mode !== 'hold' || state.stage !== 'armed' || state.armedAt === null) return state;
  if (now - state.armedAt <= ARM_TTL_MS) return { ...state, waitMs: Math.max(0, HOLD_MS - (now - state.armedAt)) };
  return { ...state, stage: 'idle', armedAt: null, waitMs: 0, expiredOnce: true };
}

export function disarm(state: ConfirmState): ConfirmState {
  return { ...state, stage: 'idle', armedAt: null, waitMs: 0, expiredOnce: false };
}

/** После выполненного действия автомат возвращается в исходное состояние. */
export function settle(state: ConfirmState): ConfirmState {
  return { ...state, stage: 'idle', armedAt: null, waitMs: 0 };
}

export function setTyped(state: ConfirmState, value: string): ConfirmState {
  if (state.mode !== 'typed') return state;
  return { ...state, typed: value };
}

/**
 * Что должно совпасть с введённым. Для цены это новая цена **из ответа сервера**
 * (`price_stars`), а не из поля ввода: иначе «подтверждение» подтверждает
 * опечатку, а не исправляет её.
 */
export function typedMatches(state: ConfirmState, expected: number | string | null | undefined): boolean {
  if (state.mode !== 'typed') return false;
  if (expected === null || expected === undefined) return false;
  return state.typed.trim() === String(expected).trim();
}

/**
 * Разрешено ли выполнить действие прямо сейчас. Это единственная точка, где
 * решение принимается: компонент рисует `disabled`, но и при `onClick` из консоли
 * автомат не пропустит выполнение без второго шага.
 */
export function canExecute(state: ConfirmState, expected: number | string | null | undefined): boolean {
  if (state.mode === 'typed') return typedMatches(state, expected);
  return state.stage === 'done';
}

/** Текст-подсказка у кнопки. */
export function holdHintKey(state: ConfirmState): 'arm' | 'confirm' | 'wait' {
  if (state.mode !== 'hold') return 'confirm';
  if (state.stage === 'armed' && state.waitMs > 0) return 'wait';
  return state.stage === 'armed' ? 'confirm' : 'arm';
}
