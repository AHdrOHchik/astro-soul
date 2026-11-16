import { AlertIcon, Button, Card, FieldMessage, Notice, OptionCard, Progress, Screen, ScreenHeading, SegmentedInput, TextField, type ScreenProps, type Segment } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Api, Compatibility, CompatibilityList, CompatibilityRequest, CompatibilitySection, GeoPlace, Me } from '../../api';
import { fieldErrorsOf, isAbortError, isApiError } from '../../api';
import type { Track } from '../../analytics';
import { Markdown } from '../../components/Markdown';
import { SupportButton } from '../../components/SupportButton';
import { usePlaceSearch } from '../../hooks/usePlaceSearch';
import { formatDayMonth, formatRegion } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import type { IdempotencyKeys } from '../../lib/idempotency';
import type { Telegram } from '../../telegram';
import { CompatibilityEntry } from './CompatibilityEntry';
import styles from './CompatibilityScreen.module.css';

const copy = ru.compatibility;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000] as const;
const RELATIONSHIPS = ['romantic', 'friend', 'family', 'colleague'] as const;
type Relationship = (typeof RELATIONSHIPS)[number];
type DateParts = { day: string; month: string; year: string };
type RequestState = { request: CompatibilityRequest; key: string };

const DATE_SEGMENTS: readonly Segment[] = [
  { id: 'day', label: copy.dateSegments.day, placeholder: copy.dateSegments.dayPlaceholder, length: 2, max: 31 },
  { id: 'month', label: copy.dateSegments.month, placeholder: copy.dateSegments.monthPlaceholder, length: 2, max: 12 },
  { id: 'year', label: copy.dateSegments.year, placeholder: copy.dateSegments.yearPlaceholder, length: 4, max: new Date().getUTCFullYear() },
];
const TIME_SEGMENTS: readonly Segment[] = [
  { id: 'hours', label: copy.timeSegments.hours, placeholder: copy.timeSegments.hoursPlaceholder, length: 2, max: 23 },
  { id: 'minutes', label: copy.timeSegments.minutes, placeholder: copy.timeSegments.minutesPlaceholder, length: 2, max: 59 },
];

export interface CompatibilityScreenProps {
  api: Pick<Api, 'resolveGeo' | 'getCompatibilities' | 'getPlans' | 'orderCompatibility' | 'getCompatibility'>;
  chartId: string | null;
  compatibilityId: string | null;
  onCompatibilityId: (id: string | null) => void;
  keys: IdempotencyKeys;
  limits?: Me['limits'];
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'share' | 'openLink'>;
  supportLink: string;
  track: Track;
  back?: ScreenProps['back'];
  onBuy: (chartId: string) => void;
}

