import {
  AlertIcon,
  Button,
  ButtonLink,
  Card,
  DocumentIcon,
  ListButton,
  Notice,
  Screen,
  ScreenHeading,
  Skeleton,
  SkeletonGroup,
  type ScreenProps,
} from '@astro-soul/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Track } from '../../analytics';
import { failureCodeOf, isApiError, serverTextOf, type Api, type Me, type Quota } from '../../api';
import { ErrorState } from '../../components/ErrorState';
import { Reference } from '../../components/Reference';
import { SupportButton } from '../../components/SupportButton';
import { useRequest } from '../../hooks/useRequest';
import { formatDay, formatMoment } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import type { Telegram } from '../../telegram';
import type { LegalDocument } from '../ConsentScreen';
import styles from './SettingsScreen.module.css';

const copy = ru.settings;
const SKELETON_BLOCKS = [0, 1, 2];
const DOCUMENTS: readonly LegalDocument[] = ['privacy', 'terms'];

/**
 * Where Telegram keeps the user's Stars subscriptions. The app cannot cancel one: the API
 * has no such call, and Telegram has no other place for it.
 */
const TELEGRAM_SUBSCRIPTIONS = 'tg://settings/star_subscriptions';

export interface SettingsScreenProps {
  api: Pick<Api, 'deleteMe'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'openLink'>;
  /** Loads `Me` anew: the subscription and the quotas are shown as the server has them now. */
  refreshMe: (signal?: AbortSignal) => Promise<Me>;
  /** Where the support button leads; '' while there is no contact. */
  supportLink: string;
  track: Track;
  back?: ScreenProps['back'];
  onOpenDocument: (name: LegalDocument) => void;
  /** The subscribe button: on to the paywall. */
  onSubscribe: () => void;
  /** The server has deleted everything. Nothing of the app's state is true any more. */
  onDeleted: () => void;
}

/** The states every screen of the app is checked for. */
type ScreenState = 'loading' | 'empty' | 'error' | 'locked' | 'ready';

/**
 * Screen 9: the subscription, the quotas, the documents, support, and the deletion of
 * everything the server keeps about the user.
 */
export function SettingsScreen({
  api,
  telegram,
  refreshMe,
  supportLink,
  track,
  back,
  onOpenDocument,
  onSubscribe,
  onDeleted,
}: SettingsScreenProps) {
  const titleId = useId();
  const request = useRequest(refreshMe);
  const [deleting, setDeleting] = useState(false);

  const support = <SupportButton link={supportLink} telegram={telegram} />;
  if (deleting) {
    return (
      <Screen back={back}>
        <Deletion
          api={api}
          telegram={telegram}
          support={support}
          track={track}
          onCancel={() => {
            setDeleting(false);
          }}
          onDeleted={onDeleted}
        />
      </Screen>
    );
  }

  let state: Exclude<ScreenState, 'locked'> = request.status;
  if (request.status === 'ready') {
    const { subscription, quotas } = request.data;
    state = subscription.plan === 'none' && quotas.length === 0 ? 'empty' : 'ready';
  }
  const sections = () =>
    request.status === 'ready' && (
      <Sections
        me={request.data}
        support={support}
        onOpenDocument={onOpenDocument}
        onSubscribe={onSubscribe}
        onDelete={() => {
          setDeleting(true);
        }}
      />
    );
  const views: Record<ScreenState, (() => ReactNode) | null> = {
    loading: () => (
      <SkeletonGroup label={copy.loading} className={styles.sections}>
        {SKELETON_BLOCKS.map((block) => (
          <Skeleton key={block} variant="block" className={styles.blockSkeleton} />
        ))}
      </SkeletonGroup>
    ),
    error: () => request.status === 'error' && <ErrorState error={request.error} telegram={telegram} onRetry={request.retry} />,
    // Neither a subscription nor a quota: the two blocks say so, the rest of the screen is as ever.
    empty: sections,
    // Nothing in the settings is sold, so nothing here is ever locked. Declared on purpose: its absence is a decision.
    locked: null,
    ready: sections,
  };

  return (
    <Screen labelledBy={titleId} back={back} busy={state === 'loading'}>
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={copy.title} focusOnMount />
        {views[state]?.()}
      </div>
    </Screen>
  );
}

