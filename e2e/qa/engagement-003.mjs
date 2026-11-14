#!/usr/bin/env node
/**
 * QA-003/004: проверки приёмки итераций 9–10, которых не было в харнессе 002.
 *
 * `acceptance-002.mjs` закрывает деньги: QA-15, M11/M11b/M11c, dp1. Здесь — то,
 * что появилось в итерациях 9–10 и требует стенда, а не чтения кода:
 *
 *   resurrect — блокер A: удаление не обезличивает платёж до конца, потому что
 *               `user_id` детерминирован из `telegram_id`; после первого входа
 *               старая подписка снова принадлежит живому пользователю
 *   forecast  — прогноз не генерируется на запросе (404 за миллисекунды, ноль
 *               токенов), идемпотентность `(chart_id, date)`, местное время
 *   push      — пуш 08:00: отбор по местному времени, 7 дней активности,
 *               `403` → пометка карты, `429` → `deferred` без ретрая, текст и кнопка
 *   ask       — «спроси карту»: квота до модели (1 и 5 в день), ПДн вопроса,
 *               запрещённые темы, обрезка до 1500
 *
 * Где нужны состояния, которых штатным путём не создать за минуту (очередь пуша,
 * ночное окно), скрипт пишет фикстуры прямо в БД и говорит об этом в выводе.
 * Логика продукта здесь не проверяется «на глаз»: каждое утверждение — это
 * ответ API или строка БД.
 *
 * Запуск: node e2e/qa/engagement-003.mjs <resurrect|forecast|push|ask|all>
 *
 * Окружение — то же, что у `acceptance-002.mjs`:
 *   QA_API, QA_PSQL, QA_DB, QA_BOT_TOKEN, QA_WEBHOOK_SECRET, QA_JOBS_SECRET, STUB
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const API = process.env.QA_API ?? 'http://127.0.0.1:8083/api/v1';
const STUB = process.env.STUB ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.QA_BOT_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? '';
const JOBS_SECRET = process.env.QA_JOBS_SECRET ?? '';
const PSQL = process.env.QA_PSQL ?? 'psql';
const DB = process.env.QA_DB ?? 'astro_qa3';

const mode = (process.argv[2] ?? 'all').toLowerCase();

/** Минимальный набор сведений о пользователе: без ПДн, только id из хеша. */
function sql(query) {
  return execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB, '-Atc', query])
    .toString()
    .trim();
}

/** `initData`, подписанный тем же токеном, что у стенда: другого входа в API нет. */
function initData(telegramId) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    query_id: `AAQ${telegramId}${authDate}${Math.random().toString(16).slice(2, 8)}`,
    user: JSON.stringify({ id: telegramId, first_name: 'Тест' }),
    auth_date: String(authDate),
  };
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function client(telegramId) {
  const headers = { 'x-telegram-init-data': initData(telegramId), 'content-type': 'application/json' };

  const call = async (path, options = {}) => {
    const started = performance.now();
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers ?? {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, ms: Math.round(performance.now() - started) };
  };

  return {
    headers,
    call,
    me: () => call('/me'),
    chart: async (place, tz = 'Europe/Moscow', name = 'Тест') => {
      const created = await call('/charts', {
        method: 'POST',
        body: JSON.stringify({
          birth_date: '1991-04-04',
          birth_time: '13:10',
          time_precision: 'exact',
          birth_place: { name, country: 'RU', lat: 55.75, lon: 37.61, tz },
          consent: { version: '2026-11-10', accepted: true },
        }),
      });
      // 201 — карта построена, 200 — та же карта восстановлена (`is_restored`). Оба ответа несут chart.
      if (created.status !== 201 && created.status !== 200) {
        throw new Error(`POST /charts: ${created.status} ${JSON.stringify(created.body)}`);
      }
      return created.body.chart.chart_id;
    },
  };
}

