import type { ApiErrorCode, ChartWarning, Quota, ReportStatus, Subscription, TimePrecision } from '../api';
import type { DateIssue, TimeIssue } from '../lib/birth';
import type { PaywallPlan } from '../lib/plans';
import type { PluralForm } from './format';

/*
 * Every user-facing string of the app. Tone: «ты», gender-neutral, no pressure,
 * no promises about events, health or money (SPEC, «Генерация текста»).
 *
 * The legal texts are not written here: `welcome.disclaimer`, `welcome.terms`,
 * `consent` and `documents` are copied word for word from the file a human owns,
 * `legal-texts-<CONSENT_VERSION>.md` in the repository root. A new wording comes
 * as a new file together with a new CONSENT_VERSION; `tests/legal-texts.test.ts`
 * fails until the texts, the file and the version agree.
 *
 * Texts about money, refunds and the deletion of data that the owner worded are
 * marked «owner's wording»: they are not to be rephrased in passing either.
 */

/**
 * Version of the legal texts below, sent as `consent.version` in `POST /charts`. The
 * server stores it next to the user's consent and accepts no other version than its
 * own: a release with new texts has to carry the new date here (YYYY-MM-DD).
 */
export const CONSENT_VERSION = '2026-11-10';

interface ErrorCopy {
  title: string;
  text: string;
}

const errors: Record<ApiErrorCode, ErrorCopy> = {
  UNAUTHORIZED: {
    title: 'Сессия устарела',
    text: 'Закрой приложение и открой его снова из чата с ботом.',
  },
  FORBIDDEN: {
    title: 'Нет доступа',
    text: 'Этот раздел сейчас недоступен.',
  },
  // A failure, worded unlike the empty search result on the place screen («Ничего не нашли»).
  NOT_FOUND: {
    title: 'Запрос не выполнен',
    text: 'Сервер не нашёл то, что мы запросили. Попробуй зайти позже.',
  },
  // The server words a 409 itself and its text is shown as it is; this one is for a 409 that came without any.
  // No word about support in the app's own texts: whether there is anyone to write to is what the button says.
  CONFLICT: {
    title: 'Сейчас не получится',
    text: 'Мешает незавершённая операция. Попробуй позже.',
  },
  VALIDATION_FAILED: {
    title: 'Проверь данные',
    text: 'Сервер не принял данные рождения. Вернись назад и проверь дату, время и место.',
  },
  QUOTA_EXCEEDED: {
    title: 'Лимит исчерпан',
    text: 'Лимит на сегодня закончился. Попробуй позже.',
  },
  PAYMENT_REQUIRED: {
    title: 'Раздел закрыт',
    text: 'Этот раздел открывается после оплаты.',
  },
  RATE_LIMITED: {
    title: 'Слишком много запросов',
    text: 'Подожди минуту и попробуй ещё раз.',
  },
  INTERNAL: {
    title: 'Ошибка на нашей стороне',
    text: 'Попробуй ещё раз через пару минут.',
  },
  UPSTREAM_LLM: {
    title: 'Текст пока не готов',
    text: 'Сервис, который пишет разборы, временно недоступен. Попробуй ещё раз чуть позже.',
  },
  // The geodata provider is down (503). An unknown place is not an error: the search answers with an empty list.
  GEO_NOT_FOUND: {
    title: 'Поиск мест недоступен',
    text: 'Справочник мест сейчас не отвечает. Попробуй ещё раз чуть позже.',
  },
  NETWORK: {
    title: 'Нет связи',
    text: 'Проверь подключение к интернету и попробуй ещё раз.',
  },
  TIMEOUT: {
    title: 'Сервер долго не отвечает',
    text: 'Попробуй ещё раз. Если не поможет — зайди чуть позже.',
  },
  INVALID_RESPONSE: {
    title: 'Не удалось прочитать ответ',
    text: 'Сервер ответил не так, как мы ждали. Попробуй ещё раз чуть позже.',
  },
};

const dateIssues: Record<DateIssue, string> = {
  incomplete: 'Введи день, месяц и год.',
  invalid: 'Такой даты нет в календаре. Проверь день и месяц.',
  too_old: 'Проверь год: строим карты для дат начиная с 1900 года.',
  future: 'Эта дата ещё не наступила. Проверь год.',
  underage: 'Разбор доступен с 18 лет — для этой даты карту построить не сможем.',
};

