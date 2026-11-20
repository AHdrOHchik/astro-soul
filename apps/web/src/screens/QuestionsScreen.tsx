import { Button, Screen, ScreenHeading, Skeleton, SkeletonGroup, StateView, TextArea } from '@astro-soul/ui';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { isApiError, type Api, type Question } from '../api';
import { config } from '../config';
import { copy30 } from '../i18n/round30';
import { newIdempotencyKey } from '../lib/idempotency';
import { SupportButton } from '../components/SupportButton';
import { Disclaimer } from '../components/Disclaimer';
import styles from './QuestionsScreen.module.css';
import type { Telegram } from '../telegram';

const reasonOf = (error: unknown) => isApiError(error) && typeof error.details?.reason === 'string' ? error.details.reason : '';
const resetText = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? copy30.questions.resetFallback : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(date);
};

export interface QuestionsScreenProps {
  api: Pick<Api, 'listQuestions' | 'createQuestion' | 'getQuestion'>;
  telegram: Pick<Telegram, 'openLink'>;
  subscribed: boolean;
  chartAvailable?: boolean;
  onSubscribe?: () => void;
  onBuildChart?: () => void;
  onChartGone: () => void;
  scroll?: { current: number };
}

export function QuestionsScreen({ api, telegram, subscribed, chartAvailable = true, onSubscribe, onBuildChart, onChartGone, scroll }: QuestionsScreenProps) {
  const titleId = useId();
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Question[]>([]);
  const [active, setActive] = useState<Question | null>(null);
  const [loading, setLoading] = useState(chartAvailable);
  const [submitting, setSubmitting] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [quota, setQuota] = useState<Question['quota'] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const retryKey = useRef<string | null>(null);
  const submitLife = useRef<AbortController | null>(null);
  useEffect(() => () => { submitLife.current?.abort(); }, []);
  useLayoutEffect(() => {
    const element = listRef.current;
    if (element === null || scroll === undefined) return undefined;
    element.scrollTop = scroll.current;
    const remember = () => { scroll.current = element.scrollTop; };
    element.addEventListener('scroll', remember, { passive: true });
    return () => { element.removeEventListener('scroll', remember); };
  }, [scroll]);
  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    const result = await api.listQuestions(20, signal);
    const visible = result.items.filter((item) => item.status !== 'failed');
    setHistory(visible);
    setQuota(result.quota);
    setHistoryError(false);
    return visible;
  }, [api]);

  useEffect(() => {
    if (!chartAvailable) return undefined;
    const controller = new AbortController();
    void Promise.resolve().then(() => loadHistory(controller.signal)).catch(() => { if (!controller.signal.aborted) setHistoryError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [loadHistory, chartAvailable]);

  useEffect(() => {
    if (active?.status !== 'pending') return undefined;
    const started = Date.now();
    const controller = new AbortController();
    let timer = 0;
    let delay = 3000;
    const poll = async () => {
      if (Date.now() - started >= 180_000) { setNotice(copy30.questions.pendingTimeout); setActive(null); return; }
      try {
        const result = await api.getQuestion(active.id, controller.signal);
        if (controller.signal.aborted) return;
        setActive(result);
        if (result.status !== 'pending') {
          if (result.status === 'failed') void loadHistory(controller.signal).catch(() => { if (!controller.signal.aborted) setHistoryError(true); });
          else setHistory((current) => [result, ...current.filter((item) => item.id !== result.id)].slice(0, 20));
          return;
        }
      } catch { if (controller.signal.aborted) return; }
      timer = window.setTimeout(() => { delay = Math.min(10_000, delay + 3000); void poll(); }, delay);
    };
    timer = window.setTimeout(() => { void poll(); }, delay);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active?.id, active?.status, api, loadHistory]);

  const submit = async (retryText?: string) => {
    const text = (retryText ?? question).trim();
    if (text.length < 10 || text.length > 300 || submitting || !subscribed) return;
    if (retryText !== undefined) retryKey.current = null;
    setSubmitting(true); setSubmitError(null); setNotice(null);
    const controller = new AbortController();
    submitLife.current = controller;
    const idempotencyKey = retryKey.current ?? newIdempotencyKey();
    retryKey.current = idempotencyKey;
    const optimistic: Question = { id: idempotencyKey, status: 'pending', question: text, sections: [], chars: 0, warnings: [], topic: 'other', created_at: new Date().toISOString(), disclaimer: '', quota: { used: 0, limit: 0, resets_at: new Date().toISOString() } };
    setActive(optimistic); setQuestion('');
    try {
      const accepted = await api.createQuestion(text, idempotencyKey, controller.signal);
      retryKey.current = null;
      if (accepted.status === 'refused') {
        const result = await api.getQuestion(accepted.id, controller.signal);
        setActive(result);
        setHistory((current) => [result, ...current.filter((item) => item.id !== result.id)].slice(0, 20));
      } else setActive({ ...optimistic, id: accepted.id });
    } catch (reason) {
      if (controller.signal.aborted) return;
      setActive(null);
      setQuestion(text);
      if (isApiError(reason) && reason.code === 'NOT_FOUND') { onChartGone(); return; }
      if (isApiError(reason) && reason.status === 403 && reasonOf(reason) === 'subscription_required') { setNotice(copy30.questions.subscriptionRequired); return; }
      if (isApiError(reason) && reason.status === 403 && reasonOf(reason) === 'quota_exhausted') {
        const quota = reason.details?.quota as { used?: number; limit?: number; resets_at?: string } | undefined;
        const resetAt = quota?.resets_at ?? (typeof reason.details?.resets_at === 'string' ? reason.details.resets_at : '');
        setNotice(copy30.questions.quota.replace('{used}', String(quota?.used ?? '—')).replace('{limit}', String(quota?.limit ?? '—')).replace('{reset}', resetText(resetAt)));
        return;
      }
      if (isApiError(reason) && reason.status === 409 && reasonOf(reason) === 'question_in_progress') {
        try { const items = await loadHistory(); const pending = items.find((item) => item.status === 'pending'); if (pending) setActive(pending); else setNotice(copy30.questions.pendingConflict); } catch { setNotice(copy30.questions.pendingConflictShort); }
        return;
      }
      if (isApiError(reason) && reason.status === 429 && reasonOf(reason) === 'daily_cost_cap') { setNotice(copy30.questions.costCap); return; }
      setSubmitError(reason);
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
      if (submitLife.current === controller) submitLife.current = null;
    }
  };

  const changeQuestion = (text: string) => { retryKey.current = null; setQuestion(text); };
  const prompt = question.length >= 10 && question.length <= 300;
  const activeQuestion = active;
  return <Screen bodyRef={listRef} busy={loading || submitting}>
    <div className={styles.content}>
      <ScreenHeading id={titleId} title={copy30.questions.title}/>
      {!subscribed ? <>
        <p className={styles.text}>{chartAvailable ? copy30.questions.examplesTitle : copy30.questions.noChart}</p>
        {!chartAvailable && onBuildChart && <Button onClick={onBuildChart}>{copy30.questions.build}</Button>}
        <ul className={styles.examples}>{copy30.questions.examples.map((example) => <li key={example}><span>{example}</span></li>)}</ul>
        <p className={styles.muted}>{copy30.questions.deleteInfo}</p>
        {onSubscribe && <Button onClick={onSubscribe}>{copy30.questions.subscribe}</Button>}
      </> : <>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <TextArea label={copy30.questions.label} value={question} onChange={changeQuestion} maxLength={300} rows={3} />
          <div className={styles.row}><span className={styles.muted}>{copy30.questions.length}</span><span className={styles.muted}>{question.length}/300</span></div>
          <Button type="submit" disabled={!prompt || submitting}>{copy30.questions.submit}</Button>
        </form>
        <p className={styles.label}>{copy30.questions.examplesLabel}</p>
        <ul className={styles.examples}>{copy30.questions.examples.map((example) => <li key={example}><button type="button" onClick={() => { changeQuestion(example); }}>{example}</button></li>)}</ul>
        {notice && <StateView title="" text={notice}>{notice === copy30.questions.subscriptionRequired && onSubscribe && <Button onClick={onSubscribe}>{copy30.questions.subscribe}</Button>}{notice === copy30.questions.costCap && <SupportButton link={config.supportLink} telegram={telegram}/>}</StateView>}
        {submitError && <StateView title={copy30.questions.failedTitle} text={copy30.questions.retry}><Button onClick={() => void submit()}>{copy30.questions.retryButton}</Button></StateView>}
        {activeQuestion && <article className={styles.exchange}>
          <p className={styles.label}>{copy30.questions.asked}</p><p>{activeQuestion.question}</p>
          {activeQuestion.status === 'pending' ? <><SkeletonGroup label={copy30.questions.polling}><Skeleton/><Skeleton/><Skeleton/></SkeletonGroup></> : activeQuestion.status === 'refused' ? <><p>{activeQuestion.message}</p><Button variant="secondary" onClick={() => { setActive(null); }}>{copy30.questions.refusedAnother}</Button></> : activeQuestion.status === 'failed' ? <StateView title={copy30.questions.failedAnswerTitle} text={copy30.questions.failedResult}><Button onClick={() => void submit(activeQuestion.question)}>{copy30.questions.retryFailed}</Button></StateView> : <>
            {activeQuestion.sections.map((section) => <section key={section.key}><h2>{section.title}</h2><p>{section.body}</p></section>)}
            {activeQuestion.warnings.includes('ungrounded') && <p className={styles.muted}>{copy30.questions.ungrounded}</p>}
            <Disclaimer text={activeQuestion.disclaimer}/>
          </>}
        </article>}
        {quota && <p className={styles.muted}>{copy30.questions.quotaStatus.replace('{used}', String(quota.used)).replace('{limit}', String(quota.limit))}</p>}
        {loading ? <SkeletonGroup label={copy30.questions.historyLoading}><Skeleton/><Skeleton/></SkeletonGroup> : <section className={styles.history}>
          <h2>{copy30.questions.history}</h2>
          {historyError ? <div role="alert"><p>{copy30.questions.historyRetry}</p><Button variant="secondary" onClick={() => { setLoading(true); setHistoryError(false); void loadHistory().catch(() => { setHistoryError(true); }).finally(() => { setLoading(false); }); }}>{copy30.questions.retryButton}</Button></div> : history.length === 0 ? <p>{copy30.questions.historyEmpty}</p> : history.map((item) => <button key={item.id} type="button" onClick={() => { setActive(item); }}><time>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(item.created_at))}</time><span>{item.question}</span>{item.status === 'refused' && item.message && <span>{item.message}</span>}</button>)}
        </section>}
        <p className={styles.muted}>{copy30.questions.deleteInfo}</p>
      </>}
    </div>
  </Screen>;
}
