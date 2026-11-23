/*
 * Мелкие примитивы вёрстки. Никакой дизайн-системы: панель внутренняя, ей
 * нужны таблица, плашка состояния и кнопка — и ничего больше.
 */

import type { ReactNode } from 'react';
import { ru } from '../i18n/ru';

export type BannerLevel = 'crit' | 'warn' | 'ok' | 'info';

export function Banner({ level, title, children }: { level: BannerLevel; title: string; children?: ReactNode }) {
  return (
    <div className={`banner banner--${level}`} role={level === 'crit' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

/** Строка «ничего нет»: пустой список — это не ошибка, и показывать её надо текстом, а не пустотой. */
export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>;
}

export function Panel({
  title,
  anchor,
  onReload,
  busy,
  children,
}: {
  title: string;
  anchor?: string;
  onReload?: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel" aria-labelledby={anchor}>
      <header className="panel__head">
        <h2 id={anchor}>{title}</h2>
        {onReload ? (
          <button type="button" onClick={onReload} disabled={busy}>
            {busy ? ru.app.loading : ru.app.refresh}
          </button>
        ) : null}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Pill({ tone = 'muted', children }: { tone?: 'ok' | 'crit' | 'warn' | 'muted'; children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {hint ? <div className="stat__hint">{hint}</div> : null}
    </div>
  );
}

/** Пары `что — значение` для блоков без таблицы (флаги /health, карточка кода). */
export function KeyValue({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="muted">
        {text}
      </td>
    </tr>
  );
}