const timeIssues: Record<TimeIssue, string> = {
  incomplete: 'Введи часы и минуты.',
  invalid: 'Такого времени нет. Часы — от 00 до 23, минуты — от 00 до 59.',
};

interface TimeOptionCopy {
  title: string;
  description: string;
  /** Honest note about what this choice does to the accuracy of the chart. */
  accuracy: string;
}

const timeOptions: Record<TimePrecision, TimeOptionCopy> = {
  exact: {
    title: 'Знаю точно',
    description: 'Есть в документах, или его помнят родные.',
    accuracy:
      'Асцендент в среднем сдвигается на градус каждые четыре минуты, поэтому даже небольшая неточность влияет на него и на дома.',
  },
  approximate: {
    title: 'Знаю примерно',
    description: 'Например, «около девяти утра».',
    accuracy:
      'С примерным временем Асцендент и дома могут оказаться неверными: ошибка в час-два часто меняет знак Асцендента. Планеты в знаках останутся верными, кроме Луны на границе знаков.',
  },
  unknown: {
    title: 'Не знаю',
    description: 'Построим карту без времени.',
    accuracy:
      'Без времени Асцендент и дома рассчитать нельзя — на карте они будут отмечены как нерассчитанные. Знак Луны может быть неточным: за сутки она проходит около 13°.',
  },
};

/**
 * What the server warns about (`ChartResponse.warnings`), a note per code. Positions come
 * with minutes of arc either way; these say plainly when the input does not support that.
 */
const chartWarnings: Record<ChartWarning, string> = {
  no_birth_time: 'Время рождения не указано, поэтому положение Луны приблизительное: за сутки она проходит около 13°.',
  approximate_time: 'Время указано примерно, поэтому Асцендент и дома могут быть неточными.',
  approximate_place:
    'Этого места нет в нашем справочнике. Часовой пояс мог определиться по ближайшему крупному городу: если он другой, время рождения в расчёте сдвинуто на час.',
};

interface PlanCopy {
  title: string;
  /** What the purchase gives, by payments.md §1. */
  description: string;
}

const plans: Record<PaywallPlan, PlanCopy> = {
  one_149: {
    title: 'Полный разбор',
    description: 'Все главы разбора по этой карте. Разовая покупка, без подписки.',
  },
  week_149: {
    title: 'Подписка на неделю',
    description: 'Полные прогнозы, 5 вопросов карте в день, совместимость раз в месяц.',
  },
  month_399: {
    title: 'Подписка на месяц',
    description: 'Полные прогнозы, 5 вопросов карте в день, совместимость раз в месяц.',
  },
  year_2990: {
    title: 'Подписка на год',
    description: 'Всё, что в подписке на месяц, и карта года.',
  },
};

/** `SubscriptionState.plan` as the settings name it; `none` has no name: there is nothing to name. */
const subscriptionNames: Record<Exclude<Subscription['plan'], 'none'>, string> = {
  trial: 'Пробный период',
  week: 'Подписка на неделю',
  month: 'Подписка на месяц',
  year: 'Подписка на год',
};

/** The quotas of `Me.quotas`, by code. A code without a name here is a quota this build does not show. */
const quotaNames: Record<Quota['code'], string> = {
  forecast_daily: 'Прогнозы на день',
  ask_daily: 'Вопросы карте в день',
  report_month: 'Разборы в месяц',
  compat_month: 'Совместимость в месяц',
};

/** One line about a report the user has, for the chart screen. */
const reportStates: Record<ReportStatus, string> = {
  queued: 'Разбор в очереди.',
  generating: 'Разбор пишется.',
  ready: 'Разбор готов.',
  failed: 'Разбор не получился.',
  // Owner's wording.
  refunded: 'Разбор не получился, звёзды вернулись на счёт.',
};

/** Telegram Stars, the app's only currency: «1 звезда», «2 звезды», «149 звёзд». */
const stars: Record<PluralForm, string> = {
  one: 'звезда',
  few: 'звезды',
  many: 'звёзд',
  other: 'звезды',
};

