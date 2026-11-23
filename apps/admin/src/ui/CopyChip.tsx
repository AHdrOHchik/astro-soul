import { useCallback, useEffect, useRef, useState } from 'react';
import { ru } from '../i18n/ru';
import { copyText } from '../lib/clipboard';

/**
 * Кнопка «копировать» рядом со значением, которое рисует экран. Сам текст здесь
 * не дублируется намеренно: значение живёт в таблице, и у него должен быть один
 * узел — иначе и человек, и тест не поймут, какое из двух «K7M2P9X4» настоящее.
 *
 * Нужен результат копирования — показываем его на кнопке: админ видит, что
 * пошло не так, не отрываясь от списка.
 */
export function CopyButton({
  value,
  label,
  title,
}: {
  readonly value: string;
  readonly label?: string;
  readonly title?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onClick = useCallback(async () => {
    const outcome = await copyText(value, navigator.clipboard);
    setState(outcome === 'copied' ? 'copied' : 'failed');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setState('idle'); }, 2500);
  }, [value]);

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={value === ''}
      title={state === 'failed' ? ru.codes.create.copyFailed : (title ?? undefined)}
    >
      {state === 'copied' ? ru.codes.create.copied : (label ?? ru.codes.create.copyOne)}
    </button>
  );
}
