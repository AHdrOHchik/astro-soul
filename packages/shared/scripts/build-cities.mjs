#!/usr/bin/env node
/**
 * Сборка справочника городов (`geo.md`, «Состав справочника»).
 *
 * Источник — дамп GeoNames `cities1000` (лицензия CC BY 4.0). Скрипт руками не
 * правит ничего: он читает дамп и административные единицы, отбирает записи по
 * населению и пишет `src/geo/cities.data.ts` + `src/geo/cities.meta.ts`.
 *
 * Почему справочник лежит в `src/geo/cities.data.ts`, а не в `data/cities.json`:
 * у `packages/shared` `rootDir = src`, и JSON за его пределами не попадает в
 * `dist`. API импортирует пакет, а не файл, поэтому данные обязаны собираться
 * вместе с кодом. Формат записи (`CityRecord`) менять нельзя без правки
 * `geo.md`.
 *
 * Использование:
 *
 *   node packages/shared/scripts/build-cities.mjs --fetch
 *   node packages/shared/scripts/build-cities.mjs --cities /path/cities1000.txt \
 *        --admin1 /path/admin1.json --built-at 2026-11-17
 *   node packages/shared/scripts/build-cities.mjs --check
 *
 * `--fetch` скачивает дамп во временный каталог (в репозиторий он не попадает),
 * `--check` сверяет закоммиченный файл с результатом сборки — этим проверяется,
 * что справочник не правили руками.
 *
 * Сеть при старте API не нужна: файл `cities.data.ts` лежит в репозитории.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const DATA_FILE = join(PACKAGE_ROOT, 'src/geo/cities.data.ts');
const META_FILE = join(PACKAGE_ROOT, 'src/geo/cities.meta.ts');

/** Дамп можно взять с официального сайта или из зеркала — данные одни и те же. */
const CITIES_MIRROR =
  'https://codeload.github.com/nabilashraf/cities1000/tar.gz/refs/heads/master';
const ADMIN1_MIRROR =
  'https://codeload.github.com/unforgivenvirtuoso/geonames_admin1_to_name/tar.gz/refs/heads/main';

/** РФ и СНГ: для них порог населения ниже, чем для остального мира. */
const CIS_COUNTRIES = new Set([
  'RU', 'BY', 'KZ', 'UA', 'UZ', 'KG', 'TJ', 'TM', 'AZ', 'AM', 'MD', 'GE',
]);

/**
 * Порог отбора. Владелец продукта: города РФ и СНГ с населением **больше
 * 15 000**, отсечение именно по населению, а не «первые N» — иначе из списка
 * выпадают целые регионы.
 */
const CIS_MIN_POPULATION = 15_000;
/** Остальной мир: столицы (PPLC) и города-миллионники. */
const WORLD_MIN_POPULATION = 300_000;
/** Минимум мировых городов: столицы, которые не дотянули до миллиона. */
const WORLD_MIN_COUNT = 100;

/**
 * Только настоящие города. `PPLX` — районы и микрорайоны (в дампе есть
 * «Зюзино» с населением 121 000), `PPLQ`/`PPLW` — заброшенные и разрушенные,
 * `PPLH`/`PPLCH` — исторические: им не место в подсказке места рождения.
 */
const EXCLUDED_FEATURE_CODES = new Set(['PPLX', 'PPLQ', 'PPLW', 'PPLH', 'PPLCH']);

/**
 * Кириллические буквы, которых нет в русском алфавите: по ним отсеивается
 * сербское/украинское/белорусское написание («Андора ла Веља», «Київ»).
 */
const NON_RUSSIAN_CYRILLIC = /[іїєўђћљњџѓќѕј]/iu;
/** Буквы тюркских и монгольских алфавитов: «Елец балһсн» — не русское имя. */
const NON_RUSSIAN_EXTRA = /[әҗңөүһҫғқұӑӗӳ]/iu;
const CYRILLIC = /[А-Яа-яЁё]/u;
const LATIN = /[A-Za-z]/u;

/**
 * Кириллица → латиница: по этому переводу выбирается русское написание.
 * GeoNames хранит английскую форму («Yelabuga»), и правильная русская —
 * та, что переводится в неё (а не «Алабуга», татарская форма того же города).
 */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Написанные руками названия и алиасы для городов, которые уже были в
 * стартовом справочнике. Дамп даёт латиницу и варианты на разных языках, а
 * человеку нужны привычные «СПб», «Питер», «Москва». Совпадение ищем по
 * расстоянию (тот же город) и стране, а не по строке: «Nizhniy Novgorod» и
 * «Нижний Новгород» строкой не совпадут.
 */
