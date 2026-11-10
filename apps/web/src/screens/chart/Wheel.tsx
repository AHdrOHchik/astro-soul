import { AlertIcon, Button, cx, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useState } from 'react';
import { ru } from '../../i18n/ru';
import styles from './Wheel.module.css';

const copy = ru.chart;

export interface WheelProps {
  /** Absolute URL of the server-rendered SVG. */
  src: string;
  /** Tells the screen whether the picture is known to be broken, e.g. to stop offering to share it. */
  onFailedChange?: (failed: boolean) => void;
}

/**
 * The chart wheel, drawn by the server (`renderWheel` in packages/astro) and
 * shown through <img>, where an SVG cannot run scripts. The square is reserved
 * up front, so the cards below do not move when the picture arrives.
 */
export function Wheel({ src, onFailedChange }: WheelProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  return (
    <div className={styles.frame}>
      {status === 'loading' && (
        <SkeletonGroup label={copy.wheelLoading} className={styles.fill}>
          <Skeleton variant="circle" className={styles.placeholder} />
        </SkeletonGroup>
      )}
      {status === 'error' ? (
        <div className={cx(styles.fill, styles.failed)}>
          <div className={styles.message} role="alert">
            <span className={styles.icon}>
              <AlertIcon />
            </span>
            <p className={styles.title}>{copy.wheelErrorTitle}</p>
            <p className={styles.text}>{copy.wheelErrorText}</p>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setStatus('loading');
              setAttempt((current) => current + 1);
              onFailedChange?.(false);
            }}
          >
            {ru.common.retry}
          </Button>
        </div>
      ) : (
        <img
          // A new key makes the browser request the picture again after a failure.
          key={attempt}
          className={cx(styles.fill, styles.image, status === 'ready' && styles.visible)}
          src={src}
          alt={copy.wheelAlt}
          decoding="async"
          draggable={false}
          onLoad={() => {
            setStatus('ready');
          }}
          onError={() => {
            setStatus('error');
            onFailedChange?.(true);
          }}
        />
      )}
    </div>
  );
}
