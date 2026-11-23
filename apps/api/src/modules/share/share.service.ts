import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiError, forbidden, notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { splitSentences } from '../../common/sections';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import type { VerifiedInitData } from '../auth/init-data';
import {
  AstroClient,
  type AstroChartData,
  type AstroDayFacts,
  type AstroMoonFacts,
} from '../astro/astro.client';
import { forecastFromBody } from '../daily/daily-forecast.validators';
import { DISCLAIMER } from '../reports/validators';
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

/**
 * Версия шаблона сторис (контракт 1.6.12).
 *
 * **Дублирует** `TEMPLATE_VERSION` из `packages/astro/astro/cards.py`: ключ
 * кэша (`share_cards.template_version`) считает API, а рисует сайдкар, и
 * разъехавшиеся значения означали бы «кэш попадает, а картинка — старая».
 * Совпадение проверяется тестом, который читает константу из Python-файла.
 */
export const SHARE_TEMPLATE_VERSION = 'stories-1';

/** Версия вёрстки `wheel` и `insight`: в 1.6.12 они не менялись. */
export const CLASSIC_TEMPLATE_VERSION = 'classic-1';

/** Виды по шаблону сторис: им нужны имя продукта, дисклеймер и подсказка. */
export const STORIES_KINDS: readonly ShareCardKind[] = ['day', 'identity', 'moon'];

/** Заголовок карточки `identity`. */
export const IDENTITY_TITLE = 'Три вещи, которые правда про меня';

/** Приглашение внизу `identity`: константа, а не текст модели. */
export const IDENTITY_INVITE = 'Узнал себя? Спроси, что про тебя';

/**
 * Чего сегодня лучше не начинать — по фазе Луны, из констант.
 *
 * Почему константы, а не модель: карточка `moon` доступна человеку без
 * профиля, то есть без оплаты. Вызов модели здесь означал бы платный текст на
 * бесплатном входе и, главное, риск, что модель сочинит предсказание. Восемь
 * фраз — по числу фаз в `daily.PHASES`; незнакомая фаза даёт нейтральную
 * строку, а не выдумку.
 */
export const MOON_ADVICE: Readonly<Record<string, string>> = {
  новолуние: 'Не начинай то, что требует сразу всех сил: день про план, а не про рывок.',
  'растущий серп': 'Не начинай разговор, который нельзя отложить: слов ещё не хватает.',
  'первая четверть': 'Не начинай спорить: сегодня важнее договориться, чем победить.',
  'растущая Луна': 'Не начинай перестановку и ремонт: не тот день для больших перемен.',
  полнолуние: 'Не начинай выяснять отношения: эмоций больше, чем аргументов.',
  'убывающая Луна': 'Не начинай новый проект: день про то, чтобы закончить начатое.',
  'последняя четверть': 'Не начинай разговор о деньгах: тебя услышат не с первого раза.',
  'убывающий серп': 'Не начинай спонтанных покупок: утром будет жаль.',
};