const NAME_OVERRIDES = [
  ['RU', 'Москва', 55.7558, 37.6173, ['Moscow', 'Мск']],
  ['RU', 'Санкт-Петербург', 59.9343, 30.3351, ['Saint Petersburg', 'Питер', 'СПб']],
  ['RU', 'Новосибирск', 55.0084, 82.9357, ['Novosibirsk']],
  ['RU', 'Екатеринбург', 56.8389, 60.6057, ['Yekaterinburg']],
  ['RU', 'Казань', 55.7963, 49.1088, ['Kazan']],
  ['RU', 'Нижний Новгород', 56.3269, 44.0059, ['Nizhny Novgorod']],
  ['RU', 'Челябинск', 55.1644, 61.4368, ['Chelyabinsk']],
  ['RU', 'Красноярск', 56.0153, 92.8932, ['Krasnoyarsk']],
  ['RU', 'Самара', 53.1959, 50.1002, ['Samara']],
  ['RU', 'Уфа', 54.7388, 55.9721, ['Ufa']],
  ['RU', 'Ростов-на-Дону', 47.2357, 39.7015, ['Rostov-on-Don', 'Ростов']],
  ['RU', 'Омск', 54.9885, 73.3242, ['Omsk']],
  ['RU', 'Краснодар', 45.0355, 38.9753, ['Krasnodar']],
  ['RU', 'Воронеж', 51.672, 39.1843, ['Voronezh']],
  ['RU', 'Пермь', 58.0105, 56.2502, ['Perm']],
  ['RU', 'Волгоград', 48.708, 44.5133, ['Volgograd']],
  ['RU', 'Саратов', 51.5336, 46.0343, ['Saratov']],
  ['RU', 'Тюмень', 57.1522, 65.5272, ['Tyumen']],
  ['RU', 'Тольятти', 53.508, 49.4204, ['Tolyatti']],
  ['RU', 'Ижевск', 56.8527, 53.2115, ['Izhevsk']],
  ['RU', 'Барнаул', 53.3548, 83.7698, ['Barnaul']],
  ['RU', 'Ульяновск', 54.3142, 48.4031, ['Ulyanovsk']],
  ['RU', 'Иркутск', 52.287, 104.305, ['Irkutsk']],
  ['RU', 'Хабаровск', 48.4827, 135.0838, ['Khabarovsk']],
  ['RU', 'Ярославль', 57.6261, 39.8845, ['Yaroslavl']],
  ['RU', 'Владивосток', 43.1155, 131.8855, ['Vladivostok']],
  ['RU', 'Махачкала', 42.9764, 47.5024, ['Makhachkala']],
  ['RU', 'Томск', 56.4977, 84.9744, ['Tomsk']],
  ['RU', 'Оренбург', 51.7682, 55.0969, ['Orenburg']],
  ['RU', 'Кемерово', 55.3547, 86.0873, ['Kemerovo']],
  ['RU', 'Новокузнецк', 53.7557, 87.1099, ['Novokuznetsk']],
  ['RU', 'Рязань', 54.6269, 39.6916, ['Ryazan']],
  ['RU', 'Астрахань', 46.3497, 48.0408, ['Astrakhan']],
  ['RU', 'Набережные Челны', 55.7436, 52.3958, ['Naberezhnye Chelny']],
  ['RU', 'Пенза', 53.2007, 45.0046, ['Penza']],
  ['RU', 'Липецк', 52.6031, 39.5708, ['Lipetsk']],
  ['RU', 'Киров', 58.6035, 49.668, ['Kirov']],
  ['RU', 'Тула', 54.1961, 37.6182, ['Tula']],
  ['RU', 'Чебоксары', 56.1439, 47.2489, ['Cheboksary']],
  ['RU', 'Калининград', 54.7104, 20.4522, ['Kaliningrad']],
  ['RU', 'Брянск', 53.2434, 34.3639, ['Bryansk']],
  ['RU', 'Курск', 51.7304, 36.1926, ['Kursk']],
  ['RU', 'Иваново', 57.0004, 40.9739, ['Ivanovo']],
  ['RU', 'Магнитогорск', 53.4186, 59.0472, ['Magnitogorsk']],
  ['RU', 'Тверь', 56.8587, 35.9006, ['Tver']],
  ['RU', 'Ставрополь', 45.0428, 41.9734, ['Stavropol']],
  ['RU', 'Белгород', 50.5977, 36.5858, ['Belgorod']],
  ['RU', 'Сочи', 43.5855, 39.7231, ['Sochi']],
  ['RU', 'Архангельск', 64.5393, 40.5182, ['Arkhangelsk']],
  ['RU', 'Владимир', 56.129, 40.407, ['Vladimir']],
  ['RU', 'Смоленск', 54.7818, 32.0401, ['Smolensk']],
  ['RU', 'Курган', 55.4408, 65.3411, ['Kurgan']],
  ['RU', 'Орёл', 52.9651, 36.0785, ['Orel', 'Орел']],
  ['RU', 'Череповец', 59.1269, 37.9093, ['Cherepovets']],
  ['RU', 'Вологда', 59.2205, 39.8915, ['Vologda']],
  ['RU', 'Мурманск', 68.9585, 33.0827, ['Murmansk']],
  ['RU', 'Псков', 57.8194, 28.3318, ['Pskov']],
  ['RU', 'Великий Новгород', 58.5213, 31.2755, ['Novgorod']],
  ['RU', 'Петрозаводск', 61.7849, 34.3469, ['Petrozavodsk']],
  ['RU', 'Сургут', 61.254, 73.3962, ['Surgut']],
  ['RU', 'Норильск', 69.3535, 88.2027, ['Norilsk']],
  ['RU', 'Якутск', 62.0355, 129.6755, ['Yakutsk']],
  ['RU', 'Южно-Сахалинск', 46.9591, 142.738, ['Yuzhno-Sakhalinsk']],
  ['RU', 'Петропавловск-Камчатский', 53.037, 158.6559, ['Petropavlovsk-Kamchatsky']],
  ['RU', 'Улан-Удэ', 51.8335, 107.5841, ['Ulan-Ude']],
  ['RU', 'Абакан', 53.7156, 91.4292, ['Abakan']],
  ['RU', 'Кызыл', 51.7191, 94.4378, ['Kyzyl']],
  ['RU', 'Горно-Алтайск', 51.9581, 85.9603, ['Gorno-Altaysk']],
  ['RU', 'Магадан', 59.5638, 150.8035, ['Magadan']],
  ['RU', 'Анадырь', 64.7314, 177.5015, ['Anadyr']],
  ['RU', 'Салехард', 66.5299, 66.6136, ['Salekhard']],
  ['RU', 'Ханты-Мансийск', 61.0042, 69.0019, ['Khanty-Mansiysk']],
  ['RU', 'Нарьян-Мар', 67.638, 53.0069, ['Naryan-Mar']],
  ['RU', 'Сыктывкар', 61.6688, 50.8364, ['Syktyvkar']],
  ['RU', 'Йошкар-Ола', 56.6388, 47.8908, ['Yoshkar-Ola']],
  ['RU', 'Саранск', 54.1838, 45.1749, ['Saransk']],
  ['RU', 'Черкесск', 44.2269, 42.0465, ['Cherkessk']],
  ['RU', 'Нальчик', 43.4981, 43.6189, ['Nalchik']],
  ['RU', 'Владикавказ', 43.0367, 44.6678, ['Vladikavkaz']],
  ['RU', 'Магас', 43.1687, 44.8133, ['Magas']],
  ['RU', 'Грозный', 43.3179, 45.6949, ['Grozny']],
  ['RU', 'Майкоп', 44.6098, 40.1006, ['Maykop']],
  ['RU', 'Элиста', 46.3078, 44.2558, ['Elista']],
  ['RU', 'Биробиджан', 48.7928, 132.9239, ['Birobidzhan']],
  ['RU', 'Благовещенск', 50.2907, 127.5272, ['Blagoveshchensk']],
  ['RU', 'Комсомольск-на-Амуре', 50.5503, 137.0079, ['Komsomolsk-on-Amur']],
  ['RU', 'Чита', 52.034, 113.4994, ['Chita']],
  ['RU', 'Братск', 56.1325, 101.6146, ['Bratsk']],
  ['RU', 'Ангарск', 52.5406, 103.8886, ['Angarsk']],
  ['RU', 'Прокопьевск', 53.9059, 86.7194, ['Prokopyevsk']],
  ['RU', 'Рыбинск', 58.0446, 38.8422, ['Rybinsk']],
  ['RU', 'Балашиха', 55.7969, 37.9385, ['Balashika', 'Balashikha']],
  ['RU', 'Химки', 55.8892, 37.445, ['Khimki']],
  ['RU', 'Подольск', 55.4312, 37.5457, ['Podolsk']],
  ['RU', 'Королёв', 55.9142, 37.8255, ['Korolev']],
  ['RU', 'Мытищи', 55.9106, 37.7364, ['Mytishchi']],
  ['RU', 'Люберцы', 55.6758, 37.8931, ['Lyubertsy']],
  ['RU', 'Красногорск', 55.8317, 37.3302, ['Krasnogorsk']],
  ['RU', 'Одинцово', 55.6789, 37.2639, ['Odintsovo']],
  ['RU', 'Домодедово', 55.4408, 37.7518, ['Domodedovo']],
  ['RU', 'Щёлково', 55.9209, 37.9976, ['Shchelkovo']],
  ['RU', 'Пушкино', 56.0106, 37.8474, ['Pushkino']],
  ['RU', 'Раменское', 55.5669, 38.2302, ['Ramenskoye']],
  ['RU', 'Серпухов', 54.9146, 37.4117, ['Serpukhov']],
  ['RU', 'Ногинск', 55.8544, 38.4447, ['Noginsk']],
  ['RU', 'Коломна', 55.0794, 38.7783, ['Kolomna']],
  ['RU', 'Жуковский', 55.5952, 38.1201, ['Zhukovsky']],
  ['RU', 'Обнинск', 55.0968, 36.6103, ['Obninsk']],
  ['RU', 'Калуга', 54.5138, 36.2612, ['Kaluga']],
  ['RU', 'Кострома', 57.7665, 40.9269, ['Kostroma']],
  ['RU', 'Старый Оскол', 51.2967, 37.8353, ['Stary Oskol']],
  ['RU', 'Новочеркасск', 47.4222, 40.0937, ['Novocherkassk']],
  ['RU', 'Таганрог', 47.2362, 38.8969, ['Taganrog']],
  ['RU', 'Шахты', 47.7085, 40.2158, ['Shakhty']],
  ['RU', 'Волжский', 48.7861, 44.7797, ['Volzhsky']],
  ['RU', 'Армавир', 44.9892, 41.1234, ['Armavir']],
  ['RU', 'Дзержинск', 56.2377, 43.4595, ['Dzerzhinsk']],
  ['RU', 'Орск', 51.229, 58.4752, ['Orsk']],
  ['RU', 'Стерлитамак', 53.6303, 55.931, ['Sterlitamak']],
  ['RU', 'Салават', 53.3617, 55.9245, ['Salavat']],
  ['RU', 'Нефтекамск', 56.0885, 54.2483, ['Neftekamsk']],
  ['RU', 'Альметьевск', 54.9014, 52.2971, ['Almetyevsk']],
  ['RU', 'Нижнекамск', 55.6366, 51.8206, ['Nizhnekamsk']],
  ['RU', 'Златоуст', 55.1711, 59.65, ['Zlatoust']],
  ['RU', 'Миасс', 55.0455, 60.1083, ['Miass']],
  ['RU', 'Копейск', 55.1163, 61.6194, ['Kopeysk']],
  ['RU', 'Каменск-Уральский', 56.4149, 61.9186, ['Kamensk-Uralsky']],
  ['RU', 'Первоуральск', 56.9081, 59.9423, ['Pervouralsk']],
  ['RU', 'Новый Уренгой', 66.0838, 76.6805, ['Novy Urengoy']],
  ['RU', 'Ноябрьск', 63.1994, 75.4507, ['Noyabrsk']],
  ['RU', 'Нижневартовск', 60.9344, 76.5531, ['Nizhnevartovsk']],
  ['RU', 'Бийск', 52.5393, 85.2072, ['Biysk']],
  ['RU', 'Северодвинск', 64.5635, 39.8302, ['Severodvinsk']],
  ['RU', 'Муром', 55.5745, 42.0522, ['Murom']],
  ['RU', 'Гатчина', 59.5764, 30.1282, ['Gatchina']],
  ['RU', 'Выборг', 60.7076, 28.7527, ['Vyborg']],
  ['RU', 'Всеволожск', 60.0203, 30.6375, ['Vsevolozhsk']],
  ['BY', 'Минск', 53.9006, 27.559, ['Minsk']],
  ['BY', 'Гомель', 52.4345, 30.9754, ['Gomel']],
  ['BY', 'Могилёв', 53.9007, 30.3319, ['Mogilev', 'Могилев']],
  ['BY', 'Витебск', 55.1904, 30.2049, ['Vitebsk']],
  ['BY', 'Гродно', 53.6667, 23.8144, ['Grodno']],
  ['BY', 'Брест', 52.0976, 23.7341, ['Brest']],
  ['BY', 'Бобруйск', 53.1384, 29.2214, ['Bobruisk']],
  ['KZ', 'Алматы', 43.2389, 76.8897, ['Almaty', 'Алма-Ата']],
  ['KZ', 'Астана', 51.1694, 71.4491, ['Astana', 'Нур-Султан', 'Целиноград']],
  ['KZ', 'Шымкент', 42.3, 69.6, ['Shymkent', 'Чимкент']],
  ['KZ', 'Караганда', 49.8047, 73.1094, ['Karaganda']],
  ['KZ', 'Актобе', 50.2839, 57.167, ['Aktobe', 'Актюбинск']],
  ['KZ', 'Тараз', 42.9, 71.3667, ['Taraz', 'Джамбул']],
  ['KZ', 'Павлодар', 52.2873, 76.9674, ['Pavlodar']],
  ['KZ', 'Усть-Каменогорск', 49.9483, 82.6286, ['Ust-Kamenogorsk']],
  ['KZ', 'Семей', 50.4111, 80.2275, ['Semey', 'Семипалатинск']],
  ['KZ', 'Атырау', 47.0945, 51.9238, ['Atyrau', 'Гурьев']],
  ['KZ', 'Костанай', 53.2144, 63.6246, ['Kostanay', 'Кустанай']],
  ['KZ', 'Кызылорда', 44.8488, 65.4823, ['Kyzylorda', 'Кзыл-Орда']],
  ['KZ', 'Уральск', 51.2333, 51.3667, ['Oral', 'Uralsk']],
  ['KZ', 'Петропавловск', 54.8753, 69.1628, ['Petropavl']],
  ['KZ', 'Актау', 43.65, 51.1667, ['Aktau', 'Шевченко']],
  ['KZ', 'Темиртау', 50.054, 72.9646, ['Temirtau']],
  ['KZ', 'Туркестан', 43.2973, 68.2517, ['Turkestan']],
  ['KZ', 'Кокшетау', 53.2833, 69.4, ['Kokshetau', 'Кокчетав']],
  ['KZ', 'Талдыкорган', 45.0156, 78.3739, ['Taldykorgan']],
  ['KZ', 'Экибастуз', 51.7298, 75.3266, ['Ekibastuz']],
  ['UA', 'Киев', 50.4547, 30.5238, ['Kyiv', 'Київ']],
  ['UA', 'Харьков', 49.9808, 36.2527, ['Kharkiv', 'Харків']],
  ['UA', 'Одесса', 46.4775, 30.7326, ['Odesa', 'Одеса']],
  ['UA', 'Днепр', 48.4647, 35.0462, ['Dnipro', 'Днепропетровск']],
  ['UA', 'Донецк', 48.0159, 37.8029, ['Donetsk']],
  ['UA', 'Запорожье', 47.8388, 35.1396, ['Zaporizhzhia']],
  ['UA', 'Львов', 49.8397, 24.0297, ['Lviv', 'Львів']],
  ['UA', 'Кривой Рог', 47.9105, 33.3918, ['Kryvyi Rih']],
  ['UA', 'Николаев', 46.975, 31.9946, ['Mykolaiv']],
  ['UA', 'Мариуполь', 47.0951, 37.5413, ['Mariupol']],
  ['UA', 'Луганск', 48.574, 39.3078, ['Luhansk']],
  ['UA', 'Винница', 49.2331, 28.4682, ['Vinnytsia']],
  ['UA', 'Херсон', 46.6354, 32.6169, ['Kherson']],
  ['UA', 'Полтава', 49.5883, 34.5514, ['Poltava']],
  ['UA', 'Чернигов', 51.4982, 31.2893, ['Chernihiv']],
  ['UA', 'Черкассы', 49.4444, 32.0598, ['Cherkasy']],
  ['UA', 'Житомир', 50.2547, 28.6587, ['Zhytomyr']],
  ['UA', 'Сумы', 50.9077, 34.7981, ['Sumy']],
  ['UA', 'Хмельницкий', 49.4229, 26.9871, ['Khmelnytskyi']],
  ['UA', 'Черновцы', 48.2921, 25.9358, ['Chernivtsi']],
  ['UA', 'Ровно', 50.6199, 26.2516, ['Rivne']],
  ['UA', 'Ивано-Франковск', 48.9226, 24.7103, ['Ivano-Frankivsk']],
  ['UA', 'Тернополь', 49.5535, 25.5948, ['Ternopil']],
  ['UA', 'Кропивницкий', 48.5079, 32.2623, ['Kropyvnytskyi', 'Кировоград']],
  ['UA', 'Ужгород', 48.6208, 22.2879, ['Uzhhorod']],
  ['MD', 'Кишинёв', 47.0105, 28.8638, ['Chisinau', 'Кишинев']],
  ['MD', 'Тирасполь', 46.8403, 29.6433, ['Tiraspol']],
  ['MD', 'Бельцы', 47.7615, 27.9289, ['Balti', 'Бэлць']],
  ['UZ', 'Ташкент', 41.2646, 69.2163, ['Tashkent']],
  ['UZ', 'Самарканд', 39.6542, 66.9597, ['Samarkand']],
  ['UZ', 'Бухара', 39.7747, 64.4286, ['Bukhara']],
  ['UZ', 'Наманган', 40.9983, 71.6726, ['Namangan']],
  ['UZ', 'Андижан', 40.7833, 72.35, ['Andijan']],
  ['KG', 'Бишкек', 42.8746, 74.5698, ['Bishkek', 'Фрунзе']],
  ['KG', 'Ош', 40.5283, 72.7985, ['Osh']],
  ['TJ', 'Душанбе', 38.5358, 68.7791, ['Dushanbe']],
  ['TJ', 'Худжанд', 40.2826, 69.6222, ['Khujand']],
  ['TM', 'Ашхабад', 37.95, 58.3833, ['Ashgabat', 'Ашгабат']],
  ['AZ', 'Баку', 40.3777, 49.892, ['Baku']],
  ['AZ', 'Гянджа', 40.6828, 46.3606, ['Ganja', 'Кировабад']],
  ['AM', 'Ереван', 40.1772, 44.5035, ['Yerevan']],
  ['AM', 'Гюмри', 40.7942, 43.8453, ['Gyumri', 'Ленинакан']],
  ['GE', 'Тбилиси', 41.6941, 44.8337, ['Tbilisi', 'Тифлис']],
  ['GE', 'Батуми', 41.6438, 41.6395, ['Batumi']],
  ['GE', 'Кутаиси', 42.2679, 42.6946, ['Kutaisi']],
  ['GB', 'Лондон', 51.5074, -0.1278, ['London']],
  ['FR', 'Париж', 48.8566, 2.3522, ['Paris']],
  ['DE', 'Берлин', 52.52, 13.405, ['Berlin']],
  ['ES', 'Мадрид', 40.4168, -3.7038, ['Madrid']],
  ['IT', 'Рим', 41.9028, 12.4964, ['Rome', 'Roma']],
  ['PT', 'Лиссабон', 38.7223, -9.1393, ['Lisbon']],
  ['NL', 'Амстердам', 52.3676, 4.9041, ['Amsterdam']],
  ['AT', 'Вена', 48.2082, 16.3738, ['Vienna', 'Wien']],
  ['CZ', 'Прага', 50.0755, 14.4378, ['Prague', 'Praha']],
  ['PL', 'Варшава', 52.2297, 21.0122, ['Warsaw', 'Warszawa']],
  ['HU', 'Будапешт', 47.4979, 19.0402, ['Budapest']],
  ['GR', 'Афины', 37.9838, 23.7275, ['Athens']],
  ['SE', 'Стокгольм', 59.3293, 18.0686, ['Stockholm']],
  ['NO', 'Осло', 59.9139, 10.7522, ['Oslo']],
  ['FI', 'Хельсинки', 60.1699, 24.9384, ['Helsinki']],
  ['DK', 'Копенгаген', 55.6761, 12.5683, ['Copenhagen']],
  ['IE', 'Дублин', 53.3498, -6.2603, ['Dublin']],
  ['BE', 'Брюссель', 50.8503, 4.3517, ['Brussels', 'Bruxelles']],
  ['CH', 'Цюрих', 47.3769, 8.5417, ['Zurich', 'Zürich']],
  ['RS', 'Белград', 44.7866, 20.4489, ['Belgrade']],
  ['BG', 'София', 42.6977, 23.3219, ['Sofia']],
  ['RO', 'Бухарест', 44.4268, 26.1025, ['Bucharest']],
  ['TR', 'Анкара', 39.9334, 32.8597, ['Ankara']],
  ['TR', 'Стамбул', 41.0082, 28.9784, ['Istanbul']],
  ['IL', 'Тель-Авив', 32.0853, 34.7818, ['Tel Aviv']],
  ['EG', 'Каир', 30.0444, 31.2357, ['Cairo']],
  ['AE', 'Дубай', 25.2048, 55.2708, ['Dubai', 'Дубаи']],
  ['SA', 'Эр-Рияд', 24.7136, 46.6753, ['Riyadh']],
  ['IR', 'Тегеран', 35.6892, 51.389, ['Tehran']],
  ['IN', 'Нью-Дели', 28.6139, 77.209, ['New Delhi', 'Дели', 'Delhi']],
  ['CN', 'Пекин', 39.9042, 116.4074, ['Beijing']],
  ['CN', 'Шанхай', 31.2304, 121.4737, ['Shanghai']],
  ['JP', 'Токио', 35.6762, 139.6503, ['Tokyo']],
  ['KR', 'Сеул', 37.5665, 126.978, ['Seoul']],
  ['SG', 'Сингапур', 1.3521, 103.8198, ['Singapore']],
  ['TH', 'Бангкок', 13.7563, 100.5018, ['Bangkok']],
  ['VN', 'Ханой', 21.0278, 105.8342, ['Hanoi']],
  ['ID', 'Джакарта', -6.2088, 106.8456, ['Jakarta']],
  ['PH', 'Манила', 14.5995, 120.9842, ['Manila']],
  ['AU', 'Сидней', -33.8688, 151.2093, ['Sydney']],
  ['AU', 'Мельбурн', -37.8136, 144.9631, ['Melbourne']],
  ['NZ', 'Окленд', -36.8485, 174.7633, ['Auckland']],
  ['US', 'Вашингтон', 38.9072, -77.0369, ['Washington']],
  ['US', 'Нью-Йорк', 40.7128, -74.006, ['New York', 'NYC']],
  ['US', 'Чикаго', 41.8781, -87.6298, ['Chicago']],
  ['US', 'Лос-Анджелес', 34.0522, -118.2437, ['Los Angeles']],
  ['US', 'Сан-Франциско', 37.7749, -122.4194, ['San Francisco']],
  ['CA', 'Торонто', 43.6532, -79.3832, ['Toronto']],
  ['CA', 'Ванкувер', 49.2827, -123.1207, ['Vancouver']],
  ['MX', 'Мехико', 19.4326, -99.1332, ['Mexico City']],
  ['BR', 'Сан-Паулу', -23.5505, -46.6333, ['Sao Paulo']],
  ['AR', 'Буэнос-Айрес', -34.6037, -58.3816, ['Buenos Aires']],
  ['CL', 'Сантьяго', -33.4489, -70.6693, ['Santiago']],
  ['PE', 'Лима', -12.0464, -77.0428, ['Lima']],
  ['CO', 'Богота', 4.711, -74.0721, ['Bogota']],
  ['KE', 'Найроби', -1.2921, 36.8219, ['Nairobi']],
  ['NG', 'Лагос', 6.5244, 3.3792, ['Lagos']],
  ['ZA', 'Йоханнесбург', -26.2041, 28.0473, ['Johannesburg']],
  ['MA', 'Касабланка', 33.5731, -7.5898, ['Casablanca']],
  ['TN', 'Тунис', 36.8065, 10.1815, ['Tunis']],
  ['DZ', 'Алжир', 36.7538, 3.0588, ['Algiers']],
  ['ET', 'Аддис-Абеба', 9.032, 38.7469, ['Addis Ababa']],
];

