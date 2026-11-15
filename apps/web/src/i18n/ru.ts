import type { ApiErrorCode, ChartWarning, ForecastFocus, Quota, ReportStatus, Subscription, TimePrecision } from '../api';
import type { DateIssue, TimeIssue } from '../lib/birth';
import type { PaywallPlan } from '../lib/plans';
import type { PluralForm } from './format';

/*
 * Every user-facing string of the app. Tone: «ты», gender-neutral, no pressure,
 * no promises about events, health or money (SPEC, «Генерация текста»).
 *
 * The legal texts are not written here: `welcome.disclaimer`, `welcome.terms`,
 * `consent` and `documents` are copied word for word from the file a human owns,
 * `legal-texts-<CONSENT_VERSION>.md` in the repository root. Whether a new wording
 * is a new version is the owner's to say (legal.md §6: the version changes with what
 * is processed and on what ground, not with every rewording). Either way
 * `tests/legal-texts.test.ts` fails until the texts, the file and the version agree.
 *
 * Texts about money, refunds and the deletion of data that the owner worded are
 * marked «owner's wording»: they are not to be rephrased in passing either.
 */

// The version of the legal texts below. It has a file of its own, with nothing else in it: the build reads it too.
export { CONSENT_VERSION } from './consentVersion';

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

/**
 * The owner's rule for the subscriptions: a description names only what the app already
 * delivers (the full forecasts, the questions). What payments.md §1 lists besides (the
 * compatibility, the chart of the year) is named as coming, in the owner's words
 * «появится в ближайшие дни». The day one of those is released, its sentence is reworded.
 * The descriptions below are approved by the owner as they are.
 */
const SOON = 'появится в ближайшие дни';