export function CompatibilityScreen({
  api,
  chartId,
  compatibilityId,
  onCompatibilityId,
  keys,
  limits,
  telegram,
  supportLink,
  track,
  back,
  onBuy,
}: CompatibilityScreenProps) {
  const titleId = useId();
  const [relationship, setRelationship] = useState<Relationship>('romantic');
  const [birthDate, setBirthDate] = useState<DateParts>({ day: '', month: '', year: '' });
  const [birthTime, setBirthTime] = useState({ hours: '', minutes: '' });
  const [unknownTime, setUnknownTime] = useState(false);
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState<GeoPlace | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastRequest, setLastRequest] = useState<RequestState | null>(null);
  const [result, setResult] = useState<Compatibility | null>(null);
  const [quota, setQuota] = useState<CompatibilityList['quota'] | null>(null);
  const [pollRetry, setPollRetry] = useState(0);
  const idempotencyKey = useRef({ chartId, key: chartId === null ? '' : keys.current(chartId, 'compat') });
  const activeSubmit = useRef<AbortController | null>(null);
  const minQuery = limits?.geo_min_query_length;
  const maxQuery = limits?.geo_max_query_length;
  const tooLong = maxQuery !== undefined && query.trim().length > maxQuery;
  const search = usePlaceSearch(api, place === null && !tooLong ? query : '', track, minQuery);

  useEffect(() => () => { activeSubmit.current?.abort(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api.getCompatibilities(controller.signal).then(({ quota: freshQuota }) => {
      if (!controller.signal.aborted) setQuota(freshQuota);
    }).catch(() => undefined);
    return () => { controller.abort(); };
  }, [api, compatibilityId]);

  useEffect(() => {
    if (compatibilityId === null) {
      setResult(null);
      return undefined;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const ask = async () => {
      try {
        const fresh = await api.getCompatibility(compatibilityId, controller.signal);
        if (controller.signal.aborted) return;
        setResult(fresh);
        if (fresh.status === 'ready') {
          void api.getCompatibilities(controller.signal).then(({ quota: freshQuota }) => {
            if (!controller.signal.aborted) setQuota(freshQuota);
          }).catch(() => undefined);
        }
        if (fresh.status === 'pending') {
          const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10000;
          attempt += 1;
          timer = setTimeout(() => void ask(), delay);
        }
      } catch (cause) {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setError(cause);
      }
    };
    void ask();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, compatibilityId, pollRetry]);

  const dateString = dateOf(birthDate);
  const dateError = submitted ? (dateString === null ? (Object.values(birthDate).some(Boolean) ? copy.invalidDate : copy.missingDate) : undefined) : undefined;
  const timeString = timeOf(birthTime);
  const timeError = submitted && !unknownTime && timeString === null ? copy.invalidTime : undefined;
  const placeError = submitted && place === null && !tooLong ? copy.missingPlace : undefined;
  const placeSearchError = search.status === 'error' ? fieldErrorsOf(search.error).find(({ field }) => field === 'query')?.message : undefined;

  const buildRequest = (): CompatibilityRequest | null => {
    if (chartId === null || dateString === null || place === null || (!unknownTime && timeString === null)) return null;
    return {
      chart_id: chartId,
      relationship,
      partner: {
        birth_date: dateString,
        birth_time: unknownTime ? null : timeString,
        place: { lat: place.lat, lon: place.lon, tz: place.tz },
      },
    };
  };

  const send = async (pending: RequestState) => {
    setBusy(true);
    setError(null);
    setServerFieldErrors(new Map());
    setLastRequest(pending);
    const controller = new AbortController();
    activeSubmit.current?.abort();
    activeSubmit.current = controller;
    try {
      const accepted = await api.orderCompatibility(pending.request, pending.key, controller.signal);
      if (controller.signal.aborted) return;
      onCompatibilityId(accepted.compatibility_id);
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      const errors = fieldErrorsOf(cause);
      const reason = isApiError(cause) ? cause.details?.reason : undefined;
      if (reason === 'compat_quota_exhausted') track('quota_exhausted', { step: 'compatibility' });
      track('error_shown', { screen: 'compatibility', code: isApiError(cause) ? cause.code : 'NETWORK_ERROR' });
      if (errors.length > 0 && reason !== 'compat_quota_exhausted' && reason !== 'compat_already_owned') {
        const mapped = new Map<string, string>();
        for (const item of errors) mapped.set(fieldAlias(item.field), item.message);
        setServerFieldErrors(mapped);
        setSubmitted(true);
      }
      setError(cause);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const submit = () => {
    setSubmitted(true);
    const request = buildRequest();
    if (request === null) return;
    if (idempotencyKey.current.chartId !== chartId) {
      idempotencyKey.current = { chartId: request.chart_id, key: keys.current(request.chart_id, 'compat') };
    }
    void send({ request, key: idempotencyKey.current.key });
  };

  const createAnother = () => {
    if (chartId === null) return;
    idempotencyKey.current = { chartId, key: keys.renew(chartId, 'compat') };
    onCompatibilityId(null);
    setError(null);
    setLastRequest(null);
    setResult(null);
    setRelationship('romantic');
    setBirthDate({ day: '', month: '', year: '' });
    setBirthTime({ hours: '', minutes: '' });
    setUnknownTime(false);
    setQuery('');
    setPlace(null);
    setSubmitted(false);
    setServerFieldErrors(new Map());
  };

  const retry = () => {
    if (lastRequest !== null) void send(lastRequest);
  };

  if (error !== null && compatibilityId === null && serverFieldErrors.size === 0) {
    const reason = isApiError(error) ? error.details?.reason : undefined;
    const status = isApiError(error) ? error.status : undefined;
    if (status === 422 && reason === 'compat_quota_exhausted') {
      const date = dateFromDetails(error);
      return (
        <Screen back={back}>
          <StateViewCompat title={copy.errorTitle} text={date ? copy.quotaExhausted(date) : copy.quotaExhaustedUnknown}>
            {chartId && <CompatibilityEntry api={api} chartId={chartId} onOpenForm={() => { createAnother(); }} onBuy={onBuy} forcePurchase />}
          </StateViewCompat>
        </Screen>
      );
    }
    if (status === 422 && reason === 'compat_already_owned') {
      return (
        <Screen back={back}>
          <StateViewCompat title={copy.errorTitle} text={copy.alreadyOwned}>
            <Button onClick={() => void openOwned()}>{copy.goTo}</Button>
          </StateViewCompat>
        </Screen>
      );
    }
    if (status === 503 && reason === 'compat_breaker_open') {
      return (
        <Screen back={back}>
          <StateViewCompat title={copy.errorTitle} text={copy.breakerOpen}>
            <Button disabled={busy} onClick={retry}>{copy.retryAgain}</Button>
            <SupportButton link={supportLink} telegram={telegram} />
          </StateViewCompat>
        </Screen>
      );
    }
    return (
      <Screen back={back}>
        <StateViewCompat title={copy.errorTitle} text={copy.genericError}>
          <Button disabled={busy} onClick={retry}>{copy.retryAgain}</Button>
        </StateViewCompat>
      </Screen>
    );
  }

  async function openOwned() {
    try {
      const list = await api.getCompatibilities();
      const owned = list.items.find((item) => item.status !== 'failed');
      if (owned) {
        setError(null);
        onCompatibilityId(owned.id);
      } else setError(new Error('No existing compatibility item was returned'));
    } catch (cause) {
      setError(cause);
    }
  }

  if (compatibilityId !== null && error !== null) {
    return (
      <Screen back={back}>
        <StateViewCompat title={copy.errorTitle} text={copy.genericError}>
          <Button onClick={() => { setError(null); setPollRetry((value) => value + 1); }}>{copy.retryAgain}</Button>
        </StateViewCompat>
      </Screen>
    );
  }

  if (compatibilityId !== null && result?.status === 'ready') {
    const sections = [...result.sections].sort((a, b) => a.order - b.order);
    const depleted = quota?.left === 0;
    const nextDate = quota?.resets_at ? formatDayMonth(quota.resets_at.slice(0, 10)) : null;
    return (
      <Screen labelledBy={titleId} back={back}>
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.title} focusOnMount />
          <p className={styles.note}>{copy.purchaseDisclosure}</p>
          <CompatibilitySections sections={sections} />
          <Button variant="secondary" onClick={() => {
            track('share_clicked');
            try { telegram.share(window.location.origin, copy.shareMessage); } catch { /* sharing never blocks the result */ }
          }}>{copy.share}</Button>
          <Button disabled={depleted} onClick={createAnother}>{copy.createAnother}</Button>
          {depleted && <p className={styles.note}>{nextDate ? copy.quotaNext(nextDate) : copy.quotaNextUnknown}</p>}
        </div>
      </Screen>
    );
  }

  if (compatibilityId !== null && (result === null || result.status === 'pending')) {
    return (
      <Screen labelledBy={titleId} back={back} busy>
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.pendingTitle} text={copy.pendingText} focusOnMount />
          <Progress value={35} label={copy.pendingTitle} />
          <p role="status" className={styles.note}>{copy.pendingText}</p>
        </div>
      </Screen>
    );
  }

  if (compatibilityId !== null && result?.status === 'failed') {
    return (
      <Screen back={back}>
        <StateViewCompat title={copy.errorTitle} text={copy.genericError}>
          <Button onClick={createAnother}>{copy.createAnother}</Button>
        </StateViewCompat>
      </Screen>
    );
  }

  const fieldErrors = serverFieldErrors;
  const dateMessage = fieldErrors.get('birth_date') ?? dateError;
  const timeMessage = fieldErrors.get('birth_time') ?? timeError;
  const selectedPlaceError = fieldErrors.get('place') ?? fieldErrors.get('partner.place') ?? placeError ?? (tooLong ? copy.queryTooLong(maxQuery) : undefined) ?? placeSearchError;
  const relationshipError = fieldErrors.get('relationship');
  const failedSearch = search.status === 'error' && placeSearchError === undefined;

  return (
    <Screen labelledBy={titleId} back={back} busy={busy}>
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={copy.formTitle} focusOnMount />
        {chartId === null ? (
          <Card><p>{copy.emptyChart}</p></Card>
        ) : (
          <>
            <p className={styles.note}>{copy.formPrivacy}</p>
            <p className={styles.note}>{copy.purchaseDisclosure}</p>
            <div className={styles.field} role="radiogroup" aria-label={copy.relationship}>
              <p className={styles.label}>{copy.relationship}</p>
              {RELATIONSHIPS.map((value) => (
                <OptionCard
                  key={value}
                  name="compatibility-relationship"
                  value={value}
                  checked={relationship === value}
                  onSelect={(next) => { setRelationship(next); }}
                  title={copy.relationships[value]}
                />
              ))}
              <FieldMessage id={`${titleId}-relationship`} error={relationshipError} />
            </div>
            <div className={styles.field}>
              <p className={styles.label}>{copy.birthDate}</p>
              <SegmentedInput
                segments={DATE_SEGMENTS}
                values={birthDate}
                separator="."
                invalid={dateMessage !== undefined}
                onChange={(value) => {
                  setBirthDate({ day: value.day ?? '', month: value.month ?? '', year: value.year ?? '' });
                  setServerFieldErrors(new Map());
                }}
              />
              <FieldMessage id={`${titleId}-date`} error={dateMessage} />
            </div>
            <div className={styles.field}>
              <p className={styles.label}>{copy.birthTime}</p>
              <label className={styles.checkbox}>
                <input type="checkbox" checked={unknownTime} onChange={(event) => { setUnknownTime(event.target.checked); }} />
                <span>{copy.unknownTimeLabel}</span>
              </label>
              {unknownTime ? <Notice>{copy.unknownTime}</Notice> : (
                <>
                  <SegmentedInput
                    segments={TIME_SEGMENTS}
                    values={birthTime}
                    separator=":"
                    invalid={timeMessage !== undefined}
                    onChange={(value) => { setBirthTime({ hours: value.hours ?? '', minutes: value.minutes ?? '' }); }}
                  />
                  <FieldMessage id={`${titleId}-time`} error={timeMessage} />
                </>
              )}
            </div>
            <div className={styles.field}>
              <TextField
                label={copy.place}
                value={place?.name ?? query}
                placeholder={copy.placePlaceholder}
                aria-invalid={selectedPlaceError !== undefined}
                onChange={(value) => { setQuery(value); setPlace(null); }}
              />
              <FieldMessage id={`${titleId}-place`} error={selectedPlaceError} hint={search.status === 'loading' ? copy.searching : undefined} live />
              {failedSearch && <p role="alert" className={styles.error}>{copy.searchFailed}</p>}
              {search.status === 'ready' && search.places.map((candidate) => (
                <Button key={`${candidate.name}|${candidate.lat}|${candidate.lon}`} variant="secondary" onClick={() => { setPlace(candidate); setQuery(candidate.name); }}>
                  {candidate.name}{formatRegion(candidate) ? `, ${formatRegion(candidate)}` : ''}
                </Button>
              ))}
              {search.status === 'empty' && <p className={styles.note}>{copy.noPlaces}</p>}
            </div>
            <Button disabled={busy} onClick={submit}>{copy.submit}</Button>
            {error !== null && serverFieldErrors.size === 0 && <p role="alert" className={styles.error}>{copy.formError}</p>}
          </>
        )}
      </div>
    </Screen>
  );

  function StateViewCompat({ title, text, children }: { title: string; text: string; children: ReactNode }) {
    return (
      <div className={styles.state} role="alert">
        <AlertIcon />
        <h1>{title}</h1>
        <p>{text}</p>
        {children}
      </div>
    );
  }
}

function CompatibilitySections({ sections }: { sections: CompatibilitySection[] }) {
  return (
    <div className={styles.sections}>
      {sections.map((section) => (
        <section key={`${section.key}-${String(section.order)}`} className={styles.section}>
          <h2>{section.title}</h2>
          <Markdown text={section.text} />
        </section>
      ))}
    </div>
  );
}

function fieldAlias(field: string): string {
  if (field.endsWith('birth_date')) return 'birth_date';
  if (field.endsWith('birth_time')) return 'birth_time';
  if (field === 'partner.place' || field.startsWith('partner.place.') || field.endsWith('.place') || field.endsWith('.tz')) return 'place';
  if (field.endsWith('relationship')) return 'relationship';
  return field;
}

function dateOf(parts: DateParts): string | null {
  if (!/^\d{1,2}$/.test(parts.day) || !/^\d{1,2}$/.test(parts.month) || !/^\d{4}$/.test(parts.year)) return null;
  const day = Number(parts.day);
  const month = Number(parts.month);
  const year = Number(parts.year);
  if (year < 1900 || year > new Date().getUTCFullYear() || month < 1 || month > 12) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function timeOf(parts: { hours: string; minutes: string }): string | null {
  if (!/^\d{1,2}$/.test(parts.hours) || !/^\d{1,2}$/.test(parts.minutes)) return null;
  const hour = Number(parts.hours);
  const minute = Number(parts.minutes);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : null;
}

function dateFromDetails(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const value = error.details?.resets_at;
  if (typeof value !== 'string') return null;
  return formatDayMonth(value.slice(0, 10));
}

export { BACKOFF_MS as COMPATIBILITY_POLL_DELAYS_MS };