/** Расстояние по haversine, км — то же, что в API при подборе пояса. */
function distanceKm(latA, lonA, latB, lonB) {
  const R = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gu, ' ')
    .trim();
}

/** Варианты названия из колонки `alternatenames`, только кириллица. */
function cyrillicAlternates(alternatenames) {
  return alternatenames
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '' && CYRILLIC.test(name) && !LATIN.test(name));
}

/**
 * Русское написание из вариантов GeoNames.
 *
 * В дампе лежат варианты на всех языках: для Парижа это и «Париж», и «Париж»
 * по-болгарски. Отсекаем буквы, которых в русском нет, и предпочитаем вариант
 * с ы/э/ё — они есть только в русском.
 */
function translit(value) {
  return [...value.toLowerCase()]
    .map((character) => TRANSLIT[character] ?? character)
    .join('');
}

/**
 * Английская форма без «й»-приставки: GeoNames пишет «Yelabuga», «Yekaterinburg»,
 * а русская буква там одна — «Е». Без этой нормализации «Елабуга» проигрывает
 * татарской «Алабуге».
 */
function latinKey(value) {
  const lower = value.toLowerCase().replace(/[^a-z]/gu, '');
  return lower.replace(/^y(?=[eau])/iu, '');
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function russianName(alternates, latinName) {
  const russian = alternates.filter(
    (name) => !NON_RUSSIAN_CYRILLIC.test(name) && !NON_RUSSIAN_EXTRA.test(name),
  );
  if (russian.length === 0) {
    return null;
  }
  const wanted = latinKey(latinName);
  // Ближе всего к английской форме → короче → стабильно по алфавиту.
  return [...russian].sort((a, b) => {
    const distanceA = editDistance(latinKey(translit(a)), wanted);
    const distanceB = editDistance(latinKey(translit(b)), wanted);
    if (distanceA !== distanceB) return distanceA - distanceB;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b, 'ru');
  })[0];
}

