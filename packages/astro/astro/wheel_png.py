"""PNG-колесо: то же колесо, что в SVG, но растром.

Зачем отдельный рендер, а не растеризация SVG: в сайдкаре нет librsvg/cairo, а
тащить системную библиотеку ради картинки — лишняя точка отказа в контейнере
(её нет в `python:3.11-slim`, и её отсутствие видно только в проде). Поэтому
колесо для печати и шаринга рисуется тем же Pillow, что и карточки, из тех же
чисел движка: позиции планет, Асцендент, аспекты.

Правила совпадают с SVG (`astro/wheel.py`), иначе одно и то же колесо в
приложении и в PDF выглядело бы по-разному:
  * Асцендент слева (9 часов), долготы растут против часовой стрелки;
  * при неизвестном времени дома и Асцендент не рисуются, поворот от 0°;
  * в картинке нет ничего персонального: ни имени, ни даты, ни места.

Текст — встроенный TTF (`astro/fonts.py`), а не системный шрифт: на сервере
без `fonts-*` подписи иначе превратились бы в квадраты.
"""

from __future__ import annotations

import math
from io import BytesIO
from typing import Final

from PIL import Image, ImageDraw

from .constants import SIGNS
from .fonts import pillowFont
from .types import Chart

WHEEL_THEMES: Final[tuple[str, ...]] = ("dark", "light")

#: Подписи сектора: три буквы, чтобы 12 подписей не наезжали друг на друга.
_SIGN_SHORT: Final[dict[str, str]] = {
    "Овен": "ОВН",
    "Телец": "ТЛЦ",
    "Близнецы": "БЛЗ",
    "Рак": "РАК",
    "Лев": "ЛЕВ",
    "Дева": "ДЕВ",
    "Весы": "ВЕС",
    "Скорпион": "СКП",
    "Стрелец": "СТР",
    "Козерог": "КЗР",
    "Водолей": "ВДЛ",
    "Рыбы": "РЫБ",
}

_PLANET_SHORT: Final[dict[str, str]] = {
    "sun": "СОЛ",
    "moon": "ЛУН",
    "mercury": "МЕР",
    "venus": "ВЕН",
    "mars": "МАР",
    "jupiter": "ЮПТ",
    "saturn": "САТ",
    "uranus": "УРН",
    "neptune": "НЕП",
    "pluto": "ПЛТ",
    "chiron": "ХИР",
}

_PALETTES: Final[dict[str, dict[str, tuple[int, int, int]]]] = {
    "light": {
        "bg": (255, 255, 255),
        "ring": (107, 95, 181),
        "sign_line": (216, 212, 238),
        "cusp": (201, 196, 228),
        "glyph": (27, 28, 51),
        "sign_text": (107, 95, 181),
        "marks": (93, 88, 144),
        "center": (139, 134, 184),
        "planet_fill": (244, 241, 255),
        "planet_stroke": (107, 95, 181),
    },
    "dark": {
        "bg": (11, 16, 32),
        "ring": (139, 127, 212),
        "sign_line": (61, 58, 99),
        "cusp": (74, 70, 112),
        "glyph": (239, 233, 255),
        "sign_text": (201, 194, 255),
        "marks": (157, 151, 201),
        "center": (93, 88, 144),
        "planet_fill": (27, 28, 51),
        "planet_stroke": (139, 127, 212),
    },
}

#: Сколько аспектов рисуем: больше — каша, и SVG-колесо держит тот же предел.
MAX_ASPECT_LINES: Final[int] = 22

_ASPECT_COLOURS: Final[dict[str, tuple[int, int, int]]] = {
    "conjunction": (139, 127, 212),
    "opposition": (224, 122, 95),
    "trine": (143, 214, 160),
    "square": (224, 168, 95),
    "sextile": (159, 201, 255),
}


def _point(
    cx: float,
    cy: float,
    radius: float,
    longitude: float,
    rotation: float,
) -> tuple[float, float]:
    """Точка на окружности. 0° долготы после поворота — слева (9 часов),
    дальше против часовой стрелки: так колесо читают астрологи, и так же
    устроен SVG-рендер."""
    theta = math.radians(longitude - rotation)
    return cx - radius * math.cos(theta), cy - radius * math.sin(theta)


