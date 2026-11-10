"""SVG-колесо натальной карты.

Правила:
  * колесо повёрнуто так, что Асцендент слева (9 часов), долготы растут
    против часовой стрелки — стандарт натальной карты;
  * при неизвестном времени дома и Асцендент не рисуются, поворот — от 0°;
  * в SVG не попадает ничего персонального: ни имя, ни дата/время рождения,
    ни город. Колесо уходит в шаринг (`/charts/{id}/wheel.svg`), поэтому
    подпись в центре нейтральная.
"""

from __future__ import annotations

import math
from typing import Final
from xml.sax.saxutils import escape

from .constants import SIGN_GLYPHS, SIGNS
from .types import Chart, degree_of, sign_of

SIGN_COLORS: Final[tuple[str, ...]] = (
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
)

ASPECT_STYLE: Final[dict[str, tuple[str, float]]] = {
    "conjunction": ("#ffd479", 1.2),
    "opposition": ("#ff7a7a", 1.0),
    "trine": ("#6ee7a8", 1.0),
    "square": ("#ff8a5c", 1.0),
    "sextile": ("#7cc6ff", 0.8),
}

MAX_ASPECT_LINES: Final[int] = 22
CENTER_LABEL: Final[str] = "Разбор личности"


def _format_longitude(longitude: float) -> str:
    lon = longitude % 360
    return f"{degree_of(lon)}°{sign_of(lon)}"


def renderWheel(chart: Chart, size: int = 560) -> str:
    """Возвращает самодостаточный SVG (без внешних ссылок и шрифтов из сети)."""
    cx = cy = size / 2
    r_out = size / 2 - 4
    r_sign = r_out - 42
    r_house = r_sign - 40
    r_inner = r_house - 78
    asc = chart.asc if chart.asc is not None else 0.0

    def point(radius: float, degree: float) -> tuple[float, float]:
        angle = math.radians(180 + (degree - asc))
        return cx + radius * math.cos(angle), cy - radius * math.sin(angle)

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'width="{size}" height="{size}" role="img" aria-label="Натальная карта" '
        f'font-family="DejaVu Sans, Segoe UI Symbol, Apple Symbols, Noto Sans Symbols 2, '
        f'Georgia, serif">',
        f'<rect width="{size}" height="{size}" fill="#0b1020"/>',
    ]

    for radius, width in ((r_out, 1.5), (r_sign, 1), (r_house, 1), (r_inner, 1)):
        parts.append(
            f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="none" stroke="#8b7fd4" '
            f'stroke-width="{width}" opacity="0.8"/>'
        )

    # Знаки зодиака
    for index in range(12):
        degree = index * 30
        x1, y1 = point(r_out, degree)
        x2, y2 = point(r_inner, degree)
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="#3d3a63" stroke-width="0.6"/>'
        )
        gx, gy = point((r_out + r_sign) / 2, degree + 15)
        parts.append(
            f'<text x="{gx:.1f}" y="{gy:.1f}" fill="{SIGN_COLORS[index]}" font-size="19" '
            f'text-anchor="middle" dominant-baseline="central">'
            f"{escape(SIGN_GLYPHS[index])}</text>"
        )

    # Куспиды домов
    if chart.houses is not None:
        for index, cusp in enumerate(chart.houses, start=1):
            x1, y1 = point(r_house, cusp)
            x2, y2 = point(r_inner, cusp)
            is_angle = index in (1, 4, 7, 10)
            parts.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="{"#c9c2ff" if is_angle else "#4a4670"}" '
                f'stroke-width="{1.4 if is_angle else 0.6}"/>'
            )
            nx, ny = point(r_inner + 12, cusp + 12)
            parts.append(
                f'<text x="{nx:.1f}" y="{ny:.1f}" fill="#7b76a8" font-size="10" '
                f'text-anchor="middle" dominant-baseline="central">{index}</text>'
            )

        asc_x, asc_y = point(r_house - 4, asc)
        parts.append(
            f'<text x="{asc_x:.1f}" y="{asc_y:.1f}" fill="#c9c2ff" font-size="10" '
            f'text-anchor="middle" dominant-baseline="central">ASC</text>'
        )

    # Планеты: при скученности сдвигаем по радиусу
    placed: list[float] = []
    for planet in chart.planets:
        radius = r_house - 16
        for _ in range(6):
            if not placed or all(_distance(planet.longitude, other) > 6 for other in placed):
                break
            radius -= 14
        placed.append(planet.longitude)

        px, py = point(radius, planet.longitude)
        parts.append(
            f'<circle cx="{px:.1f}" cy="{py:.1f}" r="10" fill="#1b1c33" stroke="#8b7fd4" '
            f'stroke-width="0.8"/>'
        )
        parts.append(
            f'<text x="{px:.1f}" y="{py:.1f}" fill="#efe9ff" font-size="13" '
            f'text-anchor="middle" dominant-baseline="central">{escape(planet.glyph)}</text>'
        )
        dx, dy = point(radius - 14, planet.longitude)
        marks = _format_longitude(planet.longitude) + ("R" if planet.retrograde else "")
        parts.append(
            f'<text x="{dx:.1f}" y="{dy:.1f}" fill="#9d97c9" font-size="8" '
            f'text-anchor="middle" dominant-baseline="central">{escape(marks)}</text>'
        )

    # Аспекты внутри круга
    by_key = {planet.key: planet for planet in chart.planets}
    for aspect in chart.aspects[:MAX_ASPECT_LINES]:
        planet_a = by_key.get(aspect.a)
        planet_b = by_key.get(aspect.b)
        if planet_a is None or planet_b is None:
            continue
        x1, y1 = point(r_inner - 6, planet_a.longitude)
        x2, y2 = point(r_inner - 6, planet_b.longitude)
        color, width = ASPECT_STYLE.get(aspect.type, ("#8b7fd4", 0.8))
        opacity = 0.25 + aspect.strength * 0.6
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="{width}" opacity="{opacity:.2f}"/>'
        )

    # Подпись в центре: нейтральная, без города и даты
    parts.append(
        f'<text x="{cx}" y="{cy + 6}" fill="#5d5890" font-size="12" text-anchor="middle">'
        f"{escape(CENTER_LABEL)}</text>"
    )

    if chart.houses is None:
        parts.append(
            f'<text x="{cx}" y="{size - 14}" fill="#7b76a8" font-size="10" '
            f'text-anchor="middle">Дома и Асцендент не рассчитаны: время рождения неизвестно</text>'
        )

    parts.append("</svg>")
    return "\n".join(parts)


def _distance(a: float, b: float) -> float:
    """Минимальное расстояние по кругу в градусах."""
    return abs(((a - b + 180) % 360) - 180)


__all__ = ["SIGNS", "renderWheel"]
