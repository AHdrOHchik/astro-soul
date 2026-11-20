"""PDF разбора: кириллица, колонтитул, потолок размера, отсутствие ПДн.

Главная проверка здесь — не «файл создался», а «файл читается человеком».
Поэтому тест разбирает ToUnicode-таблицу встроенного шрифта: там перечислены
символы, которые в документе действительно есть. Если шрифт не встроен или
подставлен системный без кириллицы, «ё», «й», «ъ», тире и кавычки-ёлочки в
этой таблице не появятся — и тест упадёт раньше, чем это увидит человек,
заплативший за разбор.
"""

from __future__ import annotations

import re
import zlib

import pytest

from astro import BirthInput, calcChart
from astro.pdf import (
    FOOTER_TEXT,
    PdfBuildError,
    PdfChapter,
    PdfSpec,
    buildPdf,
)
from astro.wheel_png import renderWheelPng

#: Все буквы и знаки, из-за которых PDF без встроенного шрифта ломается.
SPECIAL_GLYPHS = ("ё", "й", "ъ", "—", "«", "»")


def _to_unicode_texts(pdf: bytes) -> str:
    """Склеивает все ToUnicode-CMap из PDF (потоки сжаты zlib)."""
    chunks: list[str] = []
    for match in re.finditer(rb"stream\r?\n(.*?)endstream", pdf, re.S):
        try:
            stream = zlib.decompress(match.group(1))
        except zlib.error:
            continue
        if b"beginbfchar" in stream or b"beginbfrange" in stream:
            chunks.append(stream.decode("latin-1"))
    return "\n".join(chunks)


def _glyphs_in(pdf: bytes) -> set[int]:
    """Коды символов, которые есть в ToUnicode: `<0001> <0451>` и диапазоны."""
    text = _to_unicode_texts(pdf)
    codes: set[int] = set()

    # Коды-источники в subset-шрифте однобайтовые (`<00>`), а не двухбайтовые:
    # reportlab нумерует глифы подряд, начиная с нуля.
    for pair in re.finditer(r"<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]{4,})>", text):
        codes.add(int(pair.group(2)[:4], 16))

    for rng in re.finditer(r"<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]{4})>", text):
        start, end = int(rng.group(2), 16), int(rng.group(3), 16)
        if 0 <= end - start <= 512:
            codes.update(range(start, end + 1))

    return codes


@pytest.fixture()
def wheel_png(known_birth: BirthInput) -> bytes:
    return renderWheelPng(calcChart(known_birth), size=600)


def _spec(wheel_png: bytes | None = None, **overrides) -> PdfSpec:
    chapters = (
        PdfChapter(
            title="Ядро",
            paragraphs=(
                "Съешь ещё этих мягких французских булок — и объём дня сложится сам.",
                "Йод и ёлка: «так тоже бывает» — и это нормально.",
            ),
        ),
        PdfChapter(title="Эмоции", paragraphs=("Второй раздел с ёмким «ё» и тире — вот так.",)),
        PdfChapter(title="Таланты", paragraphs=("Третий раздел. Он нужен, чтобы проверить оглавление.",)),
    )
    base = {
        "subtitle": "Собрано 20 ноября 2026",
        "chapters": chapters,
        "actions": (
            "Выпиши два варианта и выбери меньший",
            "Скажи «нет» одному делу на этой неделе",
            "Поспи на час больше",
        ),
        "link": "t.me/astro_soul_bot",
        "wheel_png": wheel_png,
    }
    base.update(overrides)
    return PdfSpec(**base)


def test_pdf_contains_cyrillic_glyphs(wheel_png: bytes) -> None:
    result = buildPdf(_spec(wheel_png))

    glyphs = _glyphs_in(result.pdf)
    assert glyphs, "в PDF нет ToUnicode: шрифт не встроен, текст не извлечь"

    missing = [glyph for glyph in SPECIAL_GLYPHS if ord(glyph) not in glyphs]
    assert missing == [], f"в документе нет глифов: {missing}"


def test_pdf_embeds_font_file(wheel_png: bytes) -> None:
    result = buildPdf(_spec(wheel_png))

    # FontFile2 — вложенный TrueType. Без него кириллица зависит от системы.
    assert b"/FontFile2" in result.pdf
    assert b"/ToUnicode" in result.pdf


def test_pdf_has_cover_toc_chapters_and_final_page(wheel_png: bytes) -> None:
    result = buildPdf(_spec(wheel_png))

    # Обложка, оглавление, три главы с новой страницы, «Что сделать».
    assert result.pages == 6
    assert result.wheel_scale == 1.0
    assert result.build_ms >= 0


def test_pdf_footer_present_on_every_page(wheel_png: bytes) -> None:
    result = buildPdf(_spec(wheel_png))

    # Колонтитул — текст, а не картинка, поэтому его видно в ToUnicode.
    glyphs = _glyphs_in(result.pdf)
    for char in FOOTER_TEXT:
        if char == " ":
            continue
        assert ord(char) in glyphs, f"в колонтитуле нет символа {char!r}"


def test_pdf_without_wheel_still_builds() -> None:
    result = buildPdf(_spec(None))

    assert result.pages == 6
    assert result.wheel_scale == 1.0


def test_pdf_respects_size_cap_by_shrinking_wheel(wheel_png: bytes) -> None:
    # Потолок ниже, чем файл с полноразмерным колесом: уменьшаем картинку,
    # а не отказываем человеку.
    full = buildPdf(_spec(wheel_png))
    # Потолок ниже файла с полноразмерным колесом, но выше «без колеса»:
    # значит, уложиться можно только уменьшив картинку, а не выкинув её.
    limit = round(len(full.pdf) * 0.85)
    capped = buildPdf(_spec(wheel_png, max_bytes=limit))

    assert len(capped.pdf) <= limit
    assert capped.wheel_scale < 1.0
    assert capped.attempts >= 2


def test_pdf_has_no_personal_data(wheel_png: bytes) -> None:
    birth = "1994-05-17"
    result = buildPdf(_spec(wheel_png))

    # Ни даты рождения, ни места: в документе только главы, дата сборки и
    # ссылка. Геометрия колеса — числа, текста о рождении там нет.
    assert birth.encode() not in result.pdf
    assert "Тестоград".encode() not in result.pdf
    assert b"14:20" not in result.pdf


def test_pdf_without_chapters_is_an_error() -> None:
    with pytest.raises(PdfBuildError):
        buildPdf(PdfSpec(subtitle="Собрано 20 ноября 2026", chapters=()))
