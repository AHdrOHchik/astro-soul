"""Справочники движка: знаки, планеты, аспекты, стихии и кресты.

Всё на русском — так эти строки попадают в карту и в контекст для LLM.
Ключи планет — латиницей, они же идентификаторы в контракте.
"""

from __future__ import annotations

ENGINE_VERSION = "1.0.0"

#: Режим расчёта: fallback — встроенная эфемерида Moshier, swisseph — файлы .se1.
ENGINE_MODES = ("fallback", "swisseph")
DEFAULT_ENGINE_MODE = "fallback"

SIGNS: tuple[str, ...] = (
    "Овен",
    "Телец",
    "Близнецы",
    "Рак",
    "Лев",
    "Дева",
    "Весы",
    "Скорпион",
    "Стрелец",
    "Козерог",
    "Водолей",
    "Рыбы",
)

SIGN_GLYPHS: tuple[str, ...] = tuple("♈♉♊♋♌♍♎♏♐♑♒♓")

#: Ключ → (id в swisseph, имя для пользователя, глиф).
#: Порядок задаёт порядок в карте и в контексте — он же часть детерминизма.
PLANETS: tuple[tuple[str, int, str, str], ...] = (
    ("sun", "SUN", "Солнце", "☉"),
    ("moon", "MOON", "Луна", "☽"),
    ("mercury", "MERCURY", "Меркурий", "☿"),
    ("venus", "VENUS", "Венера", "♀"),
    ("mars", "MARS", "Марс", "♂"),
    ("jupiter", "JUPITER", "Юпитер", "♃"),
    ("saturn", "SATURN", "Сатурн", "♄"),
    ("uranus", "URANUS", "Уран", "♅"),
    ("neptune", "NEPTUNE", "Нептун", "♆"),
    ("pluto", "PLUTO", "Плутон", "♇"),
    ("chiron", "CHIRON", "Хирон", "⚷"),
    ("node", "TRUE_NODE", "Узел", "☊"),
)

#: Планеты, которые участвуют в аспектах и балансах (без узла: это не планета).
ASPECT_PLANETS: tuple[str, ...] = tuple(
    key for key, _pid, _ru, _glyph in PLANETS if key != "node"
)

#: (ключ, русское название, угол, орб для натальной карты, вес силы)
ASPECTS: tuple[tuple[str, str, int, float, float], ...] = (
    ("conjunction", "соединение", 0, 8.0, 1.0),
    ("opposition", "оппозиция", 180, 7.0, 0.9),
    ("trine", "трин", 120, 6.0, 0.8),
    ("square", "квадрат", 90, 6.0, 0.85),
    ("sextile", "секстиль", 60, 4.0, 0.5),
)

#: Для транзитов орб уже: транзит — про «сегодня», а не про всю жизнь.
TRANSIT_ORBS: dict[str, float] = {
    "conjunction": 6.0,
    "opposition": 6.0,
    "trine": 5.0,
    "square": 5.0,
    "sextile": 3.0,
}

ELEMENTS: dict[str, str] = {
    "Овен": "fire",
    "Лев": "fire",
    "Стрелец": "fire",
    "Телец": "earth",
    "Дева": "earth",
    "Козерог": "earth",
    "Близнецы": "air",
    "Весы": "air",
    "Водолей": "air",
    "Рак": "water",
    "Скорпион": "water",
    "Рыбы": "water",
}

ELEMENT_NAMES_RU: dict[str, str] = {
    "fire": "огонь",
    "earth": "земля",
    "air": "воздух",
    "water": "вода",
}

MODALITIES: dict[str, str] = {
    "Овен": "cardinal",
    "Рак": "cardinal",
    "Весы": "cardinal",
    "Козерог": "cardinal",
    "Телец": "fixed",
    "Лев": "fixed",
    "Скорпион": "fixed",
    "Водолей": "fixed",
    "Близнецы": "mutable",
    "Дева": "mutable",
    "Стрелец": "mutable",
    "Рыбы": "mutable",
}

MODALITY_NAMES_RU: dict[str, str] = {
    "cardinal": "кардинальный",
    "fixed": "фиксированный",
    "mutable": "мутабельный",
}

#: Вес светил в балансах: Солнце и Луна «весят» вдвое.
LUMINARY_WEIGHT = 2.0
PLANET_WEIGHT = 1.0
