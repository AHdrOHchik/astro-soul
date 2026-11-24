import type { ApiErrorCode, ChartWarning, ForecastFocus, Quota, ReportStatus, Subscription, TimePrecision } from '../api';
import type { DateIssue, TimeIssue } from '../lib/birth';
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
  // Код доступа был и кончился (410). Не «неверный код»: человек его уже
  // активировал или получил просроченным, и текст не должен звучать как упрёк.
  GONE: {
    title: 'Срок кода вышел',
    text: 'Этот код больше не действует. Спроси новый у того, кто его дал.',
  },
  // Бюджет бесплатного доступа на месяц выбран (503). Это не поломка и не
  // вина человека: действующие права работают, новые просто пока не выдаются.
  BONUS_BUDGET_EXHAUSTED: {
    title: 'Коды временно не принимаются',
    text: 'Бесплатный доступ на этот месяц закончился. Попробуй в следующем.',
  },
  // Функция не настроена на сервере (503, контракт 1.6.17). Пользователю это
  // видно только если такой запрос вообще случится в приложении; текст не
  // обвиняет человека и не обещает, что «скоро заработает».
  UNAVAILABLE: {
    title: 'Сейчас недоступно',
    text: 'Эта функция пока не настроена. Мы уже знаем — попробуй позже.',
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
  refunded: 'Разбор не получился. Автовозврат за неудавшийся разбор не делается. Вместо него: повторный запуск без новой оплаты; звёзды за неудачную попытку возвращаются по обращению в поддержку.',
};

/** Owner's wording: what deleting the data does to a subscription. The sentence of the last confirmation that stands out. */
const SUBSCRIPTION_IS_LOST = 'Подписка отменяется сразу, оплаченный период не возвращается.';

