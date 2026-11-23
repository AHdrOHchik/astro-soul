/*
 * Кнопка опасного действия с двумя нажатиями (ТЗ §2.3).
 *
 * Первый клик ничего не делает, кроме «вооружения»; второй выполняет — и только
 * если с первого прошло не меньше `HOLD_MS`. Рановторое нажатие не «считается
 * почти»: оно молча оставляет состояние «первый шаг». Через `ARM_TTL_MS`
 * вооружение сгорает, чтобы не осталось включённым на экране, к которому
 * вернулись через десять минут.
 *
 * Решение принимает `src/lib/confirm.ts` — там же, где оно тестируется. Здесь
 * только отрисовка и таймер: компонент не в праве «разрешить» действие сам.
 */

import { useCallback, useEffect, useReducer, type ReactNode } from 'react';
import { ARM_TTL_MS, HOLD_MS, createConfirmState, disarm, press, tick, type ConfirmState } from '../lib/confirm';
import { ru } from '../i18n/ru';

type Action = { type: 'press'; at: number } | { type: 'tick'; at: number } | { type: 'disarm' };

function reducer(state: ConfirmState, action: Action): ConfirmState {
  switch (action.type) {
    case 'press':
      return press(state, action.at).state;
    case 'tick':
      return tick(state, action.at);
    case 'disarm':
      return disarm(state);
    default:
      return state;
  }
}

export interface HoldConfirmProps {
  /** Что делает действие — текст первой кнопки («Отозвать право»). */
  readonly label: string;
  readonly onExecute: () => void | Promise<void>;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /** Контекст подтверждения: что именно отзывают/возвращают. */
  readonly children?: ReactNode;
}

export function HoldConfirm({ label, onExecute, disabled = false, busy = false, children }: HoldConfirmProps) {
  const [state, dispatch] = useReducer(reducer, 'hold', createConfirmState);

  useEffect(() => {
    if (state.stage !== 'armed') return;
    const timer = setInterval(() => { dispatch({ type: 'tick', at: Date.now() }); }, 250);
    return () => { clearInterval(timer); };
  }, [state.stage]);

  const onClick = useCallback(() => {
    const at = Date.now();
    const { execute } = press(state, at);
    dispatch({ type: 'press', at });
    if (!execute) return;
    // Выполнение разрешено ровно одному нажатию: сразу после него автомат
    // возвращается в исходное состояние, и третье нажатие повторит цикл, а не
    // выполнит действие ещё раз.
    void Promise.resolve(onExecute()).finally(() => { dispatch({ type: 'disarm' }); });
  }, [onExecute, state]);

  const remaining = Math.ceil(state.waitMs / 1000);
  const buttonLabel =
    state.stage !== 'armed' ? label : remaining > 0 ? `${ru.confirm.wait} ${remaining} с` : ru.confirm.confirm;

  return (
    <div className="confirm">
      <div>
        <strong>{ru.confirm.holdTitle}</strong>
        <div className="muted">
          {ru.confirm.holdHint} {Math.ceil(HOLD_MS / 1000)} с (сброс через {Math.ceil(ARM_TTL_MS / 1000)} с).{' '}
          {state.expiredOnce ? ru.confirm.expired : ''}
        </div>
        {children}
      </div>
      <div className="row">
        <button type="button" className="danger" onClick={onClick} disabled={disabled || busy}>
          {busy ? ru.app.loading : buttonLabel}
        </button>
        <button type="button" onClick={() => { dispatch({ type: 'disarm' }); }} disabled={busy}>
          {ru.confirm.cancel}
        </button>
      </div>
    </div>
  );
}