/** Нейтральная строка для фазы, которой нет в списке. */
export const MOON_ADVICE_FALLBACK = 'Не начинай того, что можно отложить на завтра.';

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
  /** Приглашение внизу карточки (`identity`): рисуется отдельным блоком. */
  readonly prompt: string | null;
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
    const timezone = parseTimezone(body);
    const userId = this.users.userIdFor(auth.telegramUserId);

    // Карточка-сторис без имени продукта не собирается: в чужой ленте она
    // никому не говорит, чья это картинка. `wheel` и `insight` живут по старой
    // вёрстке и имени продукта не требуют (в 1.6.12 их не меняли).
    const brand = this.brandOf(kind);

    const content = await this.contentOf(kind, userId, now, timezone);
    const templateVersion = templateVersionOf(kind);

    const contentHash = createHash('sha256').update(content.fingerprint).digest('hex');
    const shortId = shortIdOf(contentHash, templateVersion);
    const shareUrl = buildShareCardLink(this.env.BOT_USERNAME, shortId);
    const footer = this.footerOf(shareUrl);

    let row = await this.repo.find(kind, contentHash, templateVersion);
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
        brand_name: brand?.name ?? null,
        brand_hint: brand?.hint ?? null,
        disclaimer: brand?.disclaimer ?? null,
        prompt: content.prompt ?? null,
      });
      buildMs = Date.now() - startedAt;

      const stored = await this.storage.put('card', Buffer.from(built.png_base64, 'base64'));

      created = true;
      row =
        (await this.repo.insert({
          kind,
          contentHash,
          templateVersion,
          shortId,
          storageKey: stored.key,
          bytes: built.bytes,
          width: built.width,
          height: built.height,
        })) ?? (await this.repo.find(kind, contentHash, templateVersion));
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
        template_version: row.template_version,
        ...(created ? { build_ms: buildMs } : {}),
      },
    });

    this.logger.info('share_card_created', {
      kind,
      bytes: row.bytes,
      build_ms: created ? buildMs : null,
      cached: !created,
      short_id: shortId,
      template_version: row.template_version,
    });

    return {
      url: signed.url,
      share_url: shareUrl,
      expires_at: signed.expires_at,
      caption: SHARE_CAPTION,
    };
  }

  /** Содержимое карточки: всё, что можно показать, и ничего лишнего. */
  private async contentOf(
    kind: ShareCardKind,
    userId: string,
    now: Date,
    timezone: string | null,
  ): Promise<CardContent> {
    if (kind === 'day') {
      return this.dayContent(userId, now);
    }

    if (kind === 'wheel') {
      return this.wheelContent(userId);
    }

    if (kind === 'identity') {
      return this.identityContent(userId);
    }

    if (kind === 'moon') {
      return this.moonContent(userId, now, timezone);
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
      prompt: null,
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
      prompt: null,
      moonIllumination: null,
      wheelPng: wheel,
      // Хеш колеса, а не `chart_id`: две одинаковые карты дают одну карточку,
      // а идентификатор человека в кэш не попадает вообще.
      fingerprint: ['wheel', createHash('sha256').update(wheel).digest('hex')].join('|'),
    };
  }

  /**
   * Карточка `identity` — «три вещи, которые правда про меня» (контракт 1.6.12).
   *
   * Текст берётся из главы «Ядро» оплаченного разбора и **режется по правилам**,
   * без вызова модели: тот же разбор обязан давать ту же карточку, иначе кэш по
   * хешу содержимого не попадает, а человек получает «каждый раз новую»
   * картинку про себя. Модель здесь ещё и лишняя: фразы уже написаны.
   *
   * Если подходящих фраз меньше трёх — `422 not_enough_identity_lines`. Это не
   * ошибка сервера, а нормальный ответ: на коротком разборе показывать две
   * фразы вместо трёх значит обещать «три вещи» и не выполнить обещание.
   */
  private async identityContent(userId: string): Promise<CardContent> {
    const report = await this.repo.latestReadyReport(userId);

    if (report === null) {
      throw forbidden(reasonOptions('report_not_paid', 'Карточка про тебя — из оплаченного разбора'));
    }

    const core = report.chapters.find((chapter) => chapter.key === 'core');
    const phrases = identityPhrases(core?.body_md ?? '');

    if (phrases.length < IDENTITY_PHRASES) {
      throw new ApiError('VALIDATION_FAILED', 422, {
        ...reasonOptions(
          'not_enough_identity_lines',
          'В разборе меньше трёх коротких фраз о поведении — карточку не собрать',
        ),
        details: { reason: 'not_enough_identity_lines' },
      });
    }

    return {
      kind: 'identity',
      title: IDENTITY_TITLE,
      lines: phrases,
      prompt: IDENTITY_INVITE,
      moonIllumination: null,
      wheelPng: null,
      fingerprint: ['identity', SHARE_TEMPLATE_VERSION, ...phrases].join('|'),
    };
  }

  /**
   * Карточка `moon` — «фаза Луны», вход в воронку без профиля (контракт 1.6.12).
   *
   * Карты не требует и подписки не требует: любой человек, открывший бота,
   * может поделиться сегодняшней Луной. Персональных строк здесь нет — знак и
   * фаза одинаковы для всех в одном поясе, поэтому карточка честно кэшируется
   * на всех.
   *
   * Строка «чего лучше не начинать» — из констант по фазе (`MOON_ADVICE`), а не
   * от модели: текст бесплатный и не может соврать предсказанием.
   */
  private async moonContent(
    userId: string,
    now: Date,
    timezone: string | null,
  ): Promise<CardContent> {
    const tz = timezone ?? (await this.timezoneOrDefault(userId));
    const date = localDateIn(tz, now);

    let facts: AstroMoonFacts;
    try {
      facts = await this.astro.moonFacts(date, tz);
    } catch (error) {
      // Сайдкар недоступен — это `503`, а не «карточка без Луны»: карточка про
      // Луну без Луны бессмысленна.
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' });
    }

    const percent = Math.round(facts.moon.illumination * 100);
    const advice = MOON_ADVICE[facts.moon.phase] ?? MOON_ADVICE_FALLBACK;

    return {
      kind: 'moon',
      title: `Луна в ${prepositional(facts.moon.sign)}`,
      lines: [
        `${phaseWord(facts.moon.phase)}, освещённость ${String(percent)}%`,
        advice,
        formatRuDay(facts.date),
      ],
      prompt: null,
      moonIllumination: Math.min(1, Math.max(0, facts.moon.illumination)),
      wheelPng: null,
      fingerprint: [
        'moon',
        SHARE_TEMPLATE_VERSION,
        facts.date,
        tz,
        facts.moon.sign,
        facts.moon.phase,
        String(percent),
      ].join('|'),
    };
  }

  /**
   * Пояс по умолчанию для карточки `moon`: пояс карты, если она есть, иначе UTC.
   *
   * Карта не обязательна — именно поэтому метод не бросает `chart_required`:
   * человек без профиля получает сегодняшнюю Луну по UTC и всё равно может
   * поделиться карточкой.
   */
  private async timezoneOrDefault(userId: string): Promise<string> {
    const chart = await this.repo.currentChart(userId);

    if (chart === null) {
      return 'UTC';
    }

    return birthTimezone(chart.data as AstroChartData);
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
      prompt: null,
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
   * Бренд на карточке-сторис: имя продукта, подсказка для поиска и дисклеймер.
   *
   * Имя берётся из конфига владельца (`BRAND_NAME`); пусто — `503
   * brand_name_missing`, а не «Astro Soul по умолчанию»: безымянная карточка в
   * чужой ленте не находится, а подставленное имя — это подмена решения хозяина
   * продукта.
   *
   * Дисклеймер — тот же текст, что у прогноза (`DISCLAIMER` из валидаторов):
   * карточка уходит из приложения, и подпись обязана быть внутри картинки.
   */
  private brandOf(
    kind: ShareCardKind,
  ): { name: string; hint: string; disclaimer: string } | null {
    if (!STORIES_KINDS.includes(kind)) {
      return null;
    }

    const name = this.env.BRAND_NAME;

    if (name === undefined) {
      this.logger.error('share_card_brand_missing', { kind });
      throw new ApiError('INTERNAL', 503, {
        ...reasonOptions('brand_name_missing', 'На сервере не задано имя продукта для карточек'),
        details: { reason: 'brand_name_missing' },
      });
    }

    return {
      name,
      // Подсказку владелец задаёт сам; не задал — собираем из имени продукта,
      // чтобы не выдумывать чужой бренд.
      hint: this.env.BRAND_SEARCH_HINT ?? `ищи в Telegram: ${name}`,
      disclaimer: DISCLAIMER,
    };
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

  if (value !== 'day' && value !== 'wheel' && value !== 'insight' && value !== 'identity' && value !== 'moon') {
    const message = 'Вид карточки — day, wheel, insight, identity или moon';
    throw new ApiError('VALIDATION_FAILED', 422, {
      ...reasonOptions('share_kind_unknown', message),
      details: {
        reason: 'share_kind_unknown',
        field_errors: [{ field: 'kind', message }],
      },
    });
  }

  return value;
}

/**
 * Версия шаблона по виду карточки.
 *
 * Стоит в ключе кэша (`share_cards.template_version`): смена вёрстки — это
 * другая карточка, а не та же. `wheel` и `insight` в 1.6.12 не менялись, у них
 * версия `classic-1` — заодно это значит, что старые строки кэша (с
 * `legacy-0`/`classic-1` из миграции) продолжают работать.
 */
export function templateVersionOf(kind: ShareCardKind): string {
  return STORIES_KINDS.includes(kind) ? SHARE_TEMPLATE_VERSION : CLASSIC_TEMPLATE_VERSION;
}

/**
 * Часовой пояс из тела (`tz`), если он передан. Проверяется здесь, а не в
 * сайдкаре: неверный пояс — это `422` с полем `tz`, а не 500 из глубины.
 */
export function parseTimezone(body: unknown): string | null {
  const value = (body as { tz?: unknown } | null)?.tz;

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidTimeZone(value)) {
    const message = 'Неизвестный часовой пояс, например Europe/Moscow';
    throw new ApiError('VALIDATION_FAILED', 422, {
      ...reasonOptions('share_tz_unknown', message),
      details: {
        reason: 'share_tz_unknown',
        field_errors: [{ field: 'tz', message }],
      },
    });
  }

  return value;
}

