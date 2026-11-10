import styles from './Emblem.module.css';

const SPOKES = Array.from({ length: 12 }, (_, index) => index * 30);

/** Decorative chart-wheel motif. Carries no data, so it is hidden from assistive tech. */
export function Emblem() {
  return (
    <svg className={styles.emblem} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle className={styles.ring} cx="60" cy="60" r="56" />
      <circle className={styles.ring} cx="60" cy="60" r="44" />
      <circle className={styles.core} cx="60" cy="60" r="20" />
      {SPOKES.map((angle) => (
        <line key={angle} className={styles.spoke} x1="60" y1="4" x2="60" y2="16" transform={`rotate(${String(angle)} 60 60)`} />
      ))}
      <circle className={styles.sun} cx="60" cy="60" r="7" />
      <circle className={styles.planet} cx="91" cy="41" r="4" />
      <circle className={styles.planet} cx="33" cy="78" r="3" />
      <circle className={styles.moon} cx="76" cy="86" r="3.5" />
    </svg>
  );
}