interface SectionsProps {
  me: Me;
  support: ReactNode;
  onOpenDocument: (name: LegalDocument) => void;
  onSubscribe: () => void;
  onDelete: () => void;
}

function Sections({ me, support, onOpenDocument, onSubscribe, onDelete }: SectionsProps) {
  const ids = { subscription: useId(), quotas: useId(), documents: useId(), support: useId(), deletion: useId() };
  return (
    <div className={styles.sections}>
      <Card labelledBy={ids.subscription}>
        <div className={styles.section}>
          <h2 id={ids.subscription} className={styles.title}>
            {copy.subscription.title}
          </h2>
          <SubscriptionInfo subscription={me.subscription} onSubscribe={onSubscribe} />
        </div>
      </Card>

      <Card labelledBy={ids.quotas}>
        <div className={styles.section}>
          <h2 id={ids.quotas} className={styles.title}>
            {copy.quotas.title}
          </h2>
          <Quotas quotas={me.quotas} />
        </div>
      </Card>

      <section className={styles.section} aria-labelledby={ids.documents}>
        <h2 id={ids.documents} className={styles.title}>
          {copy.documents}
        </h2>
        {DOCUMENTS.map((name) => (
          <ListButton
            key={name}
            icon={<DocumentIcon />}
            title={ru.consent.documents[name]}
            onClick={() => {
              onOpenDocument(name);
            }}
          />
        ))}
      </section>

      <section className={styles.section} aria-labelledby={ids.support}>
        <h2 id={ids.support} className={styles.title}>
          {copy.support}
        </h2>
        {support}
      </section>

      <section className={styles.section} aria-labelledby={ids.deletion}>
        <h2 id={ids.deletion} className={styles.title}>
          {copy.deletion.title}
        </h2>
        <p className={styles.muted}>{copy.deletion.text}</p>
        {/* Deletes nothing: it opens the two confirmations. */}
        <Button variant="danger" onClick={onDelete}>
          {copy.deletion.open}
        </Button>
      </section>
    </div>
  );
}

function SubscriptionInfo({ subscription, onSubscribe }: { subscription: Me['subscription']; onSubscribe: () => void }) {
  const text = copy.subscription;
  if (subscription.plan === 'none' || !subscription.is_active) {
    return (
      <>
        <p>{subscription.plan === 'none' ? text.none : text.ended}</p>
        <Button variant="secondary" onClick={onSubscribe}>
          {text.subscribe}
        </Button>
      </>
    );
  }
  const until = subscription.expires_at === null ? '' : formatDay(subscription.expires_at);
  return (
    <>
      <p>{text.names[subscription.plan]}</p>
      <p className={styles.muted}>
        {until !== '' && `${text.until(until)} `}
        {subscription.auto_renew ? text.renews : text.noRenewal}
      </p>
      <h3 className={styles.subtitle}>{text.cancelTitle}</h3>
      <p className={styles.muted}>{text.cancelText}</p>
      <ButtonLink href={TELEGRAM_SUBSCRIPTIONS}>{text.openTelegram}</ButtonLink>
    </>
  );
}

function isNamed(code: string): code is Quota['code'] {
  return Object.prototype.hasOwnProperty.call(copy.quotas.names, code);
}

/** «3 of 5 left», or what a limit that is not a number of uses means: -1 is «no limit», never «-1». */
function quotaValue({ used, limit }: Quota): string {
  if (limit < 0) return copy.quotas.unlimited;
  if (limit === 0) return copy.quotas.unavailable;
  return copy.quotas.left(Math.max(0, limit - used), limit);
}