const plans: Record<PaywallPlan, PlanCopy> = {
  one_149: {
    title: 'Полный разбор',
    description: 'Все главы разбора по этой карте. Разовая покупка, без подписки.',
  },
  week_149: {
    title: 'Подписка на неделю',
    description: `Полные прогнозы, 5 вопросов карте в день. Совместимость раз в месяц ${SOON}.`,
  },
  month_399: {
    title: 'Подписка на месяц',
    description: `Полные прогнозы, 5 вопросов карте в день. Совместимость раз в месяц ${SOON}.`,
  },
  year_2990: {
    title: 'Подписка на год',
    description: `Всё, что в подписке на месяц. Карта года ${SOON}.`,
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

/**
 * The focus of a forecast as a label next to the text, under the names the app gives the
 * server's codes (src/api). The focus on energy and routine is `wellbeing` here and
 * «самочувствие» on screen: the service gives no advice on the other word, and the key is
 * named so that nobody writes that word in. The labels are approved by the owner.
 */
const focusNames: Record<ForecastFocus, string> = {
  career: 'карьера',
  love: 'отношения',
  money: 'деньги',
  wellbeing: 'самочувствие',
  self: 'внимание к себе',
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

/** Owner's wording: what deleting the data does to a subscription. The sentence of the last confirmation that stands out. */
const SUBSCRIPTION_IS_LOST = 'Подписка отменяется сразу, оплаченный период не возвращается.';

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
      'Ты можешь удалить все данные в любой момент: Настройки → «Удалить мои данные». Профиль, карта, разборы, прогнозы и вопросы удаляются безвозвратно. Подписка при этом отменяется, доступ закрывается сразу, оплаченный период не возвращается. Обезличенная история платежей (без имени, даты рождения и места) сохраняется, пока этого требует бухгалтерский учёт и возможность возврата.',
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
        'Ты можешь удалить все данные в любой момент: Настройки → «Удалить мои данные». Профиль, карта, разборы, прогнозы и вопросы удаляются безвозвратно; подписка отменяется, оплаченный период не возвращается; обезличенная история платежей сохраняется для бухгалтерского учёта и возвратов. Если ты не заходишь 24 месяца, данные удаляются автоматически.',
        'Аналитика: мы собираем обезличенную статистику использования. В событиях нет даты, времени и места рождения, текста вопросов и имени.',
      ],
    },
    /** Without the support line of the source file: it holds a placeholder until there is a contact to show. */
    terms: {
      paragraphs: [
        '18+. Сервис носит развлекательный и ознакомительный характер. Разборы и прогнозы не являются медицинской, психологической, юридической или финансовой рекомендацией и не предсказывают события. Решения о здоровье, деньгах и отношениях принимай самостоятельно.',
        'Оплата проходит звёздами Telegram. Подписка продлевается автоматически, пока ты её не отменишь. Отменить можно в настройках Telegram — тогда доступ сохранится до конца оплаченного периода. Если ты удаляешь данные в приложении, подписка отменяется сразу, доступ закрывается, оплаченный период не возвращается. Если товар не был предоставлен из-за технической ошибки, звёзды возвращаются автоматически.',
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
    /**
     * Owner's wording, in one piece: «Подписка активна. Карта не найдена — возможно, данные удалили на
     * другом устройстве. Построй карту заново, подписка при этом сохранится.» Said when the server
     * confirms a subscription and names no chart, though the app had one on screen: the data was
     * deleted elsewhere while this page stayed open, and the user has just paid on it. The first
     * sentence is the title the screen has anyway (`active`, or `activeUntil` with the date); this
     * is the rest, the text under it, so that nothing is said twice.
     */
    chartMissing: 'Карта не найдена — возможно, данные удалили на другом устройстве. Построй карту заново, подписка при этом сохранится.',
    /** Owner's wording: the one button under that text, in place of the usual one. */
    buildChart: 'Построить карту',
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
    /** Nothing is on offer: no report to buy here, and this build sells no subscriptions. Approved by the owner. */
    nothingOnSale: 'Сейчас здесь нечего оплачивать',
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

  /** Screen 8, and its card on the chart screen. The forecast itself is the server's text, never written here. */
  forecast: {
    /** Owner's wording: the name of the card and of the screen while the forecast is today's. */
    title: 'Прогноз на сегодня',
    /** Owner's wording, for a forecast of another day: «Прогноз на 14 ноября». Never «сегодня» for it. */
    titleFor: (day: string) => `Прогноз на ${day}`,
    /** Approved by the owner. */
    loading: 'Загружаем прогноз…',
    /** «Фокус дня» is the owner's wording; the name comes from `focusNames`. */
    focus: (name: string) => `Фокус дня: ${name}`,
    focusNames,
    /** Owner's wording, in two parts: the server has no forecast for today yet. Not a failure and worded as none. */
    pendingTitle: 'Сегодняшний прогноз готовится',
    pendingText: 'Загляни после 08:00',
    /**
     * Owner's wording, the second line under it: whose 08:00 that is. The server sends the forecast at
     * eight by the clock of the birth place, which need not be the clock of the user's phone.
     */
    pendingNote: 'Время считается по месту рождения.',
    /** Owner's wording. */
    toChart: 'К карте',
    /** Owner's wording: the request itself failed. */
    failedTitle: 'Не получилось загрузить прогноз',
    /** Owner's wording. */
    ask: 'Спросить карту',
    /** Owner's wording. What goes out is the picture of the chart, never the text of the forecast. */
    share: 'Поделиться',
    /** Owner's wording: under the short forecast. A note, not a call to pay. */
    subscriptionOnly: 'Полный прогноз — в подписке',
  },

  /**
   * «Спроси карту»: one question, one answer. The answer is the server's text, never written or reworded here.
   * Every line of this screen is the owner's wording or approved by the owner.
   */
  ask: {
    title: 'Спроси карту',
    fieldLabel: 'Твой вопрос',
    placeholder: 'Например: на что мне опереться в работе?',
    /** Under the field: «120 / 500». */
    counter: (length: number, max: number) => `${String(length)} / ${String(max)}`,
    /** The same for a screen reader. */
    counterLabel: (length: number, max: number) => `Набрано знаков: ${String(length)} из ${String(max)}`,
    /** Owner's wording. */
    submit: 'Спросить',
    sending: 'Спрашиваем карту…',
    /** Owner's wording: «Сегодня осталось 3 вопроса из 5». */
    left: (left: number, limit: number, form: PluralForm) => {
      const verb = form === 'one' ? 'остался' : 'осталось';
      const noun = form === 'one' ? 'вопрос' : form === 'few' || form === 'other' ? 'вопроса' : 'вопросов';
      return `Сегодня ${verb} ${String(left)} ${noun} из ${String(limit)}`;
    },
    /** Owner's wording. For a limit of -1: never «-1». */
    unlimited: 'Без ограничений',
    /** Owner's wording: the day's questions are used up. Not a failure and worded as none. */
    exhausted: 'Вопросы на сегодня закончились. Новые — после полуночи.',
    /** After `exhausted`: the moment by the user's own clock. */
    resets: (when: string) => `Обновится ${when}.`,
    /** After `resets`, when that moment is not midnight where the user is: whose midnight it is. */
    resetsElsewhere: 'Полночь считается по месту рождения.',
    /** Owner's wording: the quiet way to the paywall. */
    subscriptionOffer: 'В подписке 5 вопросов в день',
    /** Above the question the answer on screen belongs to. */
    asked: 'Твой вопрос',
    answer: 'Ответ карты',
    /** Owner's wording. */
    basedOn: 'На чём основано',
    /** For a 422 that came without the server's own words about the question. */
    rejected: 'Сервер не принял вопрос.',
    failedTitle: 'Ответ не получен',
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
      /** What goes is the list of SPEC.md (scenario 7, «Удаление данных»). */
      text: 'Удаляются профиль, карты, разборы, прогнозы и вопросы. Это необратимо.',
      open: 'Удалить мои данные',
      /** The first confirmation: what exactly goes, what it costs and what stays. */
      confirmTitle: 'Удалить все данные?',
      confirmText: [
        'Удалим профиль, карты, разборы, прогнозы и вопросы — в том числе купленный разбор. Восстановить их не получится.',
        /**
         * Owner's wording (SPEC.md, scenario 7, and legal.md §2), to be said before the tap. Since
         * contract 1.5.5 the server cancels the subscription together with the data; until then
         * this line promised the opposite, that the subscription lives on to the end of its period.
         * Said to everyone: the app does not decide by its own copy of `Me` who needs to hear it.
         */
        'Подписка при этом отменяется, доступ закрывается сразу, оплаченный период не возвращается.',
        /** Owner's wording, a requirement of legal.md (§1: payment identifiers are kept for accounting, without personal data). */
        'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
      ],
      /** Owner's wording. The button of the first confirmation: on to the second, nothing is deleted yet. */
      next: 'Удалить данные',
      /** The second confirmation: the last word before the deletion. */
      lastTitle: 'Точно удалить?',
      /**
       * Owner's wording, three sentences, on the confirmation whose button deletes: a paragraph each.
       * Said to everyone, like the same thing on the first confirmation.
       */
      lastText: [
        'Удаляются профиль, карты, разборы, прогнозы и вопросы — в том числе купленный разбор.',
        SUBSCRIPTION_IS_LOST,
        'Восстановить данные не получится.',
      ],
      /**
       * The one of them that is drawn bold, at full size and never in small print: it is what keeps
       * the user from a surprise about money, and the owner asked for it to stand out.
       */
      lastTextStrong: SUBSCRIPTION_IS_LOST,
      /** Owner's wording. */
      confirm: 'Удалить навсегда',
      cancel: 'Не удалять',
      deleting: 'Удаляем…',
      /** For a 409 that came without the server's own text. */
      conflict: 'Удалить данные сейчас не получилось: мешает незавершённая оплата.',
      failedTitle: 'Данные не удалены',
      /** Owner's wording. */
      sessionExpired: 'Сессия истекла, открой приложение заново.',
      /**
       * Owner's wording, the screen after the deletion. The title is for everyone; the text under it
       * comes in two variants, by whether the user had a subscription when they asked for the deletion.
       */
      doneTitle: 'Данные удалены',
      /**
       * Owner's wording, for a user who had no subscription, and for one the app knows nothing about:
       * not a word of a subscription. Silence is better than a statement that may be false.
       */
      doneText: 'Если захочешь вернуться — начнёшь с чистого листа.',
      /** Owner's wording, for a user who had a subscription, a cancelled one still paid for included: the same line, and what became of it. */
      doneTextSubscribed: 'Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.',
      /** Under that, in small print, by the owner's order of the lines: what stays, in the words of the first confirmation. For everyone. */
      doneNote: 'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
      /**
       * Owner's wording: the link to the subscriptions in Telegram's own settings, for a user who had
       * one. The server cancels the subscription on its side, and nothing in apps/api tells Telegram
       * to stop renewing it (issue #29): where the subscription lives is the one thing the user can
       * look into and act on.
       */
      manageSubscriptions: 'Управлять подписками в Telegram',
    },
  },

  support: {
    /** Owner's wording. */
    write: 'Написать в поддержку',
    /**
     * Owner's wording: the button while the build has no contact to lead to (`VITE_SUPPORT_CONTACT`).
     * The key keeps its first name, from the days the button said that support was coming.
     */
    soon: 'Контакт поддержки ещё не задан',
  },
} as const;
