import type { ApiErrorCode, TimePrecision } from '../api';
import type { DateIssue, TimeIssue } from '../lib/birth';
import type { PluralForm } from './format';

/*
 * Every user-facing string of the app. Tone: «ты», gender-neutral, no pressure,
 * no promises about events, health or money (SPEC, «Генерация текста»).
 *
 * The exceptions are `consent` and `documents`: legal texts, copied from `legal.md`
 * word for word and in that document's own tone. They are never edited here. A new
 * wording comes from `legal.md` together with a new CONSENT_VERSION;
 * `tests/legal-texts.test.ts` fails until both are in place.
 */

/**
 * Version of the legal texts below, sent as `consent.version` in `POST /charts`: the
 * server stores it next to the user's consent. `legal.md` sets the format, the date of
 * the text as YYYY-MM-DD; this one is the day `legal.md` came into the repository.
 * A new date is due whenever the consent screen or a document it links to changes.
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
  CONFLICT: {
    title: 'Есть незавершённая оплата',
    text: 'Дождись, пока платёж завершится, и попробуй снова.',
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
    returning: 'Чтобы снова открыть свою карту, введи данные рождения ещё раз.',
    points: [
      { title: 'Три шага', text: 'Дата, время и место рождения — и карта готова.' },
      { title: 'Солнце, Луна, Асцендент', text: 'Короткий разбор трёх главных точек карты.' },
      { title: 'Время знать не обязательно', text: 'Без него карта строится, но без Асцендента и домов.' },
    ],
    disclaimer:
      '18+. Это развлекательный контент: не предсказание событий и не медицинская, юридическая или финансовая консультация.',
    start: 'Начать',
  },

  /** `legal.md`, section 2, word for word. See the note at the top of this file before touching it. */
  consent: {
    title: 'Обработка данных',
    lead: 'Для расчёта карты нам нужны дата, время и место вашего рождения. Это персональные данные, поэтому нужно ваше согласие.',
    points: [
      'Мы используем их только для расчёта карты и генерации вашего разбора.',
      'Не передаём третьим лицам; текст разбора генерируется без вашего имени, точных координат и id.',
      'Вы можете удалить все данные в любой момент: Настройки → «Удалить мои данные». Это необратимо.',
      'Если вы не заходите 24 месяца, данные удаляются автоматически.',
    ],
    /** The two documents the screen links to, by the names `legal.md` gives them. */
    documents: {
      privacy: 'Политика обработки персональных данных',
      terms: 'Пользовательское соглашение и оплата',
    },
    checkbox: 'Я согласен на обработку персональных данных',
    submit: 'Продолжить',
  },

  /**
   * What the two links of the consent screen open. Neither document is written yet,
   * so each screen shows the part of `legal.md` that belongs to it, word for word:
   * section 1 (what is collected and why) under the policy, section 3 (the disclaimer
   * that `legal.md` requires in the offer) under the agreement.
   */
  documents: {
    privacy: {
      caption: 'Что мы собираем и зачем',
      columns: ['Данные', 'Зачем', 'Хранение'],
      rows: [
        ['Дата рождения', 'расчёт натальной карты', 'до удаления пользователем или 24 мес неактивности'],
        ['Время рождения (если указано)', 'точность домов и Асцендента', 'то же'],
        ['Место рождения (город, координаты, часовой пояс)', 'расчёт карты', 'то же'],
        ['telegram_id, username', 'идентификация, оплата', 'пока существует аккаунт'],
        ['Тексты вопросов к карте', 'ответ на вопрос', 'до удаления, не передаются третьим лицам'],
        ['Платёжные идентификаторы', 'бухгалтерия, возвраты', 'по требованиям учёта, без ПДн'],
      ],
      notCollected: 'Не собираем: паспортные данные, телефон, email, геолокацию устройства, контакты.',
    },
    terms: {
      disclaimer:
        '18+. Сервис носит развлекательный и ознакомительный характер. Разборы и прогнозы не являются медицинской, психологической, юридической или финансовой рекомендацией и не предсказывают события. Решения о здоровье, деньгах и отношениях принимайте самостоятельно.',
    },
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
    approxTime: 'Время указано примерно, поэтому Асцендент и дома могут быть неточными.',
    unknownTime: 'Время рождения не указано, поэтому положение Луны приблизительное: за сутки она проходит около 13°.',
    emptyTitle: 'Карта пришла пустой',
    emptyText: 'Сервер построил карту, но не прислал ни позиций, ни колеса. Попробуй ещё раз.',
    editData: 'Изменить данные рождения',
    teaserTitle: 'Полный разбор',
    teaserLocked: 'Продолжение закрыто',
    /** The price follows: «Открыть полностью — 149 ⭐». The space before the dash is non-breaking. */
    teaserCta: 'Открыть полностью\u00a0—',
    teaserSoon: 'Покупка полного разбора появится в следующем обновлении.',
  },
} as const;
