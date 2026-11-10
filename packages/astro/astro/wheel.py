"""SVG-колесо натальной карты.

Правила:
  * колесо повёрнуто так, что Асцендент слева (9 часов), долготы растут
    против часовой стрелки — стандарт натальной карты;
  * при неизвестном времени дома и Асцендент не рисуются, поворот — от 0°;
  * в SVG не попадает ничего персонального: ни имя, ни дата/время рождения,
    ни город. Колесо уходит в шаринг (`/charts/{id}/wheel.svg`), поэтому
    подпись в центре нейтральная;
  * тема (`dark`/`light`) приходит из query-параметра контракта.

Почему весь текст — векторные пути (`astro/glyphs.py`), а не `<text>`:
в мобильном WebView нет ни DejaVu Sans, ни Segoe UI Symbol, а глифы планет
(♃ ♄ ♇) и знаков зодиака есть только в системных шрифтах. `<text>` с любым
`font-family` там превращается в «тофу» и наезжает на маркеры. Пути рисуются
одинаково везде, а их метрики позволяют раскладывать подписи без наложений.
"""

from __future__ import annotations

import math
from typing import Any, Final, NamedTuple

from .constants import SIGN_GLYPHS
from .glyphs import GLYPHS, UNITS_PER_EM
from .types import Chart, degree_of

MAX_ASPECT_LINES: Final[int] = 22
CENTER_LABEL: Final[str] = "Разбор личности"
UNKNOWN_HOUSES_CAPTION: Final[str] = "Дома и Асцендент не рассчитаны: время рождения неизвестно"

WHEEL_THEMES: Final[tuple[str, ...]] = ("dark", "light")

#: Отступ под подпись «время неизвестно»: она живёт под колесом, а не поверх линий.
CAPTION_HEIGHT: Final[int] = 24

#: Поля вокруг подписи и маркера: ближе — уже «наезд».
LABEL_PADDING: Final[float] = 2.0

_PALETTES: Final[dict[str, dict[str, Any]]] = {
    "dark": {
        "bg": "#0b1020",
        "ring": "#8b7fd4",
        "sign_line": "#3d3a63",
        "cusp": "#4a4670",
        "cusp_angle": "#c9c2ff",
        "planet_fill": "#1b1c33",
        "planet_stroke": "#8b7fd4",
        "glyph": "#efe9ff",
        "marks": "#9d97c9",
        "house_num": "#7b76a8",
        "center": "#5d5890",
        "caption": "#7b76a8",
        "signs": (
            "#ff9f6e",
            "#8fd6a0",
            "#9fc9ff",
            "#a9d8e8",
            "#ff9f6e",
            "#8fd6a0",
            "#9fc9ff",
            "#a9d8e8",
            "#ff9f6e",
            "#8fd6a0",
            "#9fc9ff",
            "#a9d8e8",
        ),
    },
    "light": {
        "bg": "#ffffff",
        "ring": "#6b5fb5",
        "sign_line": "#d8d4ee",
        "cusp": "#c9c4e4",
        "cusp_angle": "#4a3f8f",
        "planet_fill": "#f4f1ff",
        "planet_stroke": "#6b5fb5",
        "glyph": "#1b1c33",
        "marks": "#5d5890",
        "house_num": "#8b86b8",
        "center": "#8b86b8",
        "caption": "#8b86b8",
        "signs": (
            "#c2410c",
            "#15803d",
            "#1d4ed8",
            "#0e7490",
            "#c2410c",
            "#15803d",
            "#1d4ed8",
            "#0e7490",
            "#c2410c",
            "#15803d",
            "#1d4ed8",
            "#0e7490",
        ),
    },
}

ASPECT_STYLE: Final[dict[str, tuple[str, float]]] = {
    "conjunction": ("#ffd479", 1.2),
    "opposition": ("#ff7a7a", 1.0),
    "trine": ("#6ee7a8", 1.0),
    "square": ("#ff8a5c", 1.0),
    "sextile": ("#7cc6ff", 0.8),
}

ASPECT_STYLE_LIGHT: Final[dict[str, tuple[str, float]]] = {
    "conjunction": ("#b45309", 1.2),
    "opposition": ("#b91c1c", 1.0),
    "trine": ("#047857", 1.0),
    "square": ("#c2410c", 1.0),
    "sextile": ("#1d4ed8", 0.8),
}


