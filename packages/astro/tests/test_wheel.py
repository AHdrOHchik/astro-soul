"""SVG-колесо: валидность и отсутствие ПДн в разметке."""

from __future__ import annotations

import re

from astro import BirthInput, calcChart, renderWheel
from astro.constants import SIGN_GLYPHS


def test_wheel_is_svg(known_birth: BirthInput) -> None:
    svg = renderWheel(calcChart(known_birth))

    assert svg.startswith("<svg ")
    assert svg.rstrip().endswith("</svg>")
    assert 'xmlns="http://www.w3.org/2000/svg"' in svg
    assert "http://" not in svg.replace('xmlns="http://www.w3.org/2000/svg"', "")
    assert svg.count("<circle") >= 4


def test_wheel_is_deterministic(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)

    assert renderWheel(chart) == renderWheel(chart)


def test_wheel_has_no_personal_data(known_birth: BirthInput) -> None:
    svg = renderWheel(calcChart(known_birth))

    assert known_birth.place.name not in svg
    assert "1994-05-17" not in svg
    assert "14:20" not in svg
    assert "<script" not in svg
    # Все координаты в разметке — числа, никаких подстановок из ПДн
    assert re.search(r'x="[^"]*[A-Za-zА-Яа-я]', svg) is None


def test_wheel_marks_unknown_houses(unknown_time_birth: BirthInput) -> None:
    svg = renderWheel(calcChart(unknown_time_birth))

    assert "не рассчитаны" in svg
    assert ">ASC<" not in svg


def test_wheel_geometry_stays_inside_viewbox(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)
    svg = renderWheel(chart)

    values = [
        float(value)
        for value in re.findall(r'(?:x|y|x1|y1|x2|y2|cx|cy|r)="(-?[\d.]+)"', svg)
    ]
    assert values
    assert min(values) >= 0
    assert max(values) <= 560

    # Никаких NaN/None в атрибутах (частый баг при делении на ноль)
    assert re.search(r'="(?:nan|-nan|NaN|None)"', svg) is None

    # 12 знаков и столько же маркеров планет, сколько рассчитано
    assert sum(svg.count(glyph) for glyph in SIGN_GLYPHS) == 12
    assert svg.count('r="10"') == len(chart.planets)
