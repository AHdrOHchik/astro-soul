import { describe, expect, it } from 'vitest';
import {
  ARM_TTL_MS,
  HOLD_MS,
  canExecute,
  createConfirmState,
  disarm,
  holdHintKey,
  press,
  setTyped,
  tick,
  typedMatches,
} from './confirm';

const T0 = 1_000_000;

describe('двухшаговое подтверждение: режим двух нажатий', () => {
  it('первое нажатие не выполняет действие никогда', () => {
    const first = press(createConfirmState('hold'), T0);
    expect(first.execute).toBe(false);
    expect(first.state.stage).toBe('armed');
    expect(canExecute(first.state, null)).toBe(false);
  });

  it('второе нажатие раньше паузы — тоже не выполнение', () => {
    let state = press(createConfirmState('hold'), T0).state;
    const tooEarly = press(state, T0 + HOLD_MS - 1);
    expect(tooEarly.execute).toBe(false);
    expect(tooEarly.state.stage).toBe('armed');
    expect(canExecute(tooEarly.state, null)).toBe(false);
    state = tooEarly.state;
    expect(holdHintKey(state)).toBe('wait');
  });

  it('второе нажатие после паузы выполняет ровно один раз', () => {
    const armed = press(createConfirmState('hold'), T0).state;
    const second = press(armed, T0 + HOLD_MS);
    expect(second.execute).toBe(true);
    expect(second.state.stage).toBe('done');
    // Третье нажатие без «разоружения» не имеет права повторить действие.
    const third = press(second.state, T0 + HOLD_MS * 2);
    expect(third.execute).toBe(false);
  });

  it('вооружение сгорает, и сброс возвращает кнопку в исходное состояние', () => {
    const armed = press(createConfirmState('hold'), T0).state;
    const expired = tick(armed, T0 + ARM_TTL_MS + 1);
    expect(expired.stage).toBe('idle');
    expect(expired.expiredOnce).toBe(true);
    expect(canExecute(expired, null)).toBe(false);
    expect(disarm(armed).stage).toBe('idle');
  });

  it('пока не вооружено — подсказка «подтвердить», и только потом — «ещё раз»', () => {
    expect(holdHintKey(createConfirmState('hold'))).toBe('arm');
    expect(holdHintKey({ ...createConfirmState('hold'), stage: 'armed', armedAt: T0, waitMs: 0 })).toBe('confirm');
  });
});

describe('двухшаговое подтверждение: ручной ввод значения', () => {
  it('без напечатанного значения действие запрещено', () => {
    const state = createConfirmState('typed');
    expect(canExecute(state, 14)).toBe(false);
    expect(typedMatches(state, 14)).toBe(false);
  });

  it('совпадение с серверным значением — единственное, что разблокирует действие', () => {
    const typed = setTyped(createConfirmState('typed'), '14');
    expect(canExecute(typed, 14)).toBe(true);
    expect(canExecute(typed, '14')).toBe(true);
    expect(canExecute(setTyped(createConfirmState('typed'), '149'), 14)).toBe(false);
    expect(canExecute(setTyped(createConfirmState('typed'), '41'), 14)).toBe(false);
    expect(canExecute(setTyped(createConfirmState('typed'), ' 14 '), 14)).toBe(true);
  });

  it('пустое ожидаемое значение не «подтверждается» пустотой', () => {
    expect(canExecute(setTyped(createConfirmState('typed'), ''), null)).toBe(false);
    expect(canExecute(setTyped(createConfirmState('typed'), ''), undefined)).toBe(false);
  });

  it('режимы не пересекаются: ввод не влияет на «два нажатия»', () => {
    expect(setTyped(createConfirmState('hold'), '14').typed).toBe('');
    expect(canExecute(createConfirmState('hold'), 14)).toBe(false);
  });
});