class Box(NamedTuple):
    """Прямоугольник в координатах SVG (ось Y вниз)."""

    x0: float
    y0: float
    x1: float
    y1: float

    def intersects(self, other: Box, padding: float = 0.0) -> bool:
        return not (
            self.x1 + padding <= other.x0
            or other.x1 + padding <= self.x0
            or self.y1 + padding <= other.y0
            or other.y1 + padding <= self.y0
        )

    def union(self, other: Box) -> Box:
        return Box(
            min(self.x0, other.x0),
            min(self.y0, other.y0),
            max(self.x1, other.x1),
            max(self.y1, other.y1),
        )


class Placed(NamedTuple):
    """Кусок разметки и его габарит — для проверки наездов в тестах."""

    kind: str
    key: str
    box: Box
    center: tuple[float, float] | None = None
    radius: float = 0.0


def _circle_hits_box(cx: float, cy: float, radius: float, box: Box, padding: float) -> bool:
    """Расстояние от центра окружности до прямоугольника — без «уголковой» грубости."""
    nearest_x = min(max(cx, box.x0), box.x1)
    nearest_y = min(max(cy, box.y0), box.y1)
    return math.hypot(cx - nearest_x, cy - nearest_y) < radius + padding


def placed_hits(first: Placed, second: Placed, padding: float = LABEL_PADDING) -> bool:
    """Пересекаются ли два элемента колеса с учётом их настоящей формы."""
    if first.center is not None and second.center is not None:
        distance = math.hypot(
            first.center[0] - second.center[0], first.center[1] - second.center[1]
        )
        return distance < first.radius + second.radius + padding
    if first.center is not None:
        return _circle_hits_box(*first.center, first.radius, second.box, padding)
    if second.center is not None:
        return _circle_hits_box(*second.center, second.radius, first.box, padding)
    return first.box.intersects(second.box, padding)


def _palette(theme: str) -> dict[str, Any]:
    try:
        return _PALETTES[theme]
    except KeyError as error:
        raise ValueError(f"неизвестная тема колеса: {theme!r}") from error


def _format_longitude(longitude: float) -> str:
    """Подпись у маркера: градус внутри знака.

    Знак не пишем словами: маркер уже стоит в своём секторе, а длинная
    строка («26°Козерог») на телефоне не читается и лезет на соседей.
    """
    return f"{degree_of(longitude % 360)}°"


def measure_text(text: str, size: float) -> float:
    """Ширина строки в пикселях для заданного кегля."""
    k = size / UNITS_PER_EM
    return sum(GLYPHS[char].advance for char in text) * k


def _glyph_positions(
    text: str, size: float, x: float, y: float, anchor: str
) -> list[tuple[float, str]]:
    """Позиции базовых линий каждого символа: (курсор по X, символ)."""
    k = size / UNITS_PER_EM
    width = measure_text(text, size)
    cursor = x - width / 2 if anchor == "middle" else x - width if anchor == "end" else x

    positions: list[tuple[float, str]] = []
    for char in text:
        positions.append((cursor, char))
        cursor += GLYPHS[char].advance * k
    return positions


def text_box(text: str, size: float, x: float, y: float, anchor: str = "middle") -> Box:
    """Габарит строки: `x` — точка привязки, `y` — базовая линия."""
    k = size / UNITS_PER_EM
    boxes = [
        Box(
            cursor + glyph.x_min * k,
            y - glyph.y_max * k,
            cursor + glyph.x_max * k,
            y - glyph.y_min * k,
        )
        for cursor, char in _glyph_positions(text, size, x, y, anchor)
        for glyph in [GLYPHS[char]]
        if glyph.path
    ]

    if not boxes:
        width = measure_text(text, size)
        left = x - width / 2 if anchor == "middle" else x - width if anchor == "end" else x
        return Box(left, y - size * 0.7, left + width, y)

    result = boxes[0]
    for box in boxes[1:]:
        result = result.union(box)
    return result


def _glyph_id(char: str) -> str:
    return f"gl-{ord(char):04X}"


