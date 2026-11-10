"""Генератор `astro/glyphs.py`: глифы колеса как векторные пути.

Зачем пути, а не шрифт в SVG: в мобильном WebView нет ни DejaVu Sans, ни
Segoe UI Symbol, а глифы планет (♃ ♄ ♇) и знаков зодиака есть только
в системных шрифтах. `@font-face` внутри SVG, вставленного через `<img>`,
поддерживается не везде, а пути рисуются всегда и одинаково. Побочная
выгода — точные размеры подписей для раскладки без наездов.

Исходный шрифт: DejaVu Sans (лицензия Bitstream Vera / Arev, разрешает
встраивание и изменение). В репозиторий попадает только результат —
координаты контуров, без самого файла шрифта.

Запуск (нужен fontTools и файл шрифта):

    python3 tools/build_glyphs.py /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

Файл `astro/glyphs.py` не правится руками: он перегенерируется целиком и
меняется только при смене шрифта или набора символов.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

#: Все символы, которые колесо может нарисовать: знаки, планеты, цифры,
#: градусы, «R», «ASC» и подписи на русском.
GLYPH_CHARS: str = (
    "♈♉♊♋♌♍♎♏♐♑♒♓"
    "☉☽☿♀♂♃♄♅♆♇⚷☊"
    "0123456789°"
    "RASCN"
    " "
    ".,:;!?—–-()«»·"
    "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
)

TARGET = Path(__file__).resolve().parent.parent / "astro" / "glyphs.py"

HEADER = '''"""Контуры глифов колеса — сгенерировано tools/build_glyphs.py.

Не править руками: перегенерировать скриптом. Шрифт-источник — DejaVu Sans
(Bitstream Vera / Arev license), поэтому контуры можно встраивать в SVG.
Координаты — в единицах шрифта, ось Y направлена вверх.
"""

from __future__ import annotations

from typing import Final, NamedTuple


class Glyph(NamedTuple):
    """Контур одного символа и его метрики."""

    path: str
    advance: float
    x_min: float
    y_min: float
    x_max: float
    y_max: float


UNITS_PER_EM: Final[int] = {units_per_em}
ASCENT: Final[int] = {ascent}
DESCENT: Final[int] = {descent}
SOURCE_FONT: Final[str] = "DejaVu Sans"

GLYPHS: Final[dict[str, Glyph]] = {{
'''


def build(font_path: Path) -> str:
    font = TTFont(str(font_path))
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    upem = font["head"].unitsPerEm

    rows: list[str] = []
    for char in dict.fromkeys(GLYPH_CHARS):
        name = cmap.get(ord(char))
        if name is None:
            raise SystemExit(f"в шрифте нет символа {char!r} (U+{ord(char):04X})")

        pen = SVGPathPen(glyph_set)
        glyph_set[name].draw(pen)
        width, _lsb = font["hmtx"][name]
        bounds_pen = BoundsPen(glyph_set)
        glyph_set[name].draw(bounds_pen)
        x_min, y_min, x_max, y_max = bounds_pen.bounds or (0.0, 0.0, 0.0, 0.0)

        # Пробел контура не имеет: нулевой бокс вместо отрицательных бесконечностей.
        if pen.getCommands() == "":
            path = ""
            x_min = y_min = x_max = y_max = 0.0
        else:
            path = pen.getCommands()

        rows.append(
            f"    {char!r}: Glyph(\n"
            f"        path={path!r},\n"
            f"        advance={float(width)!r},\n"
            f"        x_min={float(x_min)!r},\n"
            f"        y_min={float(y_min)!r},\n"
            f"        x_max={float(x_max)!r},\n"
            f"        y_max={float(y_max)!r},\n"
            "    ),"
        )

    return (
        HEADER.format(
            units_per_em=upem,
            ascent=font["hhea"].ascent,
            descent=font["hhea"].descent,
        )
        + "\n".join(rows)
        + "\n}\n"
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("использование: build_glyphs.py путь/к/DejaVuSans.ttf")
    source = Path(sys.argv[1])
    TARGET.write_text(build(source), encoding="utf-8")
    print(f"готово: {TARGET} ({TARGET.stat().st_size} байт)")


if __name__ == "__main__":
    main()
