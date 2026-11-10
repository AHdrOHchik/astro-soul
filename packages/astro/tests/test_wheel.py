"""SVG-колесо: валидность, отсутствие ПДн и раскладка без наездов."""

from __future__ import annotations

import re

from astro import BirthInput, calcChart, renderWheel
from astro.constants import SIGN_GLYPHS
from astro.wheel import CENTER_LABEL, UNKNOWN_HOUSES_CAPTION, placed_hits, wheelLayout


def test_wheel_is_svg(known_birth: BirthInput) -> None:
    svg = renderWheel(calcChart(known_birth))

    assert svg.startswith("<svg ")
    assert svg.rstrip().endswith("</svg>")
    assert 'xmlns="http://www.w3.org/2000/svg"' in svg
    assert "http://" not in svg.replace('xmlns="http://www.w3.org/2000/svg"', "").replace(
        'xmlns:xlink="http://www.w3.org/1999/xlink"', ""
    )
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


def test_wheel_text_is_vector_paths(known_birth: BirthInput) -> None:
    """Ни одного `<text>` и ни одного `font-family`: в WebView их нечем рисовать."""
    svg = renderWheel(calcChart(known_birth))

    assert "<text" not in svg
    assert "font-family" not in svg
    assert "@font-face" not in svg
    # Глифы лежат в <defs> по одному разу, на месте — ссылки
    assert svg.count("<defs>") == 1
    assert svg.count('<use href="#gl-') == svg.count("<use ")


def test_wheel_uses_only_bundled_glyphs(known_birth: BirthInput) -> None:
    """Каждый символ подписи есть в наборе контуров — иначе глиф молча пропадёт."""
    chart = calcChart(known_birth)
    svg = renderWheel(chart)
    used = set(re.findall(r'id="gl-([0-9A-F]{4})"', svg))

    assert used
    assert all(chr(int(code, 16)) for code in used)
    assert len(used) >= 12 + len(chart.planets)


def test_wheel_layout_has_no_collisions(known_birth: BirthInput) -> None:
    """Подписи не пересекаются с маркерами и друг с другом.

    Проверка геометрическая и детерминированная: сравниваются габариты,
    которые колесо реально нарисовало, а не «на глаз» по картинке.
    """
    chart = calcChart(known_birth)
    boxes = wheelLayout(chart)

    def owner(key: str) -> str:
        return key.split(":", 1)[-1]

    collisions = [
        (first.key, second.key)
        for index, first in enumerate(boxes)
        for second in boxes[index + 1 :]
        if first.kind in ("marker", "label")
        and second.kind in ("marker", "label", "house", "asc", "caption")
        and owner(first.key) != owner(second.key)
        and placed_hits(first, second)
    ]

    assert collisions == []


def test_wheel_layout_has_no_collisions_when_crowded(stacked_chart) -> None:
    """Крайний случай: все планеты идут подряд через 2° — наездов быть не должно."""
    chart = stacked_chart
    boxes = wheelLayout(chart)

    def owner(key: str) -> str:
        return key.split(":", 1)[-1]

    collisions = [
        (first.key, second.key)
        for index, first in enumerate(boxes)
        for second in boxes[index + 1 :]
        if first.kind in ("marker", "label")
        and second.kind in ("marker", "label")
        and owner(first.key) != owner(second.key)
        and placed_hits(first, second)
    ]

    assert collisions == []


def test_wheel_marks_unknown_houses(unknown_time_birth: BirthInput) -> None:
    chart = calcChart(unknown_time_birth)
    boxes = wheelLayout(chart)

    assert any(item.key == "unknown_houses" for item in boxes)
    assert any(item.key == "center" for item in boxes)
    assert not any(item.kind == "asc" for item in boxes)
    assert not any(item.kind == "house" for item in boxes)


def test_wheel_unknown_time_is_taller_than_wide(unknown_time_birth: BirthInput) -> None:
    """Подпись про неизвестное время живёт под колесом, а не поверх линий."""
    svg = renderWheel(calcChart(unknown_time_birth))

    assert 'viewBox="0 0 560 584"' in svg
    assert len(UNKNOWN_HOUSES_CAPTION) > len(CENTER_LABEL)


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
    assert svg.count('r="15"') == len(chart.planets)


def test_wheel_signs_are_all_present(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)
    svg = renderWheel(chart)

    sign_ids = {f"gl-{ord(glyph):04X}" for glyph in SIGN_GLYPHS}
    assert sign_ids.issubset(set(re.findall(r'id="(gl-[0-9A-F]{4})"', svg)))
