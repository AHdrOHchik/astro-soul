"""Встроенные шрифты: один источник правды для PDF и PNG.

Шрифт лежит в репозитории (`astro/fonts/`), а не берётся из системы. Причина
не в лицензии, а в предсказуемости: на сервере без `fonts-*` кириллица в PDF
превращается в пустые квадраты, и человек получает оплаченный документ,
который нельзя прочитать. Тест `tests/test_pdf.py` проверяет, что глифы «ё»,
«й», «ъ», «—», ««» действительно попали в собранный файл.

Лицензия и полный текст — рядом со шрифтами, `fonts/LICENSE-DejaVu.txt`.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

FONT_DIR = Path(__file__).with_name("fonts")

REGULAR_FILE = FONT_DIR / "DejaVuSans.ttf"
BOLD_FILE = FONT_DIR / "DejaVuSans-Bold.ttf"

#: Имена, под которыми шрифт регистрируется в reportlab. Одно имя = один
#: ресурс в PDF; разные имена для одного файла удваивали бы вложенный шрифт.
PDF_REGULAR = "DejaVuSans"
PDF_BOLD = "DejaVuSans-Bold"


def fontFile(bold: bool = False) -> Path:
    """Путь к встроенному TTF. Отсутствие файла — ошибка сборки, а не повод
    молча отдать PDF без кириллицы."""
    path = BOLD_FILE if bold else REGULAR_FILE
    if not path.is_file():
        raise FileNotFoundError(f"нет встроенного шрифта: {path}")
    return path


@lru_cache(maxsize=1)
def registerPdfFonts() -> tuple[str, str]:
    """Регистрирует TTF в reportlab и возвращает имена (regular, bold)."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    pdfmetrics.registerFont(TTFont(PDF_REGULAR, str(fontFile(False))))
    pdfmetrics.registerFont(TTFont(PDF_BOLD, str(fontFile(True))))
    pdfmetrics.registerFontFamily(
        PDF_REGULAR,
        normal=PDF_REGULAR,
        bold=PDF_BOLD,
        italic=PDF_REGULAR,
        boldItalic=PDF_BOLD,
    )
    return PDF_REGULAR, PDF_BOLD


@lru_cache(maxsize=8)
def pillowFont(size: int, bold: bool = False):
    """Шрифт Pillow того же файла. Кэш по (размер, начертание): создание
    `FreeTypeFont` на каждый текст — самая дорогая часть отрисовки карточки."""
    from PIL import ImageFont

    return ImageFont.truetype(str(fontFile(bold)), size=size)