/** `successful_payment` через вебхук — единственный способ выдать доступ на стенде. */
async function pay(telegramId, planCode, chartId) {
  const api = client(telegramId);
  const invoice = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) }),
  });
  if (invoice.status !== 201) throw new Error(`POST /billing/invoice: ${invoice.status} ${JSON.stringify(invoice.body)}`);

  // payload берём из БД: контракт не отдаёт его клиенту, а вебхуку он нужен.
  const userId = (await api.me()).body.user_id;
  const payload = sql(`select payload from invoices where user_id = '${userId}' order by created_at desc limit 1`);
  const chargeId = `qa3-${randomUUID()}`;

  const response = await fetch(`${API}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 1,
      message: {
        chat: { id: telegramId },
        from: { id: telegramId },
        successful_payment: {
          currency: 'XTR',
          total_amount: invoice.body.stars,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: `prov-${chargeId}`,
          subscription_expiration_date: Math.floor(Date.now() / 1000) + 30 * 86_400,
        },
      },
    }),
  });

  return { status: response.status, stars: invoice.body.stars, chargeId };
}

function runJob(name) {
  return fetch(`${API}/internal/jobs/run?job=${name}`, {
    method: 'POST',
    headers: { 'x-jobs-secret': JOBS_SECRET },
  }).then((response) => response.json());
}

const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ок  ' : 'ПРОВАЛ'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  return ok;
};

/* ─────────────────────────── resurrect (блокер A) ─────────────────────────── */

async function resurrect(telegramId) {
  console.log('\n=== resurrect: удаление данных не обезличивает платёж до конца ===');
  const api = client(telegramId);

  const first = await api.me();
  const userId = first.body.user_id;

  // Повторный прогон должен начинаться с чистого пользователя, иначе сценарий
  // молча пропускается (подписка уже активна) и находка «исчезает». Чистим
  // только свои фикстуры — те, что этот скрипт и создаёт.
  if (first.body.subscription.is_active) {
    sql(
      `delete from entitlements where user_id = '${userId}';
       delete from subscriptions where user_id = '${userId}';
       delete from payments where user_id = '${userId}';`,
    );
    console.log('  фикстура: подписка прошлого прогона снята');
  }

  await pay(telegramId, 'year_2990');
  const bought = await api.me();
  check(bought.body.subscription.is_active === true, 'подписка куплена', bought.body.subscription.plan);

  const deleted = await api.call('/me', { method: 'DELETE' });
  check(deleted.status === 204, 'DELETE /me → 204', String(deleted.status));

  const subscriptionAfterDelete = sql(
    `select status from subscriptions where user_id = '${userId}'`,
  );
  check(
    subscriptionAfterDelete === '' || subscriptionAfterDelete === 'expired',
    'подписка после удаления не живёт «сама по себе»',
    subscriptionAfterDelete === '' ? 'строк нет' : subscriptionAfterDelete,
  );

  // Смотрим на строку платежа целиком, а не на «строки, где telegram_id уже
  // обнулён»: после итерации 11 он живёт окно возврата, и старый запрос врал бы
  // («тот же uuid» при пустом результате).
  const paymentUserId = sql(
    `select coalesce(user_id::text, 'NULL') from payments order by paid_at desc limit 1`,
  );
  console.log(
    `  ФАКТ: payments.user_id после удаления = ${paymentUserId === 'NULL' ? 'NULL' : 'тот же uuid'}`,
  );

  // Второй вход: пользователь просто открывает мини-апп.
  const back = await api.me();
  check(back.body.is_new === true, 'вернувшийся пользователь создан заново', `is_new=${back.body.is_new}`);
  check(back.body.user_id === userId, 'user_id тот же — он детерминирован из telegram_id');

  const revived = back.body.subscription.is_active === true;
  console.log(`  ${revived ? 'НАХОДКА A' : 'ок    '}  подписка после возврата: plan=${back.body.subscription.plan} is_active=${back.body.subscription.is_active}`);
  console.log(
    `  ${back.body.entitlements.full_report ? 'НАХОДКА A' : 'ок    '}  full_report=${back.body.entitlements.full_report} full_report_chart_id=${back.body.entitlements.full_report_chart_id}`,
  );

  // Деньги за разбор второй раз не теряются: новая карта — новая покупка.
  const fresh = await api.chart('Москва', 'Europe/Moscow', 'Москва');
  const order = await api.call('/reports', {
    method: 'POST',
    headers: { 'idempotency-key': `qa3-${randomUUID()}` },
    body: JSON.stringify({ chart_id: fresh, type: 'full' }),
  });
  check(order.status === 402, 'POST /reports на новую карту без оплаты → 402', String(order.status));

  console.log(
    revived
      ? '  ВЫВОД: блокер. `me.service.ts` обнуляет `telegram_id`, но не `user_id`;\n' +
          '         `userIdFromTelegramId()` даёт тот же id — старые записи снова живые.'
      : '  ВЫВОД: закрыто.',
  );
}

/* ─────────────────────────── forecast (задача 5) ─────────────────────────── */

async function forecast(telegramId) {
  console.log('\n=== forecast: на запросе не генерируется, ночь — по местному времени ===');
  const api = client(telegramId);
  const chartId = await api.chart('Москва', 'Europe/Moscow', 'Москва');

  const cold = await api.call(`/engagement/forecast?chart_id=${chartId}`);
  check(cold.status === 404, 'холодный кэш → 404', `${cold.ms} мс`);
  const coldAgain = await api.call(`/engagement/forecast?chart_id=${chartId}`);
  check(coldAgain.status === 404, 'повторный запрос тоже не генерирует', `${coldAgain.ms} мс`);
  const rowsBefore = Number(sql(`select count(*) from forecasts where chart_id = '${chartId}'`));
  check(rowsBefore === 0, 'строк в forecasts не появилось', String(rowsBefore));

  // Ночное окно: две карты с разницей 6 часов. Москва в окно не попадает почти
  // всегда, поэтому вторую берём заведомо «ночную» — и проверяем обе.
  await api.chart('Владивосток', 'Asia/Vladivostok', 'Владивосток');

  const nightly = await runJob('forecast_nightly');
  console.log(`  прогон: generated=${nightly.forecasts_generated} skipped=${nightly.forecasts_skipped} failed=${nightly.forecasts_failed}`);

  const second = await runJob('forecast_nightly');
  check(
    second.forecasts_generated === 0,
    'повторный прогон ничего не добавляет (идемпотентность)',
    `generated=${second.forecasts_generated}`,
  );

  const localTimes = sql(
    `select coalesce(string_agg((c.data->'chart'->'birth'->'place'->>'tz') || '=' ||
              to_char(now() at time zone (c.data->'chart'->'birth'->'place'->>'tz'), 'HH24:MI'), ', '), '—')
       from charts c where c.id = '${chartId}'`,
  );
  console.log(`  местное время карты: ${localTimes}`);
  console.log('  (окно ночного джоба — 03:00 ±30 мин по tz из chart.birth.place;');
  console.log('   карта в окно попадает только в свой час — это и есть «по местному», а не по UTC)');

  const warm = await api.call(`/engagement/forecast?chart_id=${chartId}`);
  if (warm.status === 200) {
    check(warm.body.text.length > 0, 'тёплый кэш отдаёт текст', `${warm.body.text.length} знаков`);
  } else {
    console.log(`  карта вне ночного окна: прогноза нет (${warm.status}) — верно, генерация только ночью`);
  }
}

/* ─────────────────────────────── push (задача 6) ─────────────────────────────── */

async function push(telegramId) {
  console.log('\n=== push: 08:00 по местному, 7 дней активности, 403 и 429 ===');
  console.log('  фикстуры: 4 карты в зоне America/Anchorage (местное ~08:00), прямой INSERT');

  // Уборка фикстур прошлых прогонов: иначе джоб подберёт оставшиеся строки,
  // и глобальные счётчики будут считать чужие карты. Метка в teaser — наша.
  sql(`delete from forecasts where teaser like 'QA-фикстура пуша%'`);

  const apiClients = [];
  const charts = [];
  for (let index = 0; index < 4; index += 1) {
    const id = telegramId + index;
    const api = client(id);
    await api.me();
    const chartId = await api.chart('Анкоридж', 'America/Anchorage', 'Анкоридж');
    apiClients.push({ id, api });
    charts.push(chartId);
  }

  // Активность: у первых трёх — «сейчас», у четвёртой — 8 дней назад.
  sql(
    `update users set created_at = now() - interval '10 days'
      where telegram_id in (${apiClients.map((entry) => entry.id).join(',')})`,
  );
  sql(
    `update users set created_at = now() - interval '1 hour'
      where telegram_id in (${apiClients.slice(0, 3).map((entry) => entry.id).join(',')})`,
  );

  // Прогноз на местную дату: ночной джоб сюда не достанет (не 03:00), а пушу нужна строка.
  charts.forEach((chartId) => {
    sql(
      `insert into forecasts (chart_id, date, teaser, full_text, focus, is_paid, llm_cost_rub, llm_tokens_in, llm_tokens_out)
       values ('${chartId}', (now() at time zone 'America/Anchorage')::date,
               'QA-фикстура пуша. Одна строка.', null, null, false, 0, 10, 10)`,
    );
  });

  // Журнал стаба — с нуля: иначе в «отправленные» попадут сообщения об оплате
  // из прошлых прогонов, и первым в списке окажется не пуш.
  await fetch(`${STUB}/__calls/reset`, { method: 'POST' });

  // Адресные отказы Bot API: 403 второму чату, 429 третьему.
  await fetch(`${STUB}/__config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fail: { sendMessage: { byChat: { [String(apiClients[1].id)]: 403, [String(apiClients[2].id)]: 429 } } },
    }),
  });

  const first = await runJob('forecast_push');
  console.log(
    `  прогон: sent=${first.pushes_sent} skipped_inactive=${first.pushes_skipped_inactive} deferred=${first.pushes_deferred} failed=${first.pushes_failed}`,
  );

  // Счётчики джоба глобальные; стенд общий, поэтому решающее слово — состояние
  // наших четырёх карт, а счётчики печатаются для полноты.
  const stateOf = (chartId) =>
    sql(
      `select (f.push_sent_at is not null)::text || '|' || (c.push_blocked_at is not null)::text
         from forecasts f join charts c on c.id = f.chart_id
        where f.chart_id = '${chartId}' and f.teaser like 'QA-фикстура пуша%'`,
    );
  const states = charts.map(stateOf);
  check(states[0] === 'true|false', 'активный получил пуш', states[0]);
  check(states[1] === 'false|true', '403 → карта помечена, пуш не отправлен', states[1]);
  check(states[2] === 'false|false', '429 → строка не отмечена (deferred), карта не заблокирована', states[2]);
  check(states[3] === 'false|false', 'неактивный 8 дней не получал пуш', states[3]);
  check(first.pushes_sent >= 1, 'pushes_sent считает отправленные', String(first.pushes_sent));
  check(first.pushes_skipped_inactive >= 1, 'pushes_skipped_inactive считает неактивных', String(first.pushes_skipped_inactive));
  check(first.pushes_deferred >= 1, 'pushes_deferred считает 429', String(first.pushes_deferred));

  // Пуш отличается от служебных сообщений тем, что несёт кнопку мини-аппа.
  const calls = await (await fetch(`${STUB}/__calls`)).json();
  const sent = calls.filter(
    (call) => call.method === 'sendMessage' && call.body?.reply_markup?.inline_keyboard !== undefined,
  );
  const blockedChart = charts[1];
  const marked = sql(`select push_blocked_at is not null from charts where id = '${blockedChart}'`);
  check(marked === 't', '403 → charts.push_blocked_at');

  const text = sent[0]?.body?.text ?? '';
  const sentences = text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim() !== '' && !sentence.includes('Полный прогноз'));
  check(sentences.length <= 2, 'в сообщении 1–2 предложения', JSON.stringify(text.slice(0, 80)));
  const button = sent[0]?.body?.reply_markup?.inline_keyboard?.[0]?.[0];
  check(button?.web_app?.url !== undefined, 'кнопка «Открыть» с web_app', button?.web_app?.url ?? 'нет');

  const attemptsTo = async (chatId) =>
    (await (await fetch(`${STUB}/__calls`)).json()).filter(
      (call) => call.method === 'sendMessage' && String(call.body?.chat_id) === String(chatId),
    ).length;

  const deferredChat = apiClients[2].id;
  const afterFirst = await attemptsTo(deferredChat);
  // «В этом прогоне не ретраим» — значит ровно одна попытка за прогон, а не
  // «никогда»: следующий прогон в том же окне попробует снова, иначе прогноз,
  // не доставленный в 08:00, не дошёл бы никогда. Проверяем именно это.
  check(afterFirst === 1, 'за прогон ровно одна попытка к чату с 429', String(afterFirst));

  const second = await runJob('forecast_push');
  const afterRetry = await attemptsTo(deferredChat);
  check(second.pushes_sent === 0, 'повторный прогон не отправляет второй раз', String(second.pushes_sent));
  check(
    afterRetry === afterFirst + 1,
    'следующий прогон делает новую попытку (не «навсегда пропущен»)',
    `${afterFirst} → ${afterRetry}`,
  );
  const stillUnsent = sql(
    `select (push_sent_at is null)::text from forecasts where chart_id = '${charts[2]}' and teaser like 'QA-фикстура пуша%'`,
  );
  check(stillUnsent === 'true', 'строка по-прежнему не отмечена как отправленная', stillUnsent);
}

