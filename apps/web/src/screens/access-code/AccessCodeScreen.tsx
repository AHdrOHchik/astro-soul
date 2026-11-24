import { Button, CheckIcon, FieldMessage, Notice, Screen, ScreenHeading, StateView, TextField, type ScreenProps } from '@astro-soul/ui';
import { useId, useState } from 'react';
import type { Track } from '../../analytics';
import { failureCodeOf, isApiError, serverTextOf, type Api, type Entitlements, type Me } from '../../api';
import { Reference } from '../../components/Reference';
import { pluralForm } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import {
  hasUnknownCharacters,
  isValidAccessCode,
  normalizeAccessCode,
  openedGrant,
  refusalCodeOf,
  refusalOf,
  retryAfterMinutesOf,
  type AccessGrant,
} from '../../lib/accessCode';
import { grantWords } from './words';
import styles from './AccessCodeScreen.module.css';

const copy = ru.accessCode;

export interface AccessCodeScreenProps {
  api: Pick<Api, 'activateCode'>;
  /** The rights the app knows before the code: the answer is read as their change. */
  entitlements: Entitlements;
  /** Asks `Me` again once the server confirmed the activation, so the rest of the app sees it. */
  refreshMe?: (signal?: AbortSignal) => Promise<Me>;
  track: Track;
  back?: ScreenProps['back'];
  /** Leaves the screen, from the confirmation as well as with Back. */
  onClose: () => void;
}

/** What stopped the last attempt: the words for the user, and the request id support can look up. */
interface Refusal {
  text: string;
  requestId: string | undefined;
}

/**
 * The refusal, in words the person can act on. The five answers of the contract mean five
 * different things — a typo, a code taken apart, a code of one's own, an expired one, a
 * short one — and each says what to do next. A `401` is the session's own text: this
 * screen does not speak about it in words of its own.
 */
function refusalText(error: unknown): string {
  const refusal = refusalOf(error);
  if (refusal !== null) return copy.errors[refusal];
  if (refusalCodeOf(error) === 'RATE_LIMITED') {
    const minutes = retryAfterMinutesOf(error);
    return minutes === null ? copy.errors.rateLimitedUnknown : copy.errors.rateLimited(minutes, pluralForm(minutes));
  }
  if (refusalCodeOf(error) === 'UNAUTHORIZED') return ru.errors.UNAUTHORIZED.text;
  // The server's own words, e.g. that the monthly budget of free access is spent.
  return serverTextOf(error) ?? copy.errors.unknown;
}

/**
 * Screen: an access code typed by hand. A code is written on a partner's picture or sent
 * as a `pt_` link; someone who has seen the picture has nowhere else to put it.
 *
 * The screen decides nothing about access: the answer to `POST /me/activate-code` is the
 * whole `Me.entitlements`, and the confirmation is drawn from it.
 */
export function AccessCodeScreen({ api, entitlements, refreshMe, track, back, onClose }: AccessCodeScreenProps) {
  const titleId = useId();
  const messageId = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [opened, setOpened] = useState<AccessGrant | null>(null);

  const known = hasUnknownCharacters(code);
  const complete = isValidAccessCode(code);
  // Said only about a value that is long enough to be meant as a code: before that a letter
  // outside the alphabet is just the user being in the middle of typing.
  const fieldError = known && code.length === 8 ? copy.unknownCharacters : null;

  const send = async () => {
    // The button is disabled until then; a stray Enter or a second tap must send nothing.
    if (busy || !complete) return;
    setBusy(true);
    setFailure(null);
    try {
      const after = await api.activateCode(code);
      setOpened(openedGrant(entitlements, after));
      // The code is of no use any more: it does not stay in the field, let alone anywhere else.
      setCode('');
      void refreshMe?.().catch(() => undefined);
    } catch (error) {
      if (!isApiError(error)) console.error(error);
      // An unknown event name would cost the whole batch: this is the contract's own one, and
      // the code is not in it, in whole or in part.
      track('error_shown', { screen: 'access_code', code: failureCodeOf(error) });
      setFailure({ text: refusalText(error), requestId: isApiError(error) ? error.requestId : undefined });
    } finally {
      setBusy(false);
    }
  };

  if (opened !== null) {
    return (
      <Screen labelledBy={titleId} back={back}>
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.successTitle} focusOnMount />
          <StateView role="status" icon={<CheckIcon />} title={grantWords(opened)}>
            <Button onClick={onClose}>{copy.done}</Button>
          </StateView>
        </div>
      </Screen>
    );
  }

  return (
    <Screen labelledBy={titleId} back={back} busy={busy}>
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={copy.title} text={copy.lead} focusOnMount />
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div>
            <TextField
              label={copy.field}
              placeholder={copy.placeholder}
              value={code}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              readOnly={busy}
              aria-invalid={fieldError !== null || undefined}
              aria-describedby={messageId}
              onChange={(value) => {
                setCode(normalizeAccessCode(value));
                // What the server said was about the code as it was.
                setFailure(null);
              }}
            />
            <FieldMessage id={messageId} error={fieldError} hint={copy.hint} />
          </div>
          {failure !== null && (
            <div className={styles.problem} role="alert">
              <Notice tone="warning">{failure.text}</Notice>
              {failure.requestId && <Reference value={failure.requestId} label={ru.common.requestId(failure.requestId)} />}
            </div>
          )}
          <Button type="submit" disabled={!complete || busy}>
            {busy ? copy.submitting : copy.submit}
          </Button>
        </form>
      </div>
    </Screen>
  );
}