def _text_svg(
    text: str,
    size: float,
    x: float,
    y: float,
    color: str,
    defs: dict[str, str],
    anchor: str = "middle",
) -> str:
    """Текст как набор контуров: без `<text>` и без зависимости от шрифтов.

    Контур каждого символа кладётся в `<defs>` один раз, а на месте стоит
    `<use>` — иначе повторяющиеся цифры и буквы раздувают SVG в разы.
    """
    k = size / UNITS_PER_EM
    uses: list[str] = []

    for cursor, char in _glyph_positions(text, size, x, y, anchor):
        glyph = GLYPHS[char]
        if not glyph.path:
            continue
        glyph_id = _glyph_id(char)
        defs[glyph_id] = glyph.path
        uses.append(
            f'<use href="#{glyph_id}" xlink:href="#{glyph_id}" '
            f'transform="translate({cursor:.2f} {y:.2f}) scale({k:.6f} {-k:.6f})"/>'
        )

    return f'<g fill="{color}">{"".join(uses)}</g>'


def _render(chart: Chart, size: int, theme: str) -> tuple[str, list[Placed]]:
    """SVG и список габаритов всех подписей — второй нужен тестам на наезды."""
    colors = _palette(theme)
    aspect_style = ASPECT_STYLE if theme == "dark" else ASPECT_STYLE_LIGHT

    height = size + (0 if chart.houses is not None else CAPTION_HEIGHT)
    cx = size / 2
    cy = size / 2

    r_out = size / 2 - 4
    r_sign_in = r_out - 40
    r_house_out = r_sign_in
    r_house_in = r_house_out - 34
    r_aspect = r_house_in - 76

    asc = chart.asc if chart.asc is not None else 0.0

    def point(radius: float, degree: float) -> tuple[float, float]:
        angle = math.radians(180 + (degree - asc))
        return cx + radius * math.cos(angle), cy - radius * math.sin(angle)

    placed: list[Placed] = []
    defs: dict[str, str] = {}
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {size} {height}" width="{size}" height="{height}" role="img" '
        f'aria-label="Натальная карта">',
        "<title>Натальная карта</title>",
        f'<rect width="{size}" height="{height}" fill="{colors["bg"]}"/>',
    ]

    for radius, width in ((r_out, 1.5), (r_sign_in, 1), (r_house_out, 1), (r_house_in, 1)):
        parts.append(
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius:.1f}" fill="none" '
            f'stroke="{colors["ring"]}" stroke-width="{width}" opacity="0.8"/>'
        )

    # Знаки зодиака: секторные линии и глифы в середине полосы.
    sign_size = 21.0
    for index in range(12):
        degree = index * 30
        x1, y1 = point(r_out, degree)
        x2, y2 = point(r_house_in, degree)
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{colors["sign_line"]}" stroke-width="0.6"/>'
        )
        gx, gy = point((r_out + r_sign_in) / 2, degree + 15)
        glyph = SIGN_GLYPHS[index]
        glyph_box = text_box(glyph, sign_size, gx, gy + sign_size * 0.36)
        parts.append(
            _text_svg(glyph, sign_size, gx, gy + sign_size * 0.36, colors["signs"][index], defs)
        )
        placed.append(Placed("sign", f"sign:{index}", glyph_box))

    # Куспиды домов, номера домов и подпись ASC.
    if chart.houses is not None:
        for index, cusp in enumerate(chart.houses, start=1):
            x1, y1 = point(r_house_out, cusp)
            x2, y2 = point(r_house_in, cusp)
            is_angle = index in (1, 4, 7, 10)
            parts.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="{colors["cusp_angle"] if is_angle else colors["cusp"]}" '
                f'stroke-width="{1.4 if is_angle else 0.6}"/>'
            )
            nx, ny = point(r_house_out - 9, cusp + 11)
            number = str(index)
            number_box = text_box(number, 10.0, nx, ny + 3.6)
            parts.append(_text_svg(number, 10.0, nx, ny + 3.6, colors["house_num"], defs))
            placed.append(Placed("house", f"house:{index}", number_box))

        ax, ay = point(r_house_in + 10, asc + 7)
        asc_box = text_box("ASC", 10.0, ax, ay + 3.6)
        parts.append(_text_svg("ASC", 10.0, ax, ay + 3.6, colors["cusp_angle"], defs))
        placed.append(Placed("asc", "asc", asc_box))

    # Аспекты внутри круга: рисуем до маркеров, чтобы планеты были сверху.
    by_key = {planet.key: planet for planet in chart.planets}
    for aspect in chart.aspects[:MAX_ASPECT_LINES]:
        planet_a = by_key.get(aspect.a)
        planet_b = by_key.get(aspect.b)
        if planet_a is None or planet_b is None:
            continue
        x1, y1 = point(r_aspect, planet_a.longitude)
        x2, y2 = point(r_aspect, planet_b.longitude)
        color, width = aspect_style.get(aspect.type, (colors["ring"], 0.8))
        opacity = 0.25 + aspect.strength * 0.6
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="{width}" opacity="{opacity:.2f}"/>'
        )

    # Планеты: маркер и подпись — один блок. Если блок задевает уже занятое
    # место, уходим на следующую дорожку к центру (лучей три).
    # Маркер планеты — один блок с подписью внутри: глиф сверху, градус снизу.
    # Отдельная подпись рядом с маркером в стеллиуме неизбежно наезжает на соседа:
    # в 8° помещаются четыре маркера, и на текст места между ними нет.
    marker_radius = 15.0
    tracks = tuple(r_house_in - marker_radius - 4 - index * 32 for index in range(4))

    center_size = 13.0
    center_box = text_box(CENTER_LABEL, center_size, cx, cy + center_size * 0.36)
    center_placed = Placed("caption", "center", center_box)
    reserved: list[Placed] = [item for item in placed if item.kind in ("house", "asc")]
    reserved.append(center_placed)

    for planet in chart.planets:
        marks = _format_longitude(planet.longitude) + ("R" if planet.retrograde else "")
        track = tracks[-1]

        for candidate in tracks:
            px, py = point(candidate, planet.longitude)
            candidate_marker = Placed(
                "marker",
                f"planet:{planet.key}",
                Box(px - marker_radius, py - marker_radius, px + marker_radius, py + marker_radius),
                (px, py),
                marker_radius,
            )
            if not any(placed_hits(candidate_marker, other) for other in reserved):
                track = candidate
                break

        px, py = point(track, planet.longitude)
        marker_placed = Placed(
            "marker",
            f"planet:{planet.key}",
            Box(px - marker_radius, py - marker_radius, px + marker_radius, py + marker_radius),
            (px, py),
            marker_radius,
        )
        reserved.append(marker_placed)

        parts.append(
            f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{marker_radius:.0f}" '
            f'fill="{colors["planet_fill"]}" stroke="{colors["planet_stroke"]}" '
            f'stroke-width="0.8"/>'
        )
        glyph_y = py - 2.0 + 12.5 * 0.34
        parts.append(_text_svg(planet.glyph, 12.5, px, glyph_y, colors["glyph"], defs))
        parts.append(_text_svg(marks, 8.0, px, py + 9.5, colors["marks"], defs))
        placed.append(marker_placed)

    # Подпись в центре: нейтральная, без города и даты.
    parts.append(
        _text_svg(CENTER_LABEL, center_size, cx, cy + center_size * 0.36, colors["center"], defs)
    )
    placed.append(center_placed)

    if chart.houses is None:
        caption_size = 11.0
        caption_y = size + CAPTION_HEIGHT - 8
        parts.append(
            _text_svg(UNKNOWN_HOUSES_CAPTION, caption_size, cx, caption_y, colors["caption"], defs)
        )
        placed.append(
            Placed(
                "caption",
                "unknown_houses",
                text_box(UNKNOWN_HOUSES_CAPTION, caption_size, cx, caption_y),
            )
        )

    # Контуры — один раз в <defs>, дальше только ссылки.
    if defs:
        definitions = "".join(
            f'<path id="{glyph_id}" d="{path}"/>' for glyph_id, path in defs.items()
        )
        parts.insert(3, f"<defs>{definitions}</defs>")

    parts.append("</svg>")
    return "\n".join(parts), placed


def renderWheel(chart: Chart, size: int = 560, theme: str = "dark") -> str:
    """Возвращает самодостаточный SVG (без внешних ссылок и шрифтов из сети)."""
    return _render(chart, size, theme)[0]


def wheelLayout(chart: Chart, size: int = 560, theme: str = "dark") -> list[Placed]:
    """Габариты подписей и маркеров: используется в тестах на наезды."""
    return _render(chart, size, theme)[1]


__all__ = [
    "CAPTION_HEIGHT",
    "CENTER_LABEL",
    "UNKNOWN_HOUSES_CAPTION",
    "WHEEL_THEMES",
    "Box",
    "Placed",
    "placed_hits",
    "measure_text",
    "renderWheel",
    "text_box",
    "wheelLayout",
]
