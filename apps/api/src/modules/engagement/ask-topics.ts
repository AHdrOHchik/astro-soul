/**
 * Тема вопроса и «мягкий отказ» до вызова модели.
 *
 * Текст вопроса в БД не хранится (ПДн), но тема — хранится: по ней видно,
 * о чём спрашивают, без единой цитаты. Классификатор грубый и намеренно
 * осторожный: лучше отказать до вызова, чем отвечать про диагноз.
 */

export type AskTopic = 'health' | 'death' | 'money' | 'legal' | 'love' | 'work' | 'self' | 'other';

interface Rule {
  readonly topic: AskTopic;
  readonly pattern: RegExp;
  /** Такие вопросы бот не берёт: 200 с мягким отказом, без вызова модели. */
  readonly refuse: boolean;
}

const RULES: readonly Rule[] = [
  { topic: 'health', refuse: true, pattern: /диагноз|заболев|болезн|симптом|здоровь|врач|лечени|депресс|таблетк|беременн|онколог|рак\b|операци/iu },
  { topic: 'death', refuse: true, pattern: /смерт|умр[уёе]|умира|умер|похорон|кончин|сколько (мне )?жить/iu },
  { topic: 'health', refuse: true, pattern: /поставь диагноз|что у меня за болезнь/iu },
  { topic: 'money', refuse: true, pattern: /разбогате|гарантированн\w*\s+доход|инвестиц|акци[ия]|крипт|депозит|казин|ставк[иа] на спорт/iu },
  { topic: 'money', refuse: true, pattern: /заработа\w*\s+гарантированно|точн\w*\s+заработа/iu },
  { topic: 'legal', refuse: true, pattern: /юрист|адвокат|иск в суд|судебн|налог|наследств|договор|раздел имущества/iu },
  { topic: 'love', refuse: false, pattern: /отношени|любов|партн[её]р|муж|жена|брак|свидан|расставан|развод/iu },
  { topic: 'work', refuse: false, pattern: /работ|карьер|начальник|коллег|професси|дело|бизнес|проект/iu },
  { topic: 'self', refuse: false, pattern: /характер|себя|сильн|слаб|страх|устал|ритм|энерги|решени|привычк/iu },
];

/** Тема вопроса по ключевым словам; `other` — если ничего не совпало. */
export function classifyTopic(question: string): AskTopic {
  for (const rule of RULES) {
    if (rule.pattern.test(question)) {
      return rule.topic;
    }
  }
  return 'other';
}

/** Тема, по которой отвечать нельзя, или `null`. */
export function forbiddenTopicOf(question: string): AskTopic | null {
  for (const rule of RULES) {
    if (rule.refuse && rule.pattern.test(question)) {
      return rule.topic;
    }
  }
  return null;
}

/**
 * Мягкий отказ: это `200`, а не `4xx`. Содержательный вопрос, на который
 * сервис не отвечает, — не поломка и не ошибка клиента.
 */
export function softRefusal(topic: AskTopic): string {
  const where =
    topic === 'legal'
      ? 'С этим — к юристу.'
      : topic === 'money'
        ? 'Про гарантии дохода и инвестиции я не рассказываю: это не астрология.'
        : 'С этим — к врачу, и как можно скорее, если вопрос срочный.';

  return `Про это я не могу: здоровье, смерть, гарантии денег и юридические вопросы — не моя роль. ${where} А про свою карту спрашивай смело — про ритм, отношения, работу, выбор.`;
}
