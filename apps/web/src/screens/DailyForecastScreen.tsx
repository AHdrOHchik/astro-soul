import { Button, Screen, ScreenHeading, Skeleton, SkeletonGroup, StateView } from '@astro-soul/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Api, ForecastDay } from '../api';
import { isApiError } from '../api';
import { config } from '../config';
import { copy30 } from '../i18n/round30';
import { SupportButton } from '../components/SupportButton';
import { Disclaimer } from '../components/Disclaimer';
import styles from './DailyForecastScreen.module.css';
import type { Telegram } from '../telegram';

export interface DailyForecastScreenProps {
  api: Pick<Api, 'getForecastToday'>;
  chartId: string | null;
  telegram: Pick<Telegram, 'openLink'>;
  known: ForecastDay | null;
  onKnown: (day: ForecastDay | null) => void;
  onBuildChart: () => void;
  onSubscribe?: () => void;
  scroll?: { current: number };
}

export function DailyForecastScreen({ api, chartId, telegram, known, onKnown, onBuildChart, onSubscribe, scroll }: DailyForecastScreenProps) {
  const titleId = useId();
  const [localDay, setLocalDay] = useState<ForecastDay | null>(null);
  const shownDay = known ?? localDay;
  const [loading, setLoading] = useState(known === null && chartId !== null);
  const [error, setError] = useState<'offline' | 'service' | 'month' | null>(null);
  const [slow, setSlow] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
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
    if (chartId === null || known !== null) return;
    const controller = new AbortController();
    let active = true;
    const slowTimer = window.setTimeout(() => { setSlow(true); }, 5000);
    api.getForecastToday(controller.signal).then((result) => {
      if (active) { setLocalDay(result); onKnown(result); setLoading(false); }
    }).catch((reason: unknown) => {
      if (!active) return;
      setLoading(false);
      const reasonCode = isApiError(reason) ? reason.details?.reason ?? reason.details?.code : undefined;
      if (isApiError(reason) && reason.status === 429 && reasonCode === 'forecast_month_cap') setError('month');
      else if (isApiError(reason) && reason.status === 503) { setError('service'); triedAt.current = Date.now(); setRetryAfter(60); }
      else if (isApiError(reason) && reason.status === 429) setError('service');
      else setError('offline');
    });
    return () => { active = false; controller.abort(); window.clearTimeout(slowTimer); };
  }, [api, chartId, known, onKnown, tick]);
  useEffect(() => {
    if (retryAfter <= 0) return undefined;
    const timer = window.setTimeout(() => { setRetryAfter((n) => Math.max(0, n - 1)); }, 1000);
    return () => { window.clearTimeout(timer); };
  }, [retryAfter]);
  const retry = () => {
    if (error === 'service' && Date.now() - triedAt.current < 60_000) return;
    onKnown(null); setLocalDay(null); setError(null); setRetryAfter(0); setLoading(true); setSlow(false); setTick((value) => value + 1);
  };
  if (chartId === null) return <Screen bodyRef={body}><div className={styles.content}><ScreenHeading id={titleId} title={copy30.forecast.title}/><StateView title={copy30.forecast.missingTitle} text={copy30.forecast.missingText}><Button onClick={onBuildChart}>{copy30.forecast.build}</Button></StateView></div></Screen>;
  if (loading && shownDay === null) return <Screen busy bodyRef={body}><div className={styles.content}><ScreenHeading id={titleId} title={copy30.forecast.title}/><SkeletonGroup label={copy30.forecast.loading}><Skeleton/><Skeleton/><Skeleton/><Skeleton/></SkeletonGroup>{slow && <p className={styles.muted}>{copy30.forecast.slow}</p>}</div></Screen>;
  if (error !== null && shownDay === null) {
    const message = error === 'service' ? copy30.forecast.serviceText : error === 'month' ? copy30.forecast.monthText : copy30.forecast.offline;
    return <Screen bodyRef={body}><div className={styles.content}><ScreenHeading id={titleId} title={copy30.forecast.title}/><StateView title={error === 'offline' ? copy30.forecast.offline : error === 'service' ? copy30.forecast.serviceTitle : copy30.forecast.monthTitle} text={message}><Button onClick={retry} disabled={error === 'month' || (error === 'service' && retryAfter > 0)}>{error === 'service' && retryAfter > 0 ? copy30.forecast.retryAfter.replace('{seconds}', String(retryAfter)) : copy30.forecast.retry}</Button><SupportButton link={config.supportLink} telegram={telegram}/></StateView></div></Screen>;
  }
  const day = shownDay;
  if (day === null) return null;
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`));
  const facts = day.facts;
  return <Screen bodyRef={body}><div className={styles.content}>
    <ScreenHeading id={titleId} title={copy30.forecast.title} text={date}/>
    {day.status === 'ready' ? <>
      {day.sections.filter((section) => section.key !== 'step').map((section) => <section className={section.key === 'summary' ? styles.summary : styles.section} key={section.key}><h2>{section.title}</h2><p>{section.body}</p></section>)}
      {day.sections.filter((section) => section.key === 'step').map((section) => <section className={styles.step} key={section.key}><h2>{copy30.forecast.oneStep}</h2><p>{section.body}</p></section>)}
      {day.warnings.includes('length_off') && <p className={styles.muted}>{copy30.forecast.warning}</p>}
    </> : <>
      {facts && <section className={styles.facts}><p>{copy30.forecast.moonSign.replace('{value}', facts.moon_sign ?? '')}</p><p>{copy30.forecast.moonPhase.replace('{value}', facts.moon_phase ?? '')}</p><p>{copy30.forecast.illumination.replace('{value}', String(Math.round((facts.illumination ?? 0) * 100)))}</p></section>}
      {onSubscribe && <Button variant="secondary" onClick={onSubscribe}>{copy30.forecast.subscribe}</Button>}
    </>}
    <p className={styles.muted}>{copy30.forecast.birthplace.replace('{timezone}', day.timezone)}</p>
    <p className={styles.muted}>{copy30.forecast.update}</p>
    <Disclaimer text={day.disclaimer}/>
  </div></Screen>;
}
