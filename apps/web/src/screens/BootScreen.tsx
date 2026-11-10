import { Screen, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { ru } from '../i18n/ru';
import styles from './BootScreen.module.css';

/** Loading state while `GET /me` is on its way. Mirrors the Welcome layout so nothing jumps. */
export function BootScreen() {
  return (
    <Screen busy footer={<Skeleton variant="block" className={styles.button} />}>
      <SkeletonGroup label={ru.common.loading} className={styles.boot}>
        <Skeleton variant="circle" className={styles.emblem} />
        <Skeleton className={styles.title} />
        <Skeleton />
        <Skeleton className={styles.short} />
      </SkeletonGroup>
    </Screen>
  );
}