/** Есть ли такой пояс в ICU: `Intl` — единственный источник без списков в коде. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Местная дата (`YYYY-MM-DD`) в поясе на момент `now`.
 *
 * `sv-SE` выбран не из любви к шведскому: в этой локали `Intl` отдаёт ровно
 * `YYYY-MM-DD`, и не нужно собирать строку из частей и гадать про лидирующие
 * нули.
 */
export function localDateIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * `short_id` из ключа кэша: 10 символов base32-алфавита, без `_`/`-`.
 *
 * Версия вёрстки входит в хеш наравне с содержимым (1.6.12): `short_id`
 * уникален в таблице, а содержимое после смены шаблона остаётся тем же. Без
 * версии вторая карточка того же текста падала бы на уникальном индексе — то
 * есть первая же правка вёрстки ломала бы все уже закэшированные карточки.
 * Старые `sh_`-ссылки при этом продолжают открываться: они указывают на старую
 * строку и её файл.
 */
export function shortIdOf(contentHash: string, templateVersion: string): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = createHash('sha256').update(`${templateVersion}|${contentHash}`).digest();

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

/**
 * Сколько фраз в карточке `identity`. «Три вещи» — обещание в заголовке, и оно
 * должно выполняться буквально.
 */
export const IDENTITY_PHRASES = 3;

