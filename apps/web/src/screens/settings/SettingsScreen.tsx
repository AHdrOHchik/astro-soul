import {
  AlertIcon,
  Button,
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
import { CompatQuotaRow } from '../compatibility/CompatQuota';
import { SubscriptionInfo } from './SubscriptionInfo';
import { CompatibilityEntry } from '../compatibility/CompatibilityEntry';
import { CompatibilityHistory } from '../compatibility/CompatibilityHistory';
import { useRequest } from '../../hooks/useRequest';
import { formatMoment } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import type { Telegram } from '../../telegram';
import type { LegalDocument } from '../ConsentScreen';
import styles from './SettingsScreen.module.css';

const copy = ru.settings;
const SKELETON_BLOCKS = [0, 1, 2];
const DOCUMENTS: readonly LegalDocument[] = ['privacy', 'terms'];

export interface SettingsScreenProps {
  api: Pick<Api, 'deleteMe' | 'getCompatibilities' | 'getPlans' | 'cancelSubscription'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'openLink'>;
  /** Loads `Me` anew: the subscription and the quotas are shown as the server has them now. */
  refreshMe: (signal?: AbortSignal) => Promise<Me>;
  /** Where the support button leads; '' while there is no contact. */
  supportLink: string;
  track: Track;
  back?: ScreenProps['back'];
  onOpenDocument: (name: LegalDocument) => void;
  /**
   * The subscribe button: on to the paywall. Absent in a build that sells no subscriptions:
   * the button is then not there, and a subscription the user has is shown as ever.
   */
  onSubscribe?: () => void;
  onOpenCompatibility?: (chartId: string | null) => void;
  onOpenSavedCompatibility?: (compatibilityId: string) => void;
  onBuyCompatibility?: (chartId: string) => void;
  /** The server has deleted everything; the argument is the non-access fact captured when deletion was opened. */
  onDeleted: (hadSubscription: boolean) => void;
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
  onOpenCompatibility,
  onOpenSavedCompatibility,
  onBuyCompatibility,
  onDeleted,
}: SettingsScreenProps) {
  const titleId = useId();
  const request = useRequest(refreshMe);
  const [deleting, setDeleting] = useState(false);
  // Snapshot only for the post-deletion wording; it never grants access or affects deletion.
  const [hadSubscriptionAtDelete, setHadSubscriptionAtDelete] = useState(false);
  const openDeletion = (snapshot?: Me) => {
    const subscription = snapshot?.subscription;
    setHadSubscriptionAtDelete(subscription !== undefined && subscription.is_active && subscription.plan !== 'none');
    setDeleting(true);
  };

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
          onDeleted={() => {
            onDeleted(hadSubscriptionAtDelete);
          }}
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
        api={api}
        support={support}
        telegram={telegram}
        supportLink={supportLink}
        track={track}
        refreshMe={refreshMe}
        onOpenDocument={onOpenDocument}
        onSubscribe={onSubscribe}
        onOpenCompatibility={onOpenCompatibility}
        onOpenSavedCompatibility={onOpenSavedCompatibility}
        onBuyCompatibility={onBuyCompatibility}
        onDelete={() => {
          openDeletion(request.data);
        }}
      />
    );
  const views: Record<ScreenState, (() => ReactNode) | null> = {
    loading: () => (
      <>
        <SkeletonGroup label={copy.loading} className={styles.sections}>
          {SKELETON_BLOCKS.map((block) => (
            <Skeleton key={block} variant="block" className={styles.blockSkeleton} />
          ))}
        </SkeletonGroup>
        <Button
          variant="danger"
          onClick={() => {
            openDeletion();
          }}
        >
          {copy.deletion.open}
        </Button>
      </>
    ),
    error: () =>
      request.status === 'error' && (
        <>
          <ErrorState error={request.error} telegram={telegram} onRetry={request.retry} />
          <Button
            variant="danger"
            onClick={() => {
              openDeletion();
            }}
          >
            {copy.deletion.open}
          </Button>
        </>
      ),
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
  api: Pick<Api, 'getCompatibilities' | 'getPlans' | 'cancelSubscription'>;
  support: ReactNode;
  telegram: Pick<Telegram, 'openLink'>;
  supportLink: string;
  track: Track;
  refreshMe: (signal?: AbortSignal) => Promise<Me>;
  onOpenDocument: (name: LegalDocument) => void;
  onSubscribe?: () => void;
  onOpenCompatibility?: (chartId: string | null) => void;
  onOpenSavedCompatibility?: (compatibilityId: string) => void;
  onBuyCompatibility?: (chartId: string) => void;
  onDelete: () => void;
}

function Sections({ me, api, support, telegram, supportLink, track, refreshMe, onOpenDocument, onSubscribe, onOpenCompatibility, onOpenSavedCompatibility, onBuyCompatibility, onDelete }: SectionsProps) {
  const ids = { subscription: useId(), quotas: useId(), documents: useId(), support: useId(), deletion: useId() };
  return (
    <div className={styles.sections}>
      <Card labelledBy={ids.subscription}>
        <div className={styles.section}>
          <h2 id={ids.subscription} className={styles.title}>
            {copy.subscription.title}
          </h2>
          <SubscriptionInfo
            subscription={me.subscription}
            api={api}
            telegram={telegram}
            supportLink={supportLink}
            track={track}
            refreshMe={refreshMe}
            onSubscribe={onSubscribe}
          />
        </div>
      </Card>

      <Card labelledBy={ids.quotas}>
        <div className={styles.section}>
          <h2 id={ids.quotas} className={styles.title}>
            {copy.quotas.title}
          </h2>
          <Quotas quotas={me.quotas} api={api} />
        </div>
      </Card>

      {onOpenSavedCompatibility && <CompatibilityHistory api={api} onOpen={onOpenSavedCompatibility} chartId={me.chart_id} onBuy={onBuyCompatibility} />}

      {onOpenCompatibility && onBuyCompatibility && (
        <CompatibilityEntry
          api={api}
          chartId={me.chart_id}
          onOpenForm={onOpenCompatibility}
          onBuy={onBuyCompatibility}
        />
      )}

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

function isNamed(code: string): code is Quota['code'] {
  return Object.prototype.hasOwnProperty.call(copy.quotas.names, code);
}

/** «3 of 5 left», or what a limit that is not a number of uses means: -1 is «no limit», never «-1». */
function quotaValue({ used, limit }: Quota): string {
  if (limit < 0) return copy.quotas.unlimited;
  if (limit === 0) return copy.quotas.unavailable;
  return copy.quotas.left(Math.max(0, limit - used), limit);
}

function Quotas({ quotas, api }: { quotas: readonly Quota[]; api: Pick<Api, 'getCompatibilities'> }) {
  // Compatibility has a separate server-owned quota endpoint; never draw its Me.quotas copy.
  const named = quotas.filter((quota) => quota.code !== 'compat_month' && isNamed(quota.code));
  if (named.length === 0) return <ul className={styles.quotas}><CompatQuotaRow api={api} /></ul>;
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
      <CompatQuotaRow api={api} />
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
 * plainly, then the last word, which says once more what goes and what it costs. Only the
 * button of the second one deletes.
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
          // What the deletion does to the subscription stands out on the confirmation that deletes: bold, at full size.
          <p key={paragraph}>{last && paragraph === text.lastTextStrong ? <strong>{paragraph}</strong> : paragraph}</p>
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
