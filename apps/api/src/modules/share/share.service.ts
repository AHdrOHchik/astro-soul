import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiError, forbidden, notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { splitSentences } from '../../common/sections';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import type { VerifiedInitData } from '../auth/init-data';
import { AstroClient, type AstroChartData, type AstroDayFacts } from '../astro/astro.client';
import { forecastFromBody } from '../daily/daily-forecast.validators';
import { EventsRepository } from '../events/events.repository';
import { FileStorageService } from '../files/file-storage.service';
import { buildShareCardLink } from '../charts/share-link';
import { UsersRepository } from '../users/users.repository';
import { ShareRepository, type ShareCardKind } from './share.repository';

/** Ответ `POST /share/card`. */
export interface ShareCardView {
  /** Подписанная ссылка на файл: живёт 24 часа, в шеринг не идёт. */
  readonly url: string;
  /**
   * `https://t.me/<bot>?start=sh_<short_id>` — постоянная ссылка в бота
   * (контракт 1.6.9). В отличие от `url`, сроком не ограничена: подпись на
   * файл бот выпускает сам, когда человек нажмёт ссылку. `null` — если имя
   * бота на сервере не настроено (`BOT_USERNAME`): собрать её не из чего.
   */
  readonly share_url: string | null;
  readonly expires_at: string;
  readonly caption: string;
}

/**
 * Подпись к карточке — одна на все виды.
 *
 * Готовая строка для `switchInlineQuery`: человек не должен ничего придумывать
 * (иначе половина карточек уйдёт без подписи). Слова «астрология», «гороскоп»,
 * «предсказание» запрещены: это и требование позиционирования, и защита от
 * блокировок в чатах. Тест проверяет отсутствие этих слов в `caption`.
 */
export const SHARE_CAPTION = 'Мне тут сделали разбор личности — залипательно';

/** Термины, которых не должно быть в цитате `insight`. */
const ASTRO_TERMS = [
  'овен',
  'телец',
  'близнец',
  'рак',
  'лев',
  'дева',
  'весы',
  'скорпион',
  'стрелец',
  'козерог',
  'водолей',
  'рыб',
  'солнц',
  'лун',
  'меркури',
  'венер',
  'марс',
  'юпитер',
  'сатурн',
  'уран',
  'нептун',
  'плутон',
  'хирон',
  'асцендент',
  'аспект',
  'транзит',
  'натальн',
  'гороскоп',
  'зодиак',
  'стихи',
  'доме',
  'домов',
  'карте',
  'карты',
] as const;

/** Сколько предложений цитаты: 2–3 по заданию. */
const QUOTE_SENTENCES = 3;
/** Потолок цитаты: карточка `insight` — не глава. */
const QUOTE_MAX_CHARS = 280;

interface CardContent {
  readonly kind: ShareCardKind;
  readonly title: string;
  readonly lines: readonly string[];
  readonly moonIllumination: number | null;
  readonly wheelPng: Buffer | null;
  /** Что именно подписывает хеш: только текст, без ссылки и без картинки. */
  readonly fingerprint: string;
}

/**
 * Карточки шеринга.
 *
 * Четыре правила, из которых собрана логика:
 *
 *   1. **Ничего персонального.** В карточку попадают знак Луны и фаза, дата
 *      дня, цитата из разбора и колесо — но не имя, не дата рождения, не
 *      место и не координаты. `insight` дополнительно чистится от
 *      астрологических терминов: цитата должна читаться человеком, который не
 *      знает, что такое асцендент.
 *   2. **Ссылка не содержит чужих идентификаторов.** `short_id` — хвост
 *      `sha256` от содержимого карточки: ни `user_id`, ни `report_id` в ссылку
 *      не попадают.
 *   3. **Кэш по содержимому.** Один и тот же день/колесо/цитата дают одну
 *      карточку на всех: `sharp`-рендер стоит секунды, а «у всех разное»
 *      означало бы, что кэш никогда не попадает.
 *   4. **Совместимость не шарится.** `kind: "compat"` — `404` и объяснение:
 *      партнёр не давал согласия на обработку своих данных. Это решение, а не
 *      недоделка.
 */
