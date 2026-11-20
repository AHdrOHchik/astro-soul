import styles from './Disclaimer.module.css';

export function Disclaimer({ text }: { text: string }) {
  if (text.trim() === '') return null;
  return <p className={styles.text}>{text}</p>;
}