/** Telegram Stars, the app's only currency. */
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
    freeChart: 'Построить карту — бесплатно.',
    fullReport: 'Полный разбор —',
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
        'Оплата проходит звёздами Telegram. Подписка продлевается автоматически, пока ты её не отменишь. Отменить можно в настройках Telegram — тогда доступ сохранится до конца оплаченного периода. Если ты удаляешь данные в приложении, подписка отменяется сразу, доступ закрывается, оплаченный период не возвращается. Автовозврат за неудавшийся разбор не делается. Вместо него: повторный запуск без новой оплаты; звёзды за неудачную попытку возвращаются по обращению в поддержку.',
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
    planetPositions: 'Планеты в знаках: позиции на карте',
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
    teaserCta: 'Открыть полностью',
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

  /** Screen 7. Plan names, descriptions and prices come from the authenticated server catalogue. */
  paywall: {
    title: 'Тарифы',
    lead: 'Оплата проходит звёздами Telegram.',
    optionsLabel: 'Что оплатить',
    loadingPlans: 'Загружаем тарифы…',
    plansError: 'Не получилось загрузить тарифы',
    retryPlans: 'Попробовать снова',
    sessionExpired: 'Сессия устарела, закрой и открой приложение заново',
    testPlans: 'Тестовые (1 ⭐)',
    testPlansNote: 'Для проверки оплаты. Не для продажи.',
    /** Under the list when it offers both the report and a subscription: one does not include the other. */
    reportIsSeparate: 'Полный разбор в подписку не входит: он покупается отдельно.',
    /** Under the list while a subscription is chosen. */
    renewal: 'Подписка продлевается автоматически. Отменить её можно в настройках Telegram.',
    terms: 'Пользовательское соглашение и оплата',
    /** The server-supplied price follows. */
    pay: 'Оплатить',
    choose: 'Выбери, что оплатить',
    creating: 'Создаём счёт…',
    paying: 'Ждём оплату в Telegram…',
    /** Why the paywall opened after the server refused to order a report; the price follows. Owner's wording. */
    reportRequired: 'Разбор по этой карте уже использован — открой полностью за',
    /** Owner's wording. No full stop of its own: the date ends with «г.». */
    activeUntil: (date: string) => `Подписка активна до ${date}`,
    active: 'Подписка активна.',
    subscriptionWithoutChart: 'Подписка активна. Карта не найдена — возможно, данные удалили на другом устройстве. Построй карту заново, подписка при этом сохранится.',
    buildChart: 'Построить карту',
    /** The invoice named another price than the list did; the price follows, then `priceChangedAction`. */
    priceChanged: 'Цена изменилась — обнови экран.',
    priceChangedAction: 'Обновить',
    priceUnavailable: 'Оплата временно недоступна',
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

  shareCard: {
    sheetTitle: 'Поделиться карточкой',
    close: 'Закрыть',
    back: 'Назад',
    otherOptions: 'Другие способы',
    inline: 'В Telegram',
    telegramStory: 'В Telegram-сторис',
    saveImage: 'Сохранить картинку',
    saveInstruction: 'Откроется картинка — нажми и удерживай, чтобы сохранить',
    day: 'Поделиться днём',
    moon: 'Поделиться фазой Луны',
    identity: 'Поделиться карточкой о себе',
    notEnoughIdentityLines: 'Пока не из чего собрать карточку',
  },

  /** Screen 6. */
  report: {
    title: 'Полный разбор',
    idleText: 'Разбор пишется по твоей карте, глава за главой. Обычно это занимает 30–90 секунд.',
    /** Owner's wording. */
    order: 'Получить разбор',
    ordering: 'Отправляем заказ…',
    loading: 'Загружаем разбор…',
    goneTitle: 'Разбор удалён',
    goneText: 'Этот разбор больше недоступен. Можно создать новый.',
    goneOrder: 'Создать новый разбор',
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
    pdfPreparing: 'Готовим PDF',
    pdfFailed: 'Не получилось собрать PDF',
    pdfRetry: 'Попробовать снова',
    pdfNotPaid: 'PDF доступен после покупки разбора',
    pdfUnavailable: 'Ссылка на PDF сейчас недоступна. Попробуй чуть позже.',
    pdfRetryIn: (seconds: number) => `Попробовать снова через ${String(seconds)} сек.`,
    sharePreparing: 'Готовим карточку…',
    shareFailed: 'Не удалось открыть отправку карточки. Попробуй ещё раз.',
    /** Owner's wording. */
    failedTitle: 'Не получилось',
    failedText: 'Разбор не собрался. Можно попробовать снова.',
    /** For support: which report it was. A failed report has no request to name. */
    reportId: (id: string) => `Номер разбора: ${id}`,
    /** Owner's wording. */
    refundedTitle: 'Разбор не получился.',
    refundedText: 'Автовозврат за неудавшийся разбор не делается. Вместо него: повторный запуск без новой оплаты; звёзды за неудачную попытку возвращаются по обращению в поддержку.',
    /** Owner's wording. */
    retry: 'Попробовать снова',
    /** The report is there and is not paid for: its opening, and the way to the rest. */
    lockedText: 'Остальной текст откроется после оплаты.',
    orderRejectedTitle: 'Не удалось заказать разбор',
    /** Owner's wording. */
    rateLimited: 'Слишком часто, попробуй через минуту.',
    breakerOpenTitle: 'Разбор временно недоступен',
    breakerOpenText: 'Разбор сейчас не получается. Мы уже разбираемся — попробуй через полчаса.',
  },

  compatibility: {
    title: 'Совместимость с партнёром',
    entryTitle: 'Узнать совместимость с партнёром',
    formTitle: 'Данные партнёра',
    formPrivacy: 'Данные партнёра нужны только для расчёта. Мы не спрашиваем имя и не показываем его. Совместимость хранится вместе с остальными твоими данными и удаляется вместе с ними.',
    unknownTime: 'Без времени рождения мы не сможем показать, как вы влияете на сферы жизни друг друга — часть текста будет короче.',
    purchaseDisclosure: 'Оплата за совместимость — за одну пару; если совместимость не получилась, повторный запуск бесплатен.',
    relationship: 'Кем тебе приходится человек',
    relationships: { romantic: 'Партнёр', friend: 'Друг', family: 'Родственник', colleague: 'Коллега' },
    birthDate: 'Дата рождения',
    birthTime: 'Время рождения',
    dateSegments: { day: 'День', dayPlaceholder: 'ДД', month: 'Месяц', monthPlaceholder: 'ММ', year: 'Год', yearPlaceholder: 'ГГГГ' },
    timeSegments: { hours: 'Часы', hoursPlaceholder: 'ЧЧ', minutes: 'Минуты', minutesPlaceholder: 'ММ' },
    invalidTime: 'Введи время в формате ЧЧ:ММ.',
    queryTooLong: (length: number) => `Введи не больше ${String(length)} символов.`,
    unknownTimeLabel: 'Время неизвестно',
    place: 'Город рождения',
    placePlaceholder: 'Начни вводить город',
    searching: 'Ищем город…',
    searchFailed: 'Не удалось найти город. Попробуй ещё раз.',
    noPlaces: 'Ничего не найдено. Проверь название города.',
    submit: 'Рассчитать совместимость',
    missingDate: 'Введи дату рождения.',
    invalidDate: 'Проверь дату рождения.',
    missingPlace: 'Выбери город из списка.',
    pendingTitle: 'Считаем совместимость',
    pendingText: 'Это может занять немного времени. Ты можешь уйти на другой экран и вернуться позже.',
    createAnother: 'Создать ещё',
    share: 'Поделиться',
    shareMessage: 'Мой разбор совместимости в Astro Soul',
    goTo: 'Перейти',
    backToForm: 'Вернуться к форме',
    retryAgain: 'Попробовать снова',
    quotaPaid: 'Оплачено, не израсходовано',
    quotaSubscription: (left: number, date?: string) => `Входит в подписку · осталась ${String(left)}${date ? ` до ${date}` : ''}`,
    quotaNext: (date: string) => `Следующая — ${date}`,
    quotaNextUnknown: 'Следующая совместимость появится, когда сервер откроет квоту.',
    loadingQuota: 'Загружаем квоту совместимости',
    quotaError: 'Не удалось узнать остаток квоты.',
    quotaNone: (stars: number) => `${String(stars)} ⭐ за одну пару`,
      quotaLabel: 'Квота совместимости',
    quotaLoading: 'Обновляем…',
    quotaUnavailable: 'Квота совместимости недоступна.',
    quotaNoAccess: 'Нужна подписка или отдельная покупка.',
    purchaseUsed: 'Оплаченная совместимость использована.',
    sectionTrimmed: 'Раздел сокращён по объёму',
    stepDisclaimer: 'Разбор — инструмент саморефлексии, а не предсказание и не замена специалисту.',
    listTitle: 'Совместимости',
    backToList: 'К списку совместимостей',
    listEmpty: 'Совместимостей пока нет.',
    listPriceLoading: 'Загружаем цену…',
    listRetry: 'Не удалось загрузить совместимости.',
    listCount: (total: number) => `Всего: ${String(total)}`,
    listLoadMoreError: 'Не удалось загрузить ещё.',
    listLoadMore: 'Загрузить ещё',
    failedResult: 'Этот разбор не удался. Квота не списана.',
    status: { pending: 'Считается', ready: 'Готово', failed: 'Не получилось' },
    noPrice: 'Оплата временно недоступна',
    buy: (stars: number) => `Купить за ${String(stars)} ⭐`,
    quotaExhausted: (date: string) => `Одна совместимость в подписке уже использована. Следующая — ${date}.`,
    quotaExhaustedUnknown: 'Одна совместимость в подписке уже использована. Следующую дату сообщит сервер.',
    alreadyOwned: 'У тебя уже есть оплаченная совместимость — используй её',
    breakerOpen: 'Совместимость сейчас не считается. Мы уже разбираемся — попробуй через полчаса.',
    genericError: 'Не получилось, попробуй ещё раз.',
    formError: 'Проверь данные партнёра.',
    errorTitle: 'Не получилось',
    emptyChart: 'Чтобы рассчитать совместимость, сначала нужна твоя натальная карта.',
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
      subscribe: 'Оформить подписку',
      ended: 'Подписка закончилась.',
      endedAt: (date: string) => `Подписка закончилась ${date}`,
      active: 'Подписка активна.',
      activeUntil: (date: string) => `Подписка активна до ${date} Продлится автоматически.`,
      renews: 'Продлится автоматически.',
      noRenewalUntil: (date: string) => `Автопродление отключено. Доступ до ${date}`,
      noRenewalNoDate: 'Автопродление отключено.',
      cancelledAt: (cancelled: string, until: string | null) => `Автопродление отключено ${cancelled}${until === null ? '' : ` Доступ до ${until}`}`,
      offer: 'Оформить подписку',
      subscribeAgain: 'Оформить снова',
      offerAgainAfter: (date: string) => `Оформить заново можно после ${date}`,
      cancelTitle: 'Отменить автопродление?',
      confirmCancel: (date: string) => `Отменить автопродление? Доступ сохранится до ${date}, деньги за этот период не возвращаются.`,
      noRefundStars: 'Отмена автопродления не возвращает звёзды за текущий период.',
      cancelAutoRenew: 'Отменить автопродление',
      confirmCancelAction: 'Да, отменить автопродление',
      keepSubscription: 'Оставить как есть',
      cancelling: 'Обновляем подписку…',
      retryCancel: 'Попробовать снова',
      refreshStatus: 'Обновить статус',
      noPeriodDate: 'Не удалось получить дату окончания оплаченного периода. Попробуй обновить статус.',
      alreadyCancelled: 'Автопродление уже отключено.',
      noActiveSubscription: 'Активную подписку не нашли. Обновляем данные…',
      cancelInvalidKey: 'Не удалось подтвердить запрос на отмену. Статус подписки не изменён; обнови его или обратись в поддержку.',
      cancelFailed: (date: string) => `Не получилось отменить в Telegram. До ${date} доступ сохранится, попробуем ещё раз автоматически.`,
      cancelFailedNoDate: 'Не получилось отменить в Telegram. Доступ сохранится, попробуем ещё раз автоматически.',
      noChargeId: (date: string) => `Мы не смогли отменить автопродление автоматически. Напиши в поддержку — отменим вручную. До ${date} доступ сохранится.`,
      noChargeIdNoDate: 'Мы не смогли отменить автопродление автоматически. Напиши в поддержку — отменим вручную.',
      gaveUp: (date: string) => `Автоматически отменить автопродление не получилось — напиши в поддержку. До ${date} доступ сохранится.`,
      gaveUpNoDate: 'Автоматически отменить автопродление не получилось — напиши в поддержку.',
      cancelGenericError: 'Не получилось, попробуй ещё раз.',
      refreshStatusFailed: 'Не удалось обновить статус подписки. Мы не показываем отмену, пока сервер её не подтвердит.',

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
    notifications: {
      title: 'Уведомления',
      dailyForecast: 'Прогноз дня в 08:00',
      note: 'Приходит раз в день, по времени места рождения. Отключить можно в любой момент',
      saveFailed: 'Не сохранилось, попробуй ещё раз',
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
      /** The screen after deletion: common title and the variant for a user with no subscription. */
      doneTitle: 'Данные удалены',
      doneText: 'Если захочешь вернуться — начнёшь с чистого листа.',
      /** Owner's wording, shown only when the user had an active subscription before deletion. */
      doneSubscriptionText: 'Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.',
      /** Under either text, in small print: what stays, in the words of the first confirmation. */
      doneNote: 'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
      /** Shown only to users who had a subscription before deletion. */
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