@Injectable()
export class ShareService {
  constructor(
    @Inject(ShareRepository) private readonly repo: ShareRepository,
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** `POST /share/card`. Публичного кэша нет: карточка создаётся по запросу. */
  async card(auth: VerifiedInitData, body: unknown, now: Date = new Date()): Promise<ShareCardView> {
    const kind = parseKind(body);
    const userId = this.users.userIdFor(auth.telegramUserId);

    const content = await this.contentOf(kind, userId, now);

    const contentHash = createHash('sha256').update(content.fingerprint).digest('hex');
    const shortId = shortIdOf(contentHash);
    const shareUrl = buildShareCardLink(this.env.BOT_USERNAME, shortId);
    const footer = this.footerOf(shareUrl);

    let row = await this.repo.find(kind, contentHash);
    let created = false;
    let buildMs = 0;

    if (row === null) {
      const startedAt = Date.now();
      const built = await this.astro.buildCard({
        kind,
        title: content.title,
        lines: [...content.lines],
        footer,
        wheel_png_base64: content.wheelPng === null ? null : content.wheelPng.toString('base64'),
        moon_illumination: content.moonIllumination,
      });
      buildMs = Date.now() - startedAt;

      const stored = await this.storage.put('card', Buffer.from(built.png_base64, 'base64'));

      created = true;
      row =
        (await this.repo.insert({
          kind,
          contentHash,
          shortId,
          storageKey: stored.key,
          bytes: built.bytes,
          width: built.width,
          height: built.height,
        })) ?? (await this.repo.find(kind, contentHash));
    }

    if (row === null) {
      // Гонка на вставке при уникальном индексе — практически невозможно, но
      // «второй раз попробуй» лучше, чем 500 на пустом месте.
      throw new ApiError('INTERNAL', 503, { reason: 'share_card_race' });
    }

    const signed = this.storage.signedUrl(row.storage_key);

    // Контракт 1.6.9: `share_card_created` — «мы отдали картинку», а не
    // «человек отправил». Отправку видит только клиент и присылает сам
    // (`share_sent`, клиентское событие). Здесь — только технические поля:
    // вид, размер и время сборки. Ни получателя, ни текста карточки.
    await this.events.log({
      name: 'share_card_created',
      userId,
      props: {
        kind,
        bytes: row.bytes,
        cached: !created,
        ...(created ? { build_ms: buildMs } : {}),
      },
    });

    this.logger.info('share_card_created', {
      kind,
      bytes: row.bytes,
      build_ms: created ? buildMs : null,
      cached: !created,
      short_id: shortId,
    });

    return {
      url: signed.url,
      share_url: shareUrl,
      expires_at: signed.expires_at,
      caption: SHARE_CAPTION,
    };
  }

  /** Содержимое карточки: всё, что можно показать, и ничего лишнего. */
  private async contentOf(kind: ShareCardKind, userId: string, now: Date): Promise<CardContent> {
    if (kind === 'day') {
      return this.dayContent(userId, now);
    }

    if (kind === 'wheel') {
      return this.wheelContent(userId);
    }

    return this.insightContent(userId);
  }

  /**
   * Карточка дня — вирусный вход: доступна всем, у кого есть карта.
   *
   * Факты берутся из сегодняшнего прогноза, если он есть (там же лежит
   * `summary` — строка «сегодня хорошо для…»), иначе считаются сайдкаром:
   * модель для карточки не вызывается никогда.
   */
  private async dayContent(userId: string, now: Date): Promise<CardContent> {
    const chart = await this.chartOf(userId);
    const forecast = await this.repo.latestForecast(userId, this.env.PROMPT_VERSION_FORECAST);

    const facts: AstroDayFacts =
      (forecast?.facts as AstroDayFacts | undefined) ??
      (await this.astro.forecastFacts(todayIso(now), birthTimezone(chart.data), chart.data));

    const summaryLine =
      forecast?.body_md === null || forecast === null
        ? null
        : firstSummarySentence(forecast.body_md);
    const title = `Луна в ${prepositional(facts.moon.sign)}`;
    // Освещённость в фактах — доля (0…1), человеку показываем проценты.
    const percent = Math.round(facts.moon.illumination * 100);
    const phaseLine = `${phaseWord(facts.moon.phase)}, освещённость ${String(percent)}%`;

    const lines = [
      phaseLine,
      ...(summaryLine === null ? [] : [summaryLine]),
      formatRuDay(todayIso(now)),
    ];

    return {
      kind: 'day',
      title,
      lines,
      moonIllumination: Math.min(1, Math.max(0, facts.moon.illumination)),
      wheelPng: null,
      fingerprint: [
        'day',
        facts.date,
        facts.moon.sign,
        facts.moon.phase,
        String(percent),
        summaryLine ?? '',
      ].join('|'),
    };
  }

  /** Карточка колеса: «моя натальная карта», без даты, времени и места. */
  private async wheelContent(userId: string): Promise<CardContent> {
    const chart = await this.chartOf(userId);
    const wheel = await this.astro.wheelPng(chart.data, 'dark', 900);

    return {
      kind: 'wheel',
      title: 'Моя натальная карта',
      lines: [],
      moonIllumination: null,
      wheelPng: wheel,
      // Хеш колеса, а не `chart_id`: две одинаковые карты дают одну карточку,
      // а идентификатор человека в кэш не попадает вообще.
      fingerprint: ['wheel', createHash('sha256').update(wheel).digest('hex')].join('|'),
    };
  }

  /**
   * Цитата из главы `core` оплаченного разбора.
   *
   * 2–3 предложения без астрологических терминов: карточку читает человек,
   * который не знает, что такое асцендент. Если в главе нет ни одного такого
   * предложения (бывает на коротких/частичных разборах) — честный отказ, а не
   * цитата с терминами.
   */
  private async insightContent(userId: string): Promise<CardContent> {
    const report = await this.repo.latestReadyReport(userId);

    if (report === null) {
      throw forbidden(reasonOptions('report_not_paid', 'Карточка-цитата — из оплаченного разбора'));
    }

    const core = report.chapters.find((chapter) => chapter.key === 'core');
    const quote = quoteOf(core?.body_md ?? '');

    if (quote === '') {
      throw forbidden(
        reasonOptions(
          'insight_unavailable',
          'В разборе нет строки, которую можно процитировать без терминов',
        ),
      );
    }

    return {
      kind: 'insight',
      title: `«${quote}»`,
      lines: [],
      moonIllumination: null,
      wheelPng: null,
      fingerprint: ['insight', quote].join('|'),
    };
  }

  private async chartOf(userId: string): Promise<{ id: string; data: AstroChartData }> {
    const chart = await this.repo.currentChart(userId);

    if (chart === null) {
      throw forbidden(
        reasonOptions('chart_required', 'Сначала построй карту — без неё карточку не собрать'),
      );
    }

    return { id: chart.id, data: chart.data as AstroChartData };
  }

  /**
   * Подвал картинки: та же ссылка, что отдаётся в `share_url`, но без схемы.
   *
   * Место в подвале карточки дорогое, а `t.me/...` Telegram всё равно делает
   * ссылкой. Отдельная функция, потому что `share_url` обязан быть полным
   * `https://…`: его открывают `openTelegramLink`, а не текст на картинке.
   */
  private footerOf(link: string | null): string | null {
    // Без имени бота ссылку не собрать: карточка без ссылки всё равно лучше,
    // чем карточка с битой ссылкой, но это видно в логе, а не в тишине.
    if (link === null) {
      this.logger.warn('share_card_without_link', { reason: 'bot_username_missing' });
      return null;
    }

    return link.replace(/^https:\/\//u, '');
  }
}

/** Разбор `kind` из тела. `compat` — не «не реализовано», а «так нельзя». */
export function parseKind(body: unknown): ShareCardKind {
  const value = (body as { kind?: unknown } | null)?.kind;

  if (value === 'compat') {
    throw notFound(
      reasonOptions(
        'share_compat_not_available',
        'Карточки пары нет: партнёр не давал согласия на обработку своих данных',
      ),
    );
  }

  if (value !== 'day' && value !== 'wheel' && value !== 'insight') {
    throw new ApiError('VALIDATION_FAILED', 422, {
      ...reasonOptions('share_kind_unknown', 'Вид карточки — day, wheel или insight'),
      details: {
        reason: 'share_kind_unknown',
        field_errors: [{ field: 'kind', message: 'Вид карточки — day, wheel или insight' }],
      },
    });
  }

  return value;
}

/** `short_id` из хеша содержимого: 10 символов base32-алфавита, без `_`/`-`. */
export function shortIdOf(contentHash: string): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Buffer.from(contentHash, 'hex');

  let out = '';
  for (let index = 0; index < 10; index += 1) {
    out += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }

  return out;
}

/** Цитата без терминов: до трёх предложений, не длиннее `QUOTE_MAX_CHARS`. */
export function quoteOf(bodyMd: string): string {
  const sentences = splitSentences(bodyMd.replace(/[*_#]/gu, ' '))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !hasAstroTerm(sentence));

  const chosen: string[] = [];
  let length = 0;

  for (const sentence of sentences.slice(0, QUOTE_SENTENCES)) {
    if (length + sentence.length > QUOTE_MAX_CHARS && chosen.length > 0) {
      break;
    }
    chosen.push(sentence);
    length += sentence.length + 1;
  }

  return chosen.join(' ').trim();
}

function hasAstroTerm(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return ASTRO_TERMS.some((term) => lower.includes(term));
}

/** Первое предложение раздела `summary` — «сегодня хорошо для…». */
export function firstSummarySentence(bodyMd: string): string | null {
  const { sections } = forecastFromBody(bodyMd);
  const summary = sections.find((section) => section.key === 'summary');
  if (summary === undefined) {
    return null;
  }

  const [first] = splitSentences(summary.body);
  return first ?? null;
}

/** «Рыбы» → «Рыбах»: заголовок карточки — фраза, а не подпись поля. */
export function prepositional(sign: string): string {
  const map: Readonly<Record<string, string>> = {
    Овен: 'Овне',
    Телец: 'Тельце',
    Близнецы: 'Близнецах',
    Рак: 'Раке',
    Лев: 'Льве',
    Дева: 'Деве',
    Весы: 'Весах',
    Скорпион: 'Скорпионе',
    Стрелец: 'Стрельце',
    Козерог: 'Козероге',
    Водолей: 'Водолее',
    Рыбы: 'Рыбах',
  };

  return map[sign] ?? sign;
}

/**
 * Фаза с заглавной буквы. Сайдкар отдаёт её строчными («растущий серп»), а в
 * карточке это начало строки, а не подпись поля.
 */
export function phaseWord(phase: string): string {
  if (phase === '') {
    return 'Луна';
  }

  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/** Локальная дата человека: та же, что у прогноза дня. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Пояс места рождения: «сегодня» начинается там, где человек родился (та же
 * логика, что у прогноза дня). Нет пояса в данных — UTC, чтобы карточка
 * собралась, а не упала.
 */
function birthTimezone(data: AstroChartData): string {
  const tz = (data.chart as { birth?: { place?: { tz?: string } } }).birth?.place?.tz;
  return tz === undefined || tz === '' ? 'UTC' : tz;
}

const RU_MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** «20 ноября 2026» — дата дня, а не дата рождения. */
export function formatRuDay(iso: string): string {
  const [year, month, day] = iso.split('-');
  const monthName = RU_MONTHS_GENITIVE[Number(month) - 1] ?? '';
  return `${String(Number(day))} ${monthName} ${String(year)}`;
}
