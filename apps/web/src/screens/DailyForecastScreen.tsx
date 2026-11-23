import { Button, Screen, ScreenHeading, Skeleton, SkeletonGroup, StateView } from '@astro-soul/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Api, ForecastDay, Me } from '../api';
import { isApiError } from '../api';
import { localDayIn } from '../lib/localDay';
import { config } from '../config';
import { copy30 } from '../i18n/round30';
import { ru } from '../i18n/ru';
import { SupportButton } from '../components/SupportButton';
import { Disclaimer } from '../components/Disclaimer';
import { ShareCardButton } from '../components/ShareCardButton';
import type { Track } from '../analytics';
import styles from './DailyForecastScreen.module.css';
import type { Telegram } from '../telegram';

export interface DailyForecastScreenProps {
  api: Pick<Api, 'getForecastToday' | 'getMe' | 'createShareCard'>;
  chartId: string | null;
  share?: Me['share'];
  telegram: Pick<Telegram, 'openLink' | 'canOpenLink' | 'canOpenTelegramLink' | 'openTelegramLink' | 'canShareToStory' | 'shareToStory' | 'canSwitchInlineQuery' | 'switchInlineQuery'>;
  now?: () => Date;
  known: ForecastDay | null;
  onKnown: (day: ForecastDay | null) => void;
  onBuildChart: () => void;
  onChartGone?: () => void;
  onSubscribe?: () => void;
  scroll?: { current: number };
  track?: Track;
}

const currentTime = () => new Date();
const noopTrack: Track = () => undefined;