def renderWheelImage(chart: Chart, size: int = 900, theme: str = "light") -> Image.Image:
    """Колесо в растре. Возвращает изображение, а не байты: PDF вставляет его
    как есть, карточка — масштабирует, тест — проверяет пиксели."""
    if theme not in WHEEL_THEMES:
        raise ValueError(f"неизвестная тема колеса: {theme}")
    if size < 200:
        raise ValueError("колесо меньше 200 px не читается")

    palette = _PALETTES[theme]
    image = Image.new("RGB", (size, size), palette["bg"])
    draw = ImageDraw.Draw(image)

    cx = cy = size / 2
    outer = size * 0.47
    sign_ring = size * 0.40
    planet_ring = size * 0.33

    rotation = chart.asc if chart.asc is not None else 0.0

    line_width = max(1, round(size / 320))

    # Внешние кольца: граница колеса и граница знаков.
    draw.ellipse(
        [cx - outer, cy - outer, cx + outer, cy + outer],
        outline=palette["ring"],
        width=max(2, line_width * 2),
    )
    draw.ellipse(
        [cx - sign_ring, cy - sign_ring, cx + sign_ring, cy + sign_ring],
        outline=palette["ring"],
        width=line_width,
    )

    # Сектора знаков: границы каждые 30° от 0° Овна.
    sign_font = pillowFont(max(11, round(size * 0.032)), bold=True)
    for index in range(12):
        start = _point(cx, cy, outer, index * 30.0, rotation)
        end = _point(cx, cy, sign_ring, index * 30.0, rotation)
        draw.line([start, end], fill=palette["sign_line"], width=line_width)

        name = SIGNS[index]
        label = _SIGN_SHORT.get(name, name[:3].upper())
        mid = _point(cx, cy, (outer + sign_ring) / 2, index * 30.0 + 15.0, rotation)
        draw.text(mid, label, font=sign_font, fill=palette["sign_text"], anchor="mm")

    # Дома: куспиды от Асцендента, если время известно.
    if chart.houses is not None:
        house_width = max(1, line_width)
        for cusp in chart.houses:
            start = _point(cx, cy, planet_ring, cusp, rotation)
            end = _point(cx, cy, sign_ring * 0.72, cusp, rotation)
            draw.line([start, end], fill=palette["cusp"], width=house_width)

    # Аспекты — между планетами, самым сильным первым (порядок задаёт движок).
    positions = {planet.key: planet.longitude for planet in chart.planets}
    for aspect in chart.aspects[:MAX_ASPECT_LINES]:
        if aspect.a not in positions or aspect.b not in positions:
            continue
        first = _point(cx, cy, planet_ring * 0.86, positions[aspect.a], rotation)
        second = _point(cx, cy, planet_ring * 0.86, positions[aspect.b], rotation)
        draw.line(
            [first, second],
            fill=_ASPECT_COLOURS.get(aspect.type, palette["cusp"]),
            width=line_width,
        )

    # Планеты: маркер на своей долготе и подпись внутри кольца.
    marker = max(3.0, size * 0.009)
    planet_font = pillowFont(max(10, round(size * 0.028)))
    # Подписи соседних планет иначе наезжают друг на друга: две подписи на
    # близких долготах стоят на разных радиусах. Это дешевле, чем считать
    # пересечения боксов, и на глаз читается.
    label_radii = (0.76, 0.62)
    for index, planet in enumerate(chart.planets):
        x, y = _point(cx, cy, planet_ring, planet.longitude, rotation)
        draw.ellipse(
            [x - marker, y - marker, x + marker, y + marker],
            fill=palette["planet_fill"],
            outline=palette["planet_stroke"],
            width=line_width,
        )

        short = _PLANET_SHORT.get(planet.key)
        if short is None:
            continue
        radius = planet_ring * label_radii[index % len(label_radii)]
        lx, ly = _point(cx, cy, radius, planet.longitude, rotation)
        draw.text((lx, ly), short, font=planet_font, fill=palette["marks"], anchor="mm")

    # Подпись в центре: нейтральная, без имени и даты рождения.
    center_font = pillowFont(max(10, round(size * 0.026)))
    draw.text(
        (cx, cy),
        "Разбор личности",
        font=center_font,
        fill=palette["center"],
        anchor="mm",
    )

    return image


def _png_bytes(image: Image.Image) -> bytes:
    buffer = BytesIO()
    # Явно без метаданных: PNG-карточки и колесо уходят наружу, EXIF в них
    # не нужен ни для чего, а «случайный» EXIF — это ПДн в картинке.
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def renderWheelPng(chart: Chart, size: int = 900, theme: str = "light") -> bytes:
    """Колесо в PNG-байтах."""
    return _png_bytes(renderWheelImage(chart, size=size, theme=theme))


__all__ = [
    "MAX_ASPECT_LINES",
    "WHEEL_THEMES",
    "renderWheelImage",
    "renderWheelPng",
]