/** Рамки длины фразы: короче — обрывок, длиннее — абзац, а не карточка. */
export const IDENTITY_MIN_CHARS = 40;
export const IDENTITY_MAX_CHARS = 120;

/**
 * Родовые и оценочные формы: карточку могут показывать кому угодно, а разбор
 * написан в одном роде. «Ты склонен» / «ты склонна» — это не про человека, а
 * про то, кому достался текст.
 */
const GENDERED_FORMS = [
  'склонен',
  'склонна',
  'готов ',
  'готова',
  'уверен',
  'уверена',
  'должен',
  'должна',
  'сам ',
  'сама ',
  'рад ',
  'рада',
  'одинок',
  'одинока',
] as const;

/** Обращения ко второму лицу: фраза карточки — про поведение, а не лекция. */
const SECOND_PERSON = [
  /(^|[^а-яё])ты([^а-яё]|$)/iu,
  /(^|[^а-яё])тебя([^а-яё]|$)/iu,
  /(^|[^а-яё])тебе([^а-яё]|$)/iu,
  /(^|[^а-яё])тобой([^а-яё]|$)/iu,
  /(^|[^а-яё])твой([^а-яё]|$)/iu,
  /(^|[^а-яё])твоя([^а-яё]|$)/iu,
  /(^|[^а-яё])тво[еи][йх]([^а-яё]|$)/iu,
  /(^|[^а-яё])у тебя([^а-яё]|$)/iu,
] as const;

/**
 * Второе лицо — **без учёта регистра**: предложение в разборе почти всегда
 * начинается с «Ты», и чувствительный к регистру шаблон выбрасывал бы самые
 * естественные фразы, оставляя только «…у тебя…» из середины.
 */

/**
 * Три короткие фразы из главы «Ядро» — по правилам, без модели.
 *
 * Правила (все проверяются тестом):
 *   • только утверждения о поведении: есть «ты/тебя/тебе/твой» — иначе фраза
 *     звучит как описание третьего лица и в карточке «про меня» не читается;
 *   • 40–120 знаков: короче — обрывок, длиннее — не влезает в карточку;
 *   • без астрологических терминов (`ASTRO_TERMS`) — карточку читает человек,
 *     который не знает, что такое асцендент;
 *   • без процентов и родовых форм: «на 80% интроверт» и «ты склонна» — это
 *     оценка и чужой род, а не наблюдение.
 *
 * Порядок — как в разборе: детерминизм важнее «самых красивых» фраз, иначе
 * один и тот же разбор давал бы разные карточки.
 */
export function identityPhrases(bodyMd: string): string[] {
  const sentences = splitSentences(bodyMd.replace(/[*_#]/gu, ' '))
    .map((sentence) => sentence.replace(/\s+/gu, ' ').trim())
    .filter((sentence) => sentence !== '');

  const chosen: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length < IDENTITY_MIN_CHARS || sentence.length > IDENTITY_MAX_CHARS) {
      continue;
    }

    if (hasAstroTerm(sentence) || sentence.includes('%') || /процент/u.test(sentence)) {
      continue;
    }

    if (!SECOND_PERSON.some((pattern) => pattern.test(sentence))) {
      continue;
    }

    const lower = sentence.toLowerCase();
    if (GENDERED_FORMS.some((form) => lower.includes(form))) {
      continue;
    }

    chosen.push(sentence);

    if (chosen.length === IDENTITY_PHRASES) {
      break;
    }
  }

  return chosen;
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