export function DailyForecastScreen({ api, chartId, share, telegram, known, now = currentTime, onKnown, onBuildChart, onChartGone, onSubscribe, scroll, track }: DailyForecastScreenProps) {
  const titleId = useId();
  const [localDay, setLocalDay] = useState<ForecastDay | null>(null);
  // A cached reply is reusable only for its birth-place calendar day. A newly
  // fetched reply is authoritative even when the device clock is inaccurate.
  const freshCache = known && localDayIn(known.timezone, now()) === known.date ? known : null;
  const shownDay = freshCache ?? localDay;
  const [error, setError] = useState<'offline' | 'service' | 'month' | 'timeout' | null>(null);
  const [slow, setSlow] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [quota, setQuota] = useState<Me['quotas'][number] | null>(null);
  const [tick, setTick] = useState(0);
  const triedAt = useRef(0);
  const body = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || scroll === undefined) return undefined;
    element.scrollTop = scroll.current;
    const remember = () => { scroll.current = element.scrollTop; };
    element.addEventListener('scroll', remember, { passive: true });
    return () => { element.removeEventListener('scroll', remember); };
  }, [scroll]);
  useEffect(() => {
    if (!shownDay) return undefined;
    const resume = () => {
      if (document.visibilityState === 'hidden' || localDayIn(shownDay.timezone, now()) === shownDay.date) return;
      setLocalDay(null); onKnown(null); setSlow(false); setError(null); setQuota(null);
      setTick((value) => value + 1);
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
    };
  }, [shownDay, now, onKnown]);
  useEffect(() => {
    if (chartId === null || shownDay !== null) return;
    const controller = new AbortController();
    let active = true;
    const slowTimer = window.setTimeout(() => { setSlow(true); }, 5000);
    api.getForecastToday(controller.signal).then((result) => {
      if (active) { setLocalDay(result); onKnown(result); }
    }).catch((reason: unknown) => {
      if (!active) return;
      const reasonCode = isApiError(reason) ? reason.details?.reason ?? reason.details?.code : undefined;
      if (isApiError(reason) && reason.status === 404 && reasonCode === 'chart_not_found') { onChartGone?.(); return; }
      if (isApiError(reason) && reason.code === 'TIMEOUT') setError('timeout');
      else if (isApiError(reason) && reason.status === 429 && reasonCode === 'forecast_month_cap') setError('month');
      else if (isApiError(reason) && reason.status === 503) { setError('service'); triedAt.current = Date.now(); setRetryAfter(60); }
      else if (isApiError(reason) && reason.status === 429) setError('service');
      else setError('offline');
      // A failed generation never spends a forecast credit. Re-read the server-owned quota
      // instead of inferring it from the request's failure.
      void api.getMe(controller.signal).then((me) => {
        if (!active || controller.signal.aborted) return;
        setQuota(me.quotas.find((item) => item.code === 'forecast_daily') ?? null);
      }).catch(() => undefined);
    });
    return () => { active = false; controller.abort(); window.clearTimeout(slowTimer); };
  }, [api, chartId, shownDay, onChartGone, onKnown, tick]);
  useEffect(() => {
    if (retryAfter <= 0) return undefined;
    const timer = window.setTimeout(() => { setRetryAfter((n) => Math.max(0, n - 1)); }, 1000);
    return () => { window.clearTimeout(timer); };
  }, [retryAfter]);
  const retry = () => {
    if (error === 'service' && Date.now() - triedAt.current < 60_000) return;
    onKnown(null); setLocalDay(null); setError(null); setQuota(null); setRetryAfter(0); setSlow(false); setTick((value) => value + 1);
  };
  const moonShare = <ShareCardButton api={api} kind="moon" telegram={telegram} track={track ?? noopTrack} label={ru.shareCard.moon} share={share}/>;
  if (chartId === null) return <Screen bodyRef={body}><div className={styles.content}><ScreenHeading id={titleId} title={copy30.forecast.title}/><StateView title={copy30.forecast.missingTitle} text={copy30.forecast.missingText}><Button onClick={onBuildChart}>{copy30.forecast.build}</Button></StateView>{moonShare}</div></Screen>;
  if (error === null && shownDay === null) return <Screen busy bodyRef={body}><div className={styles.content}><ScreenHeading id={titleId} title={copy30.forecast.title}/><SkeletonGroup label={copy30.forecast.loading}><Skeleton/><Skeleton/><Skeleton/><Skeleton/></SkeletonGroup>{slow && <p className={styles.muted}>{copy30.forecast.slow}</p>}{moonShare}</div></Screen>;
  if (error !== null && shownDay === null) {
    const message = error === 'service' ? copy30.forecast.serviceText : error === 'month' ? copy30.forecast.monthText : error === 'timeout' ? copy30.forecast.timeoutText : copy30.forecast.offline;
    const title = error === 'offline' ? copy30.forecast.offline : error === 'service' ? copy30.forecast.serviceTitle : error === 'timeout' ? copy30.forecast.timeoutTitle : copy30.forecast.monthTitle;
    return <Screen bodyRef={body}><div className={styles.content}><ScreenHeading id={titleId} title={copy30.forecast.title}/><StateView title={title} text={message}>{error !== 'month' && <Button onClick={retry} disabled={error === 'service' && retryAfter > 0}>{error === 'service' && retryAfter > 0 ? copy30.forecast.retryAfter.replace('{seconds}', String(retryAfter)) : copy30.forecast.retry}</Button>}<SupportButton link={config.supportLink} telegram={telegram}/></StateView>{quota && <p className={styles.muted}>{copy30.forecast.quota.replace('{used}', String(quota.used)).replace('{limit}', quota.limit === -1 ? copy30.forecast.quotaUnlimited : String(quota.limit))}</p>}{moonShare}</div></Screen>;
  }
  const day = shownDay;
  if (day === null) return null;
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`));
  const facts = day.facts;
  const factRows = facts === undefined || facts === null ? [] : [
    ...(typeof facts.moon_sign === 'string' && facts.moon_sign !== '' ? [copy30.forecast.moonSign.replace('{value}', facts.moon_sign)] : []),
    ...(typeof facts.moon_phase === 'string' && facts.moon_phase !== '' ? [copy30.forecast.moonPhase.replace('{value}', facts.moon_phase)] : []),
    ...(typeof facts.illumination === 'number' && Number.isFinite(facts.illumination) ? [copy30.forecast.illumination.replace('{value}', String(Math.round(facts.illumination * 100)))] : []),
  ];
  return <Screen bodyRef={body}><div className={styles.content}>
    <ScreenHeading id={titleId} title={copy30.forecast.title} text={date}/>
    <p className={styles.muted}>{copy30.forecast.birthplace.replace('{timezone}', day.timezone)}</p>
    {day.status === 'ready' ? <>
      {day.sections.filter((section) => section.key !== 'step').map((section) => <section className={section.key === 'summary' ? styles.summary : styles.section} key={section.key}><h2>{section.title}</h2><p>{section.body}</p></section>)}
      {day.sections.filter((section) => section.key === 'step').map((section) => <section className={styles.step} key={section.key}><h2>{copy30.forecast.oneStep}</h2><p>{section.body}</p></section>)}
      {day.warnings.includes('length_off') && <p className={styles.muted}>{copy30.forecast.warning}</p>}
    </> : <>
      {factRows.length > 0 && <section className={styles.facts}>{factRows.map((fact) => <p key={fact}>{fact}</p>)}</section>}
      {onSubscribe && <Button variant="secondary" onClick={onSubscribe}>{copy30.forecast.subscribe}</Button>}
    </>}
    <div className={styles.shareActions}>
      <ShareCardButton api={api} kind="day" telegram={telegram} track={track ?? noopTrack} label={ru.shareCard.day} share={share}/>
      {moonShare}
    </div>
    <p className={styles.muted}>{copy30.forecast.update}</p>
    <Disclaimer text={day.disclaimer}/>
  </div></Screen>;
}
