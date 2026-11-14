import { useEffect, useState } from 'react';
import { ru } from '../i18n/ru';
import styles from './Reference.module.css';

/** How long the word «copied» stays under the code. */
const COPIED_MS = 2000;

export interface ReferenceProps {
  /** What is copied: the request id, a report id. */
  value: string;
  /** The whole line as shown: the name of the code and the code (`ru.common.requestId`). */
  label: string;
}

/**
 * The way every engine has had for years: select the text in a field and ask the document
 * to copy it. Deprecated, and still the one that works where the Clipboard API is absent
 * or refuses: a page not served over https, a WebView that grants no clipboard permission.
 */
function copyBySelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.className = styles.clipboard ?? '';
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the fallback is the point: see above
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

async function copy(text: string): Promise<boolean> {
  try {
    // `navigator.clipboard` is undefined where the page is not a secure context: the call then throws, like a refusal.
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyBySelection(text);
  }
}

/**
 * A code for support, in small print. A tap copies it: nobody retypes a UUID into a chat.
 * Where nothing can copy it, the text can still be selected by hand.
 */
export function Reference({ value, label }: ReferenceProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <button
      type="button"
      className={styles.reference}
      onClick={(event) => {
        const button = event.currentTarget;
        void copy(value).then((done) => {
          // The fallback takes the focus for a moment: back to where the user is.
          button.focus({ preventScroll: true });
          if (done) setCopied(true);
        });
      }}
    >
      <span>{label}</span>
      <span className={styles.copied} role="status">
        {copied ? ru.common.copied : ''}
      </span>
    </button>
  );
}