export const ru = {
  appName: 'Разбор личности',

  common: {
    back: 'Назад',
    next: 'Дальше',
    retry: 'Попробовать ещё раз',
    close: 'Закрыть',
    loading: 'Загружаем…',
    step: (current: number, total: number) => `Шаг ${String(current)} из ${String(total)}`,
    requestId: (id: string) => `Код обращения: ${id}`,
    /** Said for a moment after the code above was copied by a tap. */
    copied: 'Скопировано',
    settings: 'Настройки',
    /** Shown next to a price; screen readers get the word from `stars` instead. */
    starSign: '⭐',
    stars,
  },

  errors,
  outsideTelegram: {
    title: 'Открой приложение в Telegram',
    text: 'Разбор работает внутри Telegram: так мы узнаём тебя без паролей. Открой приложение из чата с ботом.',
  },

  welcome: {
    title: 'Разбор личности',
    lead: 'Натальная карта и личный разбор по дате, времени и месту рождения.',
    points: [
      { title: 'Три шага', text: 'Дата, время и место рождения — и карта готова.' },
      { title: 'Солнце, Луна, Асцендент', text: 'Короткий разбор трёх главных точек карты.' },
      { title: 'Время знать не обязательно', text: 'Без него карта строится, но без Асцендента и домов.' },
    ],
    /** Legal text: the short disclaimer. On screen without scrolling, next to the button. */
    disclaimer: '18+. Это развлекательный сервис. Не медицинская, психологическая и финансовая рекомендация.',
    start: 'Начать',
    /** Legal text: one sentence in three parts. The whole line opens the agreement; the middle part is drawn as the link. */
    terms: { before: 'Подробнее — в ', link: 'пользовательском соглашении', after: '.' },
  },

  /** Legal texts of the consent screen. See the note at the top of this file before touching them. */
  consent: {
    title: 'Обработка данных',
    lead: 'Для расчёта карты нам нужны дата, время и место твоего рождения. Это персональные данные, поэтому нужно твоё согласие.',
    points: [
      'Мы используем их только для расчёта карты и генерации твоего разбора.',
      'Не передаём третьим лицам; текст разбора генерируется без твоего имени, точных координат и id.',
      'Ты можешь удалить все данные в любой момент: Настройки → «Удалить мои данные». Это необратимо.',
      'Если ты не заходишь 24 месяца, данные удаляются автоматически.',
    ],
    /** A paragraph of its own under the list: it is about usage statistics, not about the birth data. */
    analytics:
      'Мы собираем обезличенную статистику использования (какие экраны открываются, на каком шаге люди уходят). В ней нет того, что ты вводишь: ни даты и места рождения, ни текста вопросов.',
    /** The two documents the screen links to. */
    documents: {
      privacy: 'Политика обработки персональных данных',
      terms: 'Пользовательское соглашение и оплата',
    },
    checkbox: 'Я соглашаюсь на обработку персональных данных',
    submit: 'Продолжить',
    decline: 'Не сейчас',
  },

  /**
   * Legal texts of the two document screens, a paragraph per entry. The full documents
   * are not written yet: these are the short versions, shown with their version.
   */
  documents: {
    version: (version: string) => `Версия документа: ${version}.`,
    privacy: {
      paragraphs: [
        'Мы собираем только то, что нужно для расчёта карты: дату, время и место рождения. Плюс твой telegram_id, чтобы ты мог войти, и тексты вопросов, которые ты задаёшь карте.',
        'Не собираем: телефон, email, паспортные данные, геолокацию устройства и контакты.',
        'Данные рождения используются только для расчёта карты и генерации разбора. Текст разбора генерируется без имени, точных координат и id. Платёжные идентификаторы хранятся без персональных данных.',
        'Ты можешь удалить все данные в любой момент: Настройки → «Удалить мои данные». Если ты не заходишь 24 месяца, данные удаляются автоматически.',
        'Аналитика: мы собираем обезличенную статистику использования. В событиях нет даты, времени и места рождения, текста вопросов и имени.',
      ],
    },
    /** Without the support line of the source file: it holds a placeholder until there is a contact to show. */
    terms: {
      paragraphs: [
        '18+. Сервис носит развлекательный и ознакомительный характер. Разборы и прогнозы не являются медицинской, психологической, юридической или финансовой рекомендацией и не предсказывают события. Решения о здоровье, деньгах и отношениях принимай самостоятельно.',
        'Оплата проходит звёздами Telegram. Подписка продлевается автоматически, пока ты её не отменишь; отменить можно в настройках Telegram, доступ сохраняется до конца оплаченного периода. Если товар не был предоставлен из-за технической ошибки, звёзды возвращаются автоматически.',
        'Удалить данные: Настройки → «Удалить мои данные».',
      ],
    },
  },

  /**
   * The server refused the consent because the legal texts have a newer version than
   * this build shows. Not legal texts: the app's own words about what happens next.
   */
  termsUpdate: {
    /** On the consent screen, after the app reloaded itself and came back with the new texts. */
    renewed: 'Условия обновились, подтверди ещё раз. Данные рождения нужно будет ввести заново.',
    /** When the reload did not bring a newer build, or could not be made. */
    outdatedTitle: 'Условия обновились',
    outdatedText:
      'Новая версия приложения ещё не загрузилась. Попробуй обновить сейчас или зайди чуть позже. Данные рождения нужно будет ввести заново.',
    reload: 'Обновить приложение',
  },

  birthDate: {
    title: 'Дата рождения',
    hint: 'День, месяц и год — как в документах. Разбор доступен с 18 лет.',
    day: 'День',
    month: 'Месяц',
    year: 'Год',
    dayPlaceholder: 'ДД',
    monthPlaceholder: 'ММ',
    yearPlaceholder: 'ГГГГ',
    issues: dateIssues,
  },

  birthTime: {
    title: 'Время рождения',
    hint: 'От времени зависят Асцендент и дома. Насколько точно ты его знаешь?',
    optionsLabel: 'Точность времени рождения',
    options: timeOptions,
    timeLabel: 'Время по часам места рождения',
    timeHint: 'В 24-часовом формате, например 07:30 или 19:05.',
    hours: 'Часы',
    minutes: 'Минуты',
    hoursPlaceholder: 'ЧЧ',
    minutesPlaceholder: 'ММ',
    chooseOption: 'Выбери один из трёх вариантов.',
    issues: timeIssues,
  },

  birthPlace: {
    title: 'Место рождения',
    hint: 'По месту определим координаты и часовой пояс — вводить их не нужно.',
    label: 'Город или населённый пункт',
    placeholder: 'Например, Казань',
    minLength: (count: number) => `Введи хотя бы ${String(count)} буквы — и мы начнём искать.`,
    searching: 'Ищем места…',
    resultsLabel: 'Найденные места',
    found: (count: number) => `Найдено мест: ${String(count)}. Выбери своё.`,
    emptyTitle: 'Ничего не нашли',
    emptyText: 'Проверь написание или введи ближайший крупный город.',
    selectedLabel: 'Выбранное место',
    timezone: (tz: string) => `Часовой пояс: ${tz}`,
    timezoneNote: 'Время рождения считаем по местному времени этого места.',
    change: 'Выбрать другое место',
    choosePlace: 'Выбери место из списка, чтобы продолжить.',
    submit: 'Построить карту',
  },

  chart: {
    title: 'Твоя карта',
    loading: 'Строим карту…',
    timeUnknown: 'время неизвестно',
    wheelAlt: 'Колесо натальной карты: планеты по знакам зодиака',
    wheelLoading: 'Загружаем колесо карты…',
    wheelErrorTitle: 'Колесо не загрузилось',
    wheelErrorText: 'Остальная карта на месте. Картинку можно загрузить ещё раз.',
    wheelMissing: 'Картинка колеса пока недоступна.',
    share: 'Поделиться картой',
    shareText: 'Моя натальная карта в «Разборе личности»',
    cardsTitle: 'Главные точки карты',
    sun: 'Солнце',
    moon: 'Луна',
    asc: 'Асцендент',
    house: (house: number) => `${String(house)}-й дом`,
    noPosition: 'Положение не пришло с сервера.',
    ascUnknown: 'Не рассчитан',
    ascUnknownText: 'Асцендент и дома рассчитываются только по времени рождения, а оно не указано.',
    warnings: chartWarnings,
    emptyTitle: 'Карта пришла пустой',
    emptyText: 'Сервер построил карту, но не прислал ни позиций, ни колеса. Попробуй ещё раз.',
    editData: 'Изменить данные рождения',
    /** On a chart opened from the server: the form behind this button starts empty. */
    enterAgain: 'Ввести данные рождения заново',
    teaserTitle: 'Полный разбор',
    teaserLocked: 'Продолжение закрыто',
    /** The price follows: «Открыть полностью — 149 ⭐». The space before the dash is non-breaking. */
    teaserCta: 'Открыть полностью\u00a0—',
    /** While the app asks the server about a report the user already has. */
    reportLoading: 'Проверяем разбор…',
    reportStates,
    /** The user has paid for a report and no report is known yet: this tap orders it. Owner's wording. */
    orderReport: 'Получить разбор',
    /** Telegram called the report paid and the server has not confirmed it yet: said in place of the price. */
    paymentPending: 'Платёж обрабатывается.',
    /** Owner's wording. */
    openReport: 'К разбору',
  },

  /** Screen 7. Prices are never written here: they come with the plan, see lib/plans.ts. */
  paywall: {
    title: 'Тарифы',
    lead: 'Оплата проходит звёздами Telegram.',
    optionsLabel: 'Что оплатить',
    plans,
    /** Under the list when it offers both the report and a subscription: one does not include the other. */
    reportIsSeparate: 'Полный разбор в подписку не входит: он покупается отдельно.',
    /** Under the list while a subscription is chosen. */
    renewal: 'Подписка продлевается автоматически. Отменить её можно в настройках Telegram.',
    terms: 'Пользовательское соглашение и оплата',
    /** The price follows: «Оплатить 149 ⭐». */
    pay: 'Оплатить',
    choose: 'Выбери, что оплатить',
    creating: 'Создаём счёт…',
    paying: 'Ждём оплату в Telegram…',
    /** Why the paywall opened after the server refused to order a report; the price follows. Owner's wording. */
    reportRequired: 'Разбор по этой карте уже использован — открой полностью за',
    /** Owner's wording. No full stop of its own: the date ends with «г.». */
    activeUntil: (date: string) => `Подписка активна до ${date}`,
    active: 'Подписка активна.',
    /** The invoice named another price than the list did; the price follows, then `priceChangedAction`. */
    priceChanged: 'Цена на сервере другая:',
    priceChangedAction: 'Проверь её и нажми «Оплатить» ещё раз.',
    /** Owner's wording. */
    unsupported: 'Оплата доступна в Telegram.',
    /** Inside Telegram, in a client too old to open an invoice (before Mini Apps 6.1). */
    outdated: 'Эта версия Telegram не открывает оплату звёздами. Обнови Telegram и попробуй снова.',
    /** Owner's wording. */
    failed: 'Платёж не прошёл. Попробуй ещё раз или выбери другой способ.',
    /** Owner's wording. */
    rateLimited: 'Слишком много попыток оплаты. Попробуй через час.',
    /** After `rateLimited`, when the server says when the limit lifts. */
    rateLimitedUntil: (when: string) => `Снова можно будет после ${when}.`,
    /** Owner's wording. */
    invoiceRejected: 'Не удалось создать счёт.',
    confirmingTitle: 'Проверяем оплату',
    confirmingText: 'Это займёт несколько секунд.',
    /** Owner's wording, in two parts. */
    processingTitle: 'Платёж обрабатывается',
    processingText: 'Открой приложение через минуту.',
    checkAgain: 'Проверить ещё раз',
    /** Leaves the paywall for the screen it was opened from. */
    leave: 'Вернуться',
  },

  /** Screen 6. */
  report: {
    title: 'Полный разбор',
    idleText: 'Разбор пишется по твоей карте, глава за главой. Обычно это занимает 30–90 секунд.',
    /** Owner's wording. */
    order: 'Получить разбор',
    ordering: 'Отправляем заказ…',
    loading: 'Загружаем разбор…',
    /** Owner's wording. */
    queuedTitle: 'Разбор в очереди',
    /** Owner's wording. */
    queuedText: 'Обычно это занимает 30–90 секунд.',
    /** Owner's wording. */
    generatingTitle: 'Пишем разбор',
    progressLabel: 'Готовность разбора',
    /** Owner's wording: «Готово 3 из 7 глав». */
    chaptersReady: (ready: number, total: number, form: PluralForm) =>
      `Готово ${String(ready)} из ${String(total)} ${form === 'one' ? 'главы' : 'глав'}`,
    /** Owner's wording. */
    stalled: 'Это дольше обычного, но разбор ещё готовится.',
    contents: 'Оглавление',
    /** Owner's wording. */
    pdf: 'Скачать PDF',
    pdfUnavailable: 'Ссылка на PDF сейчас недоступна. Попробуй чуть позже.',
    /** Owner's wording. */
    failedTitle: 'Не получилось',
    failedText: 'Разбор не собрался. Можно попробовать снова.',
    /** For support: which report it was. A failed report has no request to name. */
    reportId: (id: string) => `Номер разбора: ${id}`,
    /** Owner's wording. */
    refundedTitle: 'Разбор не получился, звёзды вернулись на счёт.',
    refundedText: 'Можно попробовать снова.',
    /** Owner's wording. */
    retry: 'Попробовать снова',
    /** The report is there and is not paid for: its opening, and the way to the rest. */
    lockedText: 'Остальной текст откроется после оплаты.',
    orderRejectedTitle: 'Не удалось заказать разбор',
    /** Owner's wording. */
    rateLimited: 'Слишком часто, попробуй через минуту.',
  },

  /** Screen 9. */
  settings: {
    title: 'Настройки',
    loading: 'Загружаем настройки…',
    subscription: {
      title: 'Подписка',
      names: subscriptionNames,
      none: 'Подписки нет.',
      ended: 'Подписка закончилась.',
      /** No full stop of its own: the date ends with «г.». */
      until: (date: string) => `Действует до ${date}`,
      renews: 'Продлится автоматически.',
      noRenewal: 'Автопродление отключено.',
      subscribe: 'Оформить подписку',
      /** Owner's wording. */
      cancelTitle: 'Как отменить',
      cancelText: 'Отменить подписку можно в настройках Telegram. Доступ сохранится до конца оплаченного периода.',
      openTelegram: 'Открыть подписки в Telegram',
    },
    quotas: {
      title: 'Лимиты',
      names: quotaNames,
      /** Owner's wording: «Осталось 3 из 5». */
      left: (left: number, limit: number) => `Осталось ${String(left)} из ${String(limit)}`,
      /** Owner's wording. For a limit of -1: never «-1». */
      unlimited: 'Без ограничений',
      /** For a limit of 0: the plan does not include it. */
      unavailable: 'Недоступно',
      resets: (when: string) => `Обновится ${when}`,
      empty: 'Лимитов пока нет.',
    },
    documents: 'Документы',
    support: 'Поддержка',
    deletion: {
      /** Owner's wording, the name the legal texts promise. */
      title: 'Удалить мои данные',
      text: 'Профиль, карты, разборы, прогнозы и вопросы удаляются сразу и навсегда.',
      open: 'Удалить мои данные',
      /** The first confirmation: what exactly goes. */
      confirmTitle: 'Удалить все данные?',
      confirmText: [
        'Удалим профиль, карты, разборы, прогнозы и вопросы — в том числе купленный разбор. Восстановить их не получится.',
        'Подписка сохраняется до конца оплаченного периода.',
      ],
      /** The button of the first confirmation: on to the second, nothing is deleted yet. */
      next: 'Продолжить',
      /** The second confirmation: the last word before the deletion. */
      lastTitle: 'Точно удалить?',
      lastText: ['Это последний шаг. Отменить удаление будет нельзя.'],
      /** Owner's wording. */
      confirm: 'Удалить навсегда',
      cancel: 'Не удалять',
      deleting: 'Удаляем…',
      /** For a 409 that came without the server's own text. */
      conflict: 'Удалить данные сейчас не получилось: мешает незавершённая оплата.',
      failedTitle: 'Данные не удалены',
      /** Owner's wording. */
      sessionExpired: 'Сессия истекла, открой приложение заново.',
      /** Owner's wording: the screen after the deletion, the title and the text under it. */
      doneTitle: 'Данные удалены',
      doneText: 'Подписка сохраняется до конца оплаченного периода.',
    },
  },

  support: {
    /** Owner's wording. */
    write: 'Написать в поддержку',
    /** Owner's wording: the button while there is no contact to lead to. */
    soon: 'Поддержка скоро появится',
  },
} as const;
