import { haptic } from '../telegram';
import { copy30 } from '../i18n/round30';
import styles from './BottomTabs.module.css';

export type MainTab = 'today' | 'map' | 'ask' | 'cabinet';
const ITEMS: { id: MainTab; label: string }[] = [
  { id: 'today', label: copy30.tabs.today }, { id: 'map', label: copy30.tabs.map }, { id: 'ask', label: copy30.tabs.ask }, { id: 'cabinet', label: copy30.tabs.cabinet },
];
export function BottomTabs({ active, onSelect }: { active: MainTab; onSelect: (tab: MainTab) => void }) {
  return <nav className={styles.nav} aria-label={copy30.tabs.aria}>{ITEMS.map(({ id, label }) => <button type="button" key={id} aria-current={active === id ? 'page' : undefined} className={active === id ? styles.active : ''} onClick={() => { if (active !== id) haptic('selection'); onSelect(id); }}>{label}</button>)}</nav>;
}