function Quotas({ quotas }: { quotas: readonly Quota[] }) {
  // A quota this build has no name for is not shown under its code.
  const named = quotas.filter((quota) => isNamed(quota.code));
  if (named.length === 0) return <p className={styles.muted}>{copy.quotas.empty}</p>;
  return (
    <ul className={styles.quotas}>
      {named.map((quota) => {
        const resets = quota.limit > 0 ? formatMoment(quota.reset_at) : '';
        return (
          <li key={quota.code} className={styles.quota}>
            <span>{copy.quotas.names[quota.code]}</span>
            <span className={styles.quotaValue}>{quotaValue(quota)}</span>
            {resets !== '' && <span className={styles.quotaNote}>{copy.quotas.resets(resets)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

interface DeletionProps {
  api: Pick<Api, 'deleteMe'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  support: ReactNode;
  track: Track;
  onCancel: () => void;
  onDeleted: () => void;
}

/**
 * How long the button that deletes takes no tap once the last confirmation is on screen.
 * A tap repeated by accident, the second half of a double tap, must never be the one that
 * deletes. Where such a tap lands depends on the layout of the moment; when it lands does not.
 */
export const DELETE_GUARD_MS = 1000;

/**
 * The two confirmations of the deletion, one after the other: what exactly goes, said
 * plainly, then the last word. Only the button of the second one deletes.
 */
function Deletion({ api, telegram, support, track, onCancel, onDeleted }: DeletionProps) {
  const text = copy.deletion;
  const titleId = useId();
  const textId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const [last, setLast] = useState(false);
  // The last confirmation has been on screen long enough for its button to mean what it says.
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // Each confirmation is announced as it opens: its question is where a screen reader starts.
  useEffect(() => {
    title.current?.focus();
  }, [last]);

  useEffect(() => {
    if (!last) return undefined;
    const timer = setTimeout(() => {
      setArmed(true);
    }, DELETE_GUARD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [last]);

  const confirm = async () => {
    if (busy || !armed) return;
    setBusy(true);
    setFailure(null);
    try {
      // Not cancelled when the screen is left: the server carries a deletion through once it has
      // started, and the app has to learn how it ended wherever the user is by then.
      await api.deleteMe();
    } catch (error) {
      if (!isApiError(error)) console.error(error);
      // The contract has no event of its own for this: an unknown name would cost the whole batch.
      track('error_shown', { screen: 'settings', code: failureCodeOf(error) });
      setBusy(false);
      setFailure(error);
      return;
    }
    track('data_deleted');
    onDeleted();
  };

  const code = isApiError(failure) ? failure.code : 'INTERNAL';
  const expired = failure !== null && code === 'UNAUTHORIZED';
  let forward: ReactNode;
  if (!last) {
    forward = (
      <Button
        variant="danger"
        onClick={() => {
          setLast(true);
        }}
      >
        {text.next}
      </Button>
    );
  } else if (expired) {
    // Nothing to delete with any more: the way out is to open the app again.
    forward = telegram.isTelegram && (
      <Button
        onClick={() => {
          telegram.close();
        }}
      >
        {ru.common.close}
      </Button>
    );
  } else {
    forward = (
      <Button
        variant="danger"
        disabled={busy || !armed}
        onClick={() => {
          void confirm();
        }}
      >
        {busy ? text.deleting : text.confirm}
      </Button>
    );
  }
  return (
    <div className={styles.dialog} role="alertdialog" aria-labelledby={titleId} aria-describedby={textId}>
      <span className={styles.dialogIcon}>
        <AlertIcon />
      </span>
      <h2 id={titleId} ref={title} className={styles.dialogTitle} tabIndex={-1}>
        {last ? text.lastTitle : text.confirmTitle}
      </h2>
      <div id={textId} className={styles.dialogText}>
        {(last ? text.lastText : text.confirmText).map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      {failure !== null && <DeletionFailure error={failure} support={support} />}
      {/* A set of buttons of its own per confirmation: nothing of the first one is left in the second. */}
      <div key={last ? 'last' : 'first'} className={styles.dialogActions}>
        {forward}
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {text.cancel}
        </Button>
      </div>
    </div>
  );
}

/** Why nothing was deleted. For a 409 the server's own words, as they are, and the way to support. */
function DeletionFailure({ error, support }: { error: unknown; support: ReactNode }) {
  const text = copy.deletion;
  const code = isApiError(error) ? error.code : 'INTERNAL';
  const requestId = isApiError(error) ? error.requestId : undefined;
  let message: string;
  if (code === 'UNAUTHORIZED') message = text.sessionExpired;
  else if (code === 'CONFLICT') message = serverTextOf(error) ?? text.conflict;
  else message = serverTextOf(error) ?? ru.errors[code].text;
  return (
    <div className={styles.failure} role="alert">
      <Notice tone="warning">
        <strong>{text.failedTitle}.</strong> {message}
      </Notice>
      {requestId && <Reference value={requestId} label={ru.common.requestId(requestId)} />}
      {code === 'CONFLICT' && support}
    </div>
  );
}