function parseArgs(argv) {
  const options = { check: false, fetch: false, cities: null, admin1: null, builtAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--fetch') options.fetch = true;
    else if (arg === '--cities') options.cities = argv[++index];
    else if (arg === '--admin1') options.admin1 = argv[++index];
    else if (arg === '--built-at') options.builtAt = argv[++index];
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return options;
}

/** Скачивает дампы во временный каталог: в репозиторий они не попадают. */
function fetchSources() {
  const dir = mkdtempSync(join(tmpdir(), 'geo-dump-'));
  const fetchTarball = (url, name) => {
    const tarball = join(dir, `${name}.tgz`);
    execFileSync('curl', ['-sSL', url, '-o', tarball], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: 'inherit' });
  };
  fetchTarball(CITIES_MIRROR, 'cities');
  fetchTarball(ADMIN1_MIRROR, 'admin1');

  const list = execFileSync('find', [dir, '-name', 'cities1000.txt'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const admin1 = execFileSync('find', [dir, '-name', 'admin1.json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  if (list[0] === undefined || admin1[0] === undefined) {
    throw new Error('Не нашли cities1000.txt или admin1.json в скачанном архиве');
  }

  return { cities: list[0], admin1: admin1[0], dir };
}

function readDump(path) {
  const text = readFileSync(path, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const columns = line.replace(/\r$/, '').split('\t');
    // Формат GeoNames (19 колонок): geonameid, name, asciiname, alternatenames,
    // lat, lon, feature class, feature code, country, cc2, admin1…admin4,
    // population, elevation, dem, timezone, modification date.
    if (columns.length < 19) continue;
    rows.push({
      name: columns[1],
      asciiName: columns[2],
      alternatenames: columns[3],
      lat: Number(columns[4]),
      lon: Number(columns[5]),
      featureCode: columns[7],
      country: columns[8],
      admin1: columns[10],
      population: Number(columns[14] || 0),
      timezone: columns[17],
    });
  }
  return rows;
}

function validTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function selectCities(rows, admin1) {
  const overrides = NAME_OVERRIDES.map(([country, name, lat, lon, aliases]) => ({
    country,
    name,
    lat,
    lon,
    aliases,
  }));

  const selected = [];
  const skipped = { noTimezone: 0, noCoords: 0, district: 0 };

  for (const row of rows) {
    if (EXCLUDED_FEATURE_CODES.has(row.featureCode)) {
      skipped.district += 1;
      continue;
    }
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) {
      skipped.noCoords += 1;
      continue;
    }

    const cis = CIS_COUNTRIES.has(row.country);
    const isCapital = row.featureCode === 'PPLC';
    // РФ и СНГ — только по населению (решение владельца): региональные
    // столицы ниже порога в справочник не попадают. Остальной мир —
    // население или столица: у маленьких стран столица и есть главный город.
    const populationOk = cis
      ? row.population > CIS_MIN_POPULATION
      : isCapital || row.population > WORLD_MIN_POPULATION;
    if (!populationOk) continue;

    // Записи без пояса в справочник не попадают (`geo.md`).
    if (!validTimeZone(row.timezone)) {
      skipped.noTimezone += 1;
      continue;
    }

    const alternates = cyrillicAlternates(row.alternatenames).filter(
      (name) => !NON_RUSSIAN_CYRILLIC.test(name) && !NON_RUSSIAN_EXTRA.test(name),
    );

    selected.push({
      name: russianName(alternates, row.name) ?? row.name,
      dumpName: row.name,
      asciiName: row.asciiName,
      alternates,
      country: row.country,
      region: admin1[`${row.country}.${row.admin1}`] ?? null,
      lat: Number(row.lat.toFixed(4)),
      lon: Number(row.lon.toFixed(4)),
      tz: row.timezone,
      population: row.population,
      capital: isCapital,
    });
  }

  // Ручные названия применяем после отбора и по ближайшему городу, а не по
  // первому попавшемуся: рядом с Королёвом есть Юбилейный, и «первый в
  // пределах 20 км» съедал бы чужое имя.
  const usedOverrides = new Set();
  for (const override of overrides) {
    let best = null;
    for (const city of selected) {
      if (city.country !== override.country || usedOverrides.has(city)) {
        continue;
      }
      const distance = distanceKm(override.lat, override.lon, city.lat, city.lon);
      if (distance <= 20 && (best === null || distance < best.distance)) {
        best = { city, distance };
      }
    }
    if (best !== null) {
      usedOverrides.add(best.city);
      best.city.override = override;
    }
  }

  for (const city of selected) {
    if (city.override !== undefined) {
      city.name = city.override.name;
    }
    const aliases = [];
    if (city.override !== undefined) {
      aliases.push(...city.override.aliases);
    }
    for (const candidate of [city.dumpName, city.asciiName, ...city.alternates]) {
      if (candidate !== '' && candidate !== city.name) aliases.push(candidate);
    }
    // Алиасы нужны для поиска латиницей и старых названий («Горький»,
    // «Кировоград»), но каждый стоит байтов: три — предел.
    city.aliases = [...new Set(aliases)]
      .filter((alias) => normalize(alias) !== normalize(city.name))
      .slice(0, 3);
  }

  // Дедупликация: один город мог прийти дважды (разные записи GeoNames) или
  // совпасть с уже названным вручную.
  const byKey = new Map();
  for (const city of selected) {
    // Регион входит в ключ: «Сосновка» в Кировской и в Тамбовской областях —
    // разные города, и человеку нужен его.
    const key = `${city.country}|${normalize(city.name)}|${city.region ?? ''}`;
    const existing = byKey.get(key);
    if (existing === undefined || (city.population ?? 0) > (existing.population ?? 0)) {
      byKey.set(key, city);
    }
  }

  // Один город мог прийти двумя записями с разным написанием («Санкт-Петербург»
  // и «Санкт Петербург»). Считаем их одним, только если они рядом: «Киров» в
  // Кировской и в Калужской области — разные города, и оба нужны.
  const merged = [];
  for (const city of byKey.values()) {
    const twin = merged.find(
      (other) =>
        other.country === city.country &&
        normalize(other.name) === normalize(city.name) &&
        distanceKm(other.lat, other.lon, city.lat, city.lon) <= 50,
    );
    if (twin === undefined) {
      merged.push(city);
      continue;
    }
    if ((city.population ?? 0) > (twin.population ?? 0)) {
      Object.assign(twin, city);
    }
  }

  return {
    cities: merged,
    skipped,
    unusedOverrides: overrides
      .filter((item) => !selected.some((city) => city.override === item))
      .map((item) => item.name),
  };
}

function assertSelection(cities) {
  if (cities.length < 900) {
    throw new Error(`Слишком мало городов (${cities.length}): проверь дамп и пороги`);
  }
  const world = cities.filter((city) => !CIS_COUNTRIES.has(city.country));
  if (world.length < WORLD_MIN_COUNT) {
    throw new Error(`Мировых городов меньше ${WORLD_MIN_COUNT}: ${world.length}`);
  }
  const withoutTz = cities.filter((city) => !validTimeZone(city.tz));
  if (withoutTz.length > 0) {
    throw new Error(`Города без IANA-пояса: ${withoutTz.slice(0, 5).map((c) => c.name).join(', ')}`);
  }
  const belowThreshold = cities.filter((city) => {
    const cis = CIS_COUNTRIES.has(city.country);
    if (cis) return city.population <= CIS_MIN_POPULATION;
    return !city.capital && city.population <= WORLD_MIN_POPULATION;
  });
  if (belowThreshold.length > 0) {
    throw new Error(
      `Города ниже порога: ${belowThreshold.slice(0, 5).map((c) => c.name).join(', ')}`,
    );
  }
  const withoutRegion = cities.filter((city) => city.region === null);
  if (withoutRegion.length > 0) {
    process.stdout.write(
      `  предупреждение: без региона ${withoutRegion.length} (${withoutRegion
        .slice(0, 3)
        .map((c) => c.name)
        .join(', ')})\n`,
    );
  }
}

const ATTRIBUTION =
  'Содержит данные GeoNames (https://www.geonames.org), лицензия CC BY 4.0.';

function render(cities, meta) {
  const lines = [];
  lines.push('/**');
  lines.push(' * Справочник городов (`geo.md`, «Состав справочника»).');
  lines.push(' *');
  lines.push(' * ФАЙЛ СГЕНЕРИРОВАН: `node packages/shared/scripts/build-cities.mjs`.');
  lines.push(' * Руками не правится — правки потеряются при следующей сборке.');
  lines.push(' *');
  lines.push(` * Источник: ${meta.source}, ${meta.sourceVersion}.`);
  lines.push(` * ${ATTRIBUTION}`);
  lines.push(' *');
  lines.push(' * Отбор: города РФ и СНГ с населением больше 15 000, остальной мир —');
  lines.push(' * столицы и города-миллионники. Отсечение по населению, а не «первые N»:');
  lines.push(' * иначе из подсказок выпадают целые регионы.');
  lines.push(' *');
  lines.push(' * Координаты — центр города из дампа (точность ~0.0001°). Часовой пояс');
  lines.push(' * (IANA) обязателен: без него нельзя перевести время рождения в UTC.');
  lines.push(' *');
  lines.push(' * ВАЖНО: ПДн в файле нет — это публичные географические данные.');
  lines.push(' */');
  lines.push('');
  lines.push('export interface CityRecord {');
  lines.push('  readonly name: string;');
  lines.push('  /** ISO-3166 alpha-2. */');
  lines.push('  readonly country: string;');
  lines.push('  readonly lat: number;');
  lines.push('  readonly lon: number;');
  lines.push('  /** IANA-пояс, обязателен: без него нельзя перевести локальное время в UTC. */');
  lines.push('  readonly tz: string;');
  lines.push('  readonly population?: number;');
  lines.push('  readonly region?: string;');
  lines.push('  /** Столица страны: такие города попадают в справочник и при малом населении. */');
  lines.push('  readonly capital?: boolean;');
  lines.push('  /** Варианты написания для поиска (латиница, сокращения). */');
  lines.push('  readonly aliases?: readonly string[];');
  lines.push('}');
  lines.push('');
  lines.push(`/** Версия датасета: меняется вместе с содержимым и попадает в \`GET /health\`-логи. */`);
  lines.push(`export const CITY_DATASET_VERSION = '${meta.datasetVersion}';`);
  lines.push('');
  lines.push('export const CITIES: readonly CityRecord[] = [');
  for (const city of cities) {
    const parts = [
      `name: ${JSON.stringify(city.name)}`,
      `country: ${JSON.stringify(city.country)}`,
      `region: ${JSON.stringify(city.region ?? '')}`,
      `lat: ${city.lat}`,
      `lon: ${city.lon}`,
      `tz: ${JSON.stringify(city.tz)}`,
      `population: ${city.population ?? 0}`,
    ];
    if (city.capital) {
      parts.push('capital: true');
    }
    if (city.aliases.length > 0) {
      parts.push(`aliases: ${JSON.stringify(city.aliases)}`);
    }
    lines.push(`  { ${parts.join(', ')} },`);
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function renderMeta(meta) {
  return [
    '/**',
    ' * Метаданные справочника городов (`geo.md`).',
    ' *',
    ' * ФАЙЛ СГЕНЕРИРОВАН: `node packages/shared/scripts/build-cities.mjs`.',
    ' *',
    ` * ${ATTRIBUTION}`,
    ' */',
    '',
    'export interface CityDatasetMeta {',
    '  readonly version: string;',
    '  readonly source: string;',
    '  readonly sourceVersion: string;',
    '  readonly license: string;',
    '  readonly attribution: string;',
    '  readonly builtAt: string;',
    '  readonly criteria: string;',
    '  readonly countries: number;',
    '  readonly count: number;',
    '}',
    '',
    'export const CITY_DATASET_META: CityDatasetMeta = {',
    `  version: ${JSON.stringify(meta.datasetVersion)},`,
    `  source: ${JSON.stringify(meta.source)},`,
    `  sourceVersion: ${JSON.stringify(meta.sourceVersion)},`,
    `  license: ${JSON.stringify(meta.license)},`,
    `  attribution: ${JSON.stringify(ATTRIBUTION)},`,
    `  builtAt: ${JSON.stringify(meta.builtAt)},`,
    `  criteria: ${JSON.stringify(meta.criteria)},`,
    `  countries: ${meta.countries},`,
    `  count: ${meta.count} ,`.replace(' ,', ','),
    '};',
    '',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let sources = { cities: options.cities, admin1: options.admin1, dir: null };

  if (options.fetch) {
    sources = { ...fetchSources(), ...sources };
  }

  if (sources.cities === null || sources.admin1 === null) {
    process.stdout.write(
      'Нет дампа GeoNames. Передай --cities <cities1000.txt> и --admin1 <admin1.json>,\n' +
        'либо запусти с --fetch (скачает зеркало дампа во временный каталог).\n',
    );
    // Проверка, которой нечего проверять, не может считаться успешной:
    // иначе «справочник совпадает» печатается при пустом каталоге дампа.
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Читаю ${sources.cities}\n`);
  const rows = readDump(sources.cities);
  const admin1 = JSON.parse(readFileSync(sources.admin1, 'utf8'));
  const { cities, skipped, unusedOverrides } = selectCities(rows, admin1);

  cities.sort((a, b) => (b.population ?? 0) - (a.population ?? 0) || a.name.localeCompare(b.name, 'ru'));
  assertSelection(cities);

  const builtAt = options.builtAt ?? '2026-11-17';
  const meta = {
    datasetVersion: `${builtAt}-geonames-cities1000`,
    source: 'GeoNames cities1000',
    sourceVersion: `cities1000, ${rows.length} записей в дампе`,
    license: 'CC BY 4.0',
    builtAt,
    criteria: 'РФ и СНГ: население > 15 000; остальной мир: столицы и население > 300 000',
    countries: new Set(cities.map((city) => city.country)).size,
    count: cities.length,
  };

  const rendered = render(cities, meta);
  const metaRendered = renderMeta(meta);

  process.stdout.write(
    `Отобрано ${cities.length} городов из ${rows.length} записей дампа.\n` +
      `  РФ: ${cities.filter((c) => c.country === 'RU').length}, ` +
      `СНГ: ${cities.filter((c) => c.country !== 'RU' && CIS_COUNTRIES.has(c.country)).length}, ` +
      `остальной мир: ${cities.filter((c) => !CIS_COUNTRIES.has(c.country)).length}\n` +
      `  стран: ${meta.countries}; пропущено без пояса: ${skipped.noTimezone}, ` +
      `районов/заброшенных: ${skipped.district}, без координат: ${skipped.noCoords}\n` +
      (unusedOverrides.length > 0
        ? `  ручных названий без пары в дампе: ${unusedOverrides.length} (${unusedOverrides.slice(0, 5).join(', ')})\n`
        : ''),
  );

  if (options.check) {
    const current = readFileSync(DATA_FILE, 'utf8');
    if (current !== rendered) {
      process.stdout.write(
        'Справочник расходится со сборкой: файл правили руками или дамп другой.\n' +
          'Пересобери: node packages/shared/scripts/build-cities.mjs --fetch\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Справочник совпадает со сборкой.\n');
    return;
  }

  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, rendered);
  writeFileSync(META_FILE, metaRendered);
  process.stdout.write(`Записал ${DATA_FILE} (${(rendered.length / 1024).toFixed(0)} КБ)\n`);
  process.stdout.write(`Записал ${META_FILE}\n`);

  if (sources.dir !== null) {
    rmSync(sources.dir, { recursive: true, force: true });
  }
}

main();