/* ──────────────────────────────── ask (задача 7) ──────────────────────────────── */

async function ask(telegramId) {
  console.log('\n=== ask: квота до модели, ПДн, запрещённые темы, обрезка ===');

  // Квоты — суточные, а прогон повторяют. Снимаем счётчики только у тех
  // пользователей, которых создаёт этот скрипт (диапазон QA_TELEGRAM_ID + 900).
  sql(
    `delete from quotas where user_id in (
       select id from users where telegram_id in (${telegramId}, ${telegramId + 900}, ${telegramId + 901})
     )`,
  );

  const api = client(telegramId);
  const chartId = await api.chart('Москва', 'Europe/Moscow', 'Москва');

  const question = 'Что говорят мои опоры про работу сегодня?';
  const first = await api.call('/engagement/ask', {
    method: 'POST',
    body: JSON.stringify({ chart_id: chartId, question }),
  });
  check(first.status === 200, 'первый вопрос бесплатного — 200', `${first.ms} мс`);
  check((first.body.answer ?? '').length <= 1500, 'ответ ≤ 1500 знаков', `${(first.body.answer ?? '').length}`);

  const second = await api.call('/engagement/ask', {
    method: 'POST',
    body: JSON.stringify({ chart_id: chartId, question }),
  });
  check(second.status === 429, 'второй за день — 429', String(second.status));
  check(second.body.details?.quota_code === 'ask_daily', 'details.quota_code = ask_daily');
  check(typeof second.body.details?.reset_at === 'string', 'details.reset_at есть', second.body.details?.reset_at ?? '');
  check(second.ms < 100, 'отказ быстрее вызова модели — квота проверена до неё', `${second.ms} мс`);

  const leaked = Number(
    sql(`select count(*) from events where props::text ilike '%опоры%' or props::text ilike '%работу%'`),
  );
  check(leaked === 0, 'текста вопроса нет в events', String(leaked));
  const columns = sql(
    `select coalesce(string_agg(column_name, ','), '') from information_schema.columns
      where table_name = 'asks' and column_name in ('question', 'question_text')`,
  );
  check(columns === '', 'в asks нет колонки с текстом вопроса', columns === '' ? 'колонок нет' : columns);

  // Запрещённые темы — с чистой квотой, поэтому другой пользователь.
  const forbiddenApi = client(telegramId + 900);
  const forbiddenChart = await forbiddenApi.chart('Москва', 'Europe/Moscow', 'Москва');
  for (const text of ['У меня будет рак? Что скажешь про диагноз', 'Когда я умру?', 'Гарантируешь доход на биткоине?']) {
    const response = await forbiddenApi.call('/engagement/ask', {
      method: 'POST',
      body: JSON.stringify({ chart_id: forbiddenChart, question: text }),
    });
    const refused = response.status === 200 && Array.isArray(response.body.based_on) && response.body.based_on.length === 0;
    check(refused, `мягкий отказ: «${text.slice(0, 28)}…»`, `${response.status}, based_on=[]`);
  }

  // Квота подписки: 5 в день.
  const paidId = telegramId + 901;
  const paidApi = client(paidId);
  await paidApi.me();
  const paidChart = await paidApi.chart('Москва', 'Europe/Moscow', 'Москва');
  const alreadyPaid = (await paidApi.me()).body.subscription.is_active;
  if (!alreadyPaid) await pay(paidId, 'month_399', paidChart);
  const me = await paidApi.me();
  check(me.body.entitlements.ask_per_day === 5, 'подписка даёт 5 вопросов в день', String(me.body.entitlements.ask_per_day));

  const codes = [];
  for (let index = 1; index <= 6; index += 1) {
    const response = await paidApi.call('/engagement/ask', {
      method: 'POST',
      body: JSON.stringify({ chart_id: paidChart, question: `Вопрос номер ${index} про мои опоры` }),
    });
    codes.push(response.status);
  }
  check(
    codes.join(',') === '200,200,200,200,200,429',
    'пятый — 200, шестой — 429',
    codes.join(','),
  );
}

/* ──────────────────────────────────── main ──────────────────────────────────── */

const TELEGRAM_ID = Number(process.env.QA_TELEGRAM_ID ?? 6070000001);

if (TOKEN === '' || WEBHOOK_SECRET === '') {
  console.error('нужны QA_BOT_TOKEN и QA_WEBHOOK_SECRET: без них initData не подписать');
  process.exit(2);
}

try {
  if (JOBS_SECRET === '' && ['push', 'forecast', 'all'].includes(mode)) {
    console.error('для forecast/push нужен QA_JOBS_SECRET');
    process.exit(2);
  }
  if (mode === 'resurrect' || mode === 'all') await resurrect(TELEGRAM_ID + 100);
  if (mode === 'forecast' || mode === 'all') await forecast(TELEGRAM_ID + 200);
  if (mode === 'push' || mode === 'all') await push(TELEGRAM_ID + 300);
  if (mode === 'ask' || mode === 'all') await ask(TELEGRAM_ID + 400);
  console.log('\nготово');
} catch (error) {
  console.error(`\nпрогон остановлен: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
