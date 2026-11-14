#!/usr/bin/env node
/**
 * QA-002, задача 6 (3a), часть «антипримеры §3.1–3.5 бракуются нужным пунктом рубрики».
 *
 * Берём пять антипримеров из `docs/qa/reports/examples.md` §3 и применяем к ним
 * те проверки рубрики, которые объявлены как «К» (код, детерминированно):
 * п.2 (запрещённые темы), п.3 (лесть/запугивание), п.4 (даты и обещания),
 * п.5 (фраза-автопровал), п.10 («вы» и дома при unknown).
 *
 * Смысл: если антипример не ловится ни одной кодовой проверкой, значит рубрика
 * и примеры разошлись, и валидатор будет пропускать ровно то, что авторы
 * называют браком. Печатаем таблицу «антипример → какие пункты сработали».
 *
 * Ограничение: это проверка ДОКУМЕНТОВ, а не продукта — валидаторов в коде нет
 * (нет LLM-модуля). Пункты «С» (судья) здесь не воспроизводятся.
 *
 * Запуск: node e2e/qa/rubric-check.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const examples = readFileSync(join(ROOT, 'docs/qa/reports/examples.md'), 'utf8');

/** Регулярки — дословно из формулировок рубрики (`rubric.md` §1). */
const CHECKS = [
  {
    id: '2',
    title: 'запрещённые темы',
    patterns: [
      /карм(а|ический|ой)/i, /судьб(а|ы|ой)/i, /мисси(я|и|ю)/i, /предназначени/i,
      /порч(а|и)/i, /в прошлой жизни/i, /выгорани/i, /срыв(ы|а|ов)?\b/i,
      /диагноз/i, /беременн/i, /гороскоп/i, /инвестици/i, /налог/i,
    ],
  },
  {
    id: '3',
    title: 'лесть и запугивание',
    patterns: [
      /прирождённ/i, /редк(ая|ой) глубин/i, /сильн(ая|ой) интуици/i, /потенциал/i,
      /тебе грозит/i, /разрушительн/i, /срочно/i, /иначе последстви/i,
      /венчан/i, /большие вершины/i, /тяжёлый аспект/i,
    ],
  },
  {
    id: '4',
    title: 'прогнозы, даты, обещания',
    patterns: [
      /этой осенью/i, /к концу года/i, /через месяц/i, /скоро\b/i,
      /произойдёт/i, /наконец получишь/i, /ждал:/i, /звёзды складываются/i,
      /изменит всё/i, /\b(19|20)\d{2}\b/,
    ],
  },
  {
    id: '5',
    title: 'конкретность (автопровал)',
    patterns: [/и сильные, и слабые стороны/i, /всё зависит от настроения/i],
  },
  {
    id: '10a',
    title: 'обращение на «ты»',
    patterns: [/\b(вы|ваш|ваша|ваше|ваши|вас|вам)\b/i],
  },
  {
    // Отдельно от 10a: дома запрещены ТОЛЬКО при `time_precision = unknown`,
    // при точном времени это нормальный фактор. Смешивать нельзя — получим
    // ложный брак хорошего текста.
    id: '10b',
    title: 'дома/ASC при unknown',
    patterns: [
      /в \d+(-м|-ом)? доме/i,
      /в (первом|втором|третьем|четвёртом|пятом|шестом|седьмом|восьмом|девятом|десятом|одиннадцатом|двенадцатом) доме/i,
      /дом карты/i, /куспид/i,
    ],
  },
];

/** Вытащить разделы §3.x и их блоки цитат (антипример — первый блок, «как надо» — второй). */
function sections(md) {
  const out = [];
  const lines = md.split('\n');
  let current = null;
  let block = [];
  let blocks = [];
  const flush = () => {
    if (block.length > 0) blocks.push(block.join(' ').trim());
    block = [];
  };
  for (const line of lines) {
    const head = /^### (3\.\d) (.+)$/.exec(line);
    if (head) {
      flush();
      if (current) out.push({ ...current, blocks });
      current = { id: head[1], title: head[2] };
      blocks = [];
      continue;
    }
    if (!current) continue;
    if (line.startsWith('## ')) break;
    if (line.startsWith('>')) {
      block.push(line.replace(/^>\s?/, ''));
      continue;
    }
    flush();
  }
  flush();
  if (current) out.push({ ...current, blocks });
  return out;
}

const hits = (text) => CHECKS.filter((c) => c.patterns.some((p) => p.test(text)));

let failures = 0;
for (const section of sections(examples)) {
  const [bad, good] = section.blocks;
  if (bad === undefined) {
    console.log(`${section.id}: антипример не найден в документе — проверить вручную`);
    failures += 1;
    continue;
  }
  const badHits = hits(bad);
  // Для «как надо» дома — не ложное срабатывание: примеры написаны для точного
  // времени. Проверяем только обращение на «ты» и общие запреты.
  const goodHits = hits(good ?? '').filter((h) => h.id !== '10b');
  console.log(`\n§${section.id} ${section.title}`);
  console.log('  антипример ловится пунктами:', badHits.length ? badHits.map((h) => `${h.id} (${h.title})`).join(', ') : 'НЕТ НИ ОДНОГО — дыра в рубрике');
  if (badHits.length === 0) failures += 1;
  console.log('  «как надо» ложно ловится:', goodHits.length ? goodHits.map((h) => `${h.id}`).join(', ') : '(нет)');
  const houses = /в \d+(-м|-ом)? доме|доме\b|куспид|Асцендент/i.test(good ?? '');
  if (houses) console.log('  примечание: «как надо» ссылается на дома/Асцендент — годится только при точном времени; при unknown это п.10b');
}

console.log(`\nитог: ${failures === 0 ? 'каждый антипример ловится хотя бы одним кодовым пунктом' : `${failures} антипример(ов) не ловится`}`);
process.exit(failures === 0 ? 0 : 1);
