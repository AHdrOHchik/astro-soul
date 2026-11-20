"""Карточки шеринга: PNG без ПДн.

Три вида (`day`, `wheel`, `insight`) — один рендер, разные размеры и разный
набор элементов. Правила, ради которых этот файл написан именно так:

  * **Ничего персонального.** Карточка уходит из приложения и живёт своей
    жизнью: в неё не попадают ни имя, ни дата/время рождения, ни город, ни
    координаты. Сюда приходят только строки, которые API уже проверил.
  * **Только встроенный шрифт** (`astro/fonts.py`): на сервере без `fonts-*`
    кириллица в PNG иначе исчезла бы бесследно.
  * **Без метаданных.** `Image.save(..., format="PNG")` без `exif`/`pnginfo`:
    EXIF в картинке — это персональные данные, которых там быть не должно.
  * **Детерминированность.** Один и тот же вход даёт одни и те же байты: API
    кэширует карточку по хешу содержимого, и «каждый раз другая картинка»
    означало бы кэш, который никогда не попадает.
"""

from __future__ import annotations

from io import BytesIO
from typing import Final, Literal

from PIL import Image, ImageDraw

from .fonts import pillowFont

CardKind = Literal["day", "wheel", "insight"]

#: Размеры из задания: 9:16 для дня и колеса, квадрат для цитаты.
CARD_SIZES: Final[dict[str, tuple[int, int]]] = {
    "day": (1080, 1920),
    "wheel": (1080, 1920),
    "insight": (1080, 1080),
}

#: Фон: тёмный градиент. Светлый текст на нём читается в любом чате, а на
#: светлом фоне карточка терялась среди скриншотов.
_BG_TOP: Final[tuple[int, int, int]] = (26, 22, 56)
_BG_BOTTOM: Final[tuple[int, int, int]] = (12, 10, 28)
_TEXT: Final[tuple[int, int, int]] = (239, 233, 255)
_MUTED: Final[tuple[int, int, int]] = (166, 160, 200)
_ACCENT: Final[tuple[int, int, int]] = (139, 127, 212)

#: Поля карточки — доля от меньшей стороны.
_PADDING: Final[float] = 0.085


def _gradient(size: tuple[int, int]) -> Image.Image:
    """Вертикальный градиент. Рисуем полосками: 256 оттенков хватает, чтобы
    ступенек не было видно, и это дешевле, чем numpy."""
    width, height = size
    image = Image.new("RGB", size, _BG_TOP)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        mix = y / max(1, height - 1)
        colour = tuple(
            round(_BG_TOP[channel] + (_BG_BOTTOM[channel] - _BG_TOP[channel]) * mix)
            for channel in range(3)
        )
        draw.line([(0, y), (width, y)], fill=colour)
    return image


def wrapText(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
    max_width: float,
) -> list[str]:
    """Перенос по словам. В PDF переносы делает движок, здесь — мы: Pillow
    рисует строку целиком и за границу не переносит."""
    words = text.split()
    if not words:
        return []

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if draw.textlength(candidate, font=font) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _fit_lines(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
    max_width: float,
    max_lines: int,
) -> list[str]:
    lines = wrapText(draw, text, font, max_width)
    if len(lines) <= max_lines:
        return lines

    kept = lines[:max_lines]
    last = kept[-1]
    while last and draw.textlength(f"{last}…", font=font) > max_width:
        last = last[:-1].rstrip()
    kept[-1] = f"{last}…"
    return kept


def _moon_disc(
    image: Image.Image,
    centre: tuple[float, float],
    radius: float,
    illumination: float,
) -> None:
    """Луна с фазой: светлый диск и тень, накрывающая левую часть.

    Точность астрономическая здесь не нужна — нужен узнаваемый знак «это про
    сегодня». `illumination` 0 — новолуние (диск тёмный), 1 — полная луна.
    """
    draw = ImageDraw.Draw(image)
    cx, cy = centre
    lit = max(0.0, min(1.0, illumination))

    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        fill=(233, 228, 255),
    )

    shadow_half = radius * (1 - lit)
    if shadow_half <= 0:
        return

    shift = radius * lit
    draw.ellipse(
        [
            cx - shift - shadow_half,
            cy - radius,
            cx - shift + shadow_half,
            cy + radius,
        ],
        fill=_BG_TOP,
    )


def renderCard(
    kind: CardKind,
    title: str,
    lines: list[str],
    footer: str | None = None,
    wheel_png: bytes | None = None,
    moon_illumination: float | None = None,
) -> Image.Image:
    """Карточка в растре. `lines` — уже безопасные строки: рендер их только
    раскладывает и ничего не добавляет от себя (кроме подписи-ссылки)."""
    if kind not in CARD_SIZES:
        raise ValueError(f"неизвестный вид карточки: {kind}")

    width, height = CARD_SIZES[kind]
    image = _gradient((width, height))
    draw = ImageDraw.Draw(image)

    padding = round(min(width, height) * _PADDING)
    content_width = width - padding * 2
    base = min(width, height)

    title_size = round(base * (0.075 if kind == "insight" else 0.058))
    body_size = round(base * (0.048 if kind == "insight" else 0.036))
    footer_size = round(base * 0.03)

    title_font = pillowFont(title_size, bold=True)
    body_font = pillowFont(body_size)
    footer_font = pillowFont(footer_size)

    # Сначала собираем блоки, потом рисуем: без этого нельзя ни отцентровать
    # содержимое по вертикали, ни понять, влезет ли колесо.
    blocks: list[tuple[str, object, int, tuple[int, int, int]]] = []
    for line in _fit_lines(draw, title, title_font, content_width, max_lines=3):
        blocks.append((line, title_font, round(title_size * 1.25), _TEXT))

    blocks.append(("", body_font, round(base * 0.02), _TEXT))

    wheel: Image.Image | None = None
    if wheel_png is not None:
        wheel = Image.open(BytesIO(wheel_png)).convert("RGB")
        target = round(min(content_width, height * 0.52))
        wheel.thumbnail((target, target), Image.LANCZOS)
        blocks.append(("", body_font, wheel.height + round(base * 0.03), _TEXT))

    for text in lines:
        for line in _fit_lines(draw, text, body_font, content_width, max_lines=6):
            blocks.append((line, body_font, round(body_size * 1.35), _TEXT))
        blocks.append(("", body_font, round(base * 0.018), _TEXT))

    moon_radius = round(base * 0.11) if (kind == "day" and moon_illumination is not None) else 0
    top_reserve = padding + (moon_radius * 2 + round(base * 0.04) if moon_radius else 0)
    bottom_reserve = padding + (footer_size + round(base * 0.03) if footer else 0)

    content_height = sum(block[2] for block in blocks)
    y = max(
        top_reserve,
        top_reserve + round((height - top_reserve - bottom_reserve - content_height) * 0.35),
    )

    if moon_radius:
        _moon_disc(
            image,
            (width / 2, y + moon_radius),
            moon_radius,
            moon_illumination if moon_illumination is not None else 1.0,
        )
        y += moon_radius * 2 + round(base * 0.04)

    if wheel is not None:
        image.paste(wheel, (round((width - wheel.width) / 2), y))

    for text, font, line_height, colour in blocks:
        if text:
            draw.text((padding, y), text, font=font, fill=colour)
        y += line_height

    # Подпись-ссылка внизу: она и есть «вирусный» вход, поэтому без неё
    # карточка не собирается вовсе.
    if footer:
        footer_y = height - padding - footer_size
        draw.line(
            [
                (padding, footer_y - round(base * 0.02)),
                (width - padding, footer_y - round(base * 0.02)),
            ],
            fill=_ACCENT,
            width=max(1, round(base / 540)),
        )
        draw.text((padding, footer_y), footer, font=footer_font, fill=_MUTED)

    return image


def renderCardPng(
    kind: CardKind,
    title: str,
    lines: list[str],
    footer: str | None = None,
    wheel_png: bytes | None = None,
    moon_illumination: float | None = None,
) -> bytes:
    """Карточка в PNG-байтах — без EXIF и без текстовых чанков."""
    image = renderCard(
        kind,
        title,
        lines,
        footer=footer,
        wheel_png=wheel_png,
        moon_illumination=moon_illumination,
    )
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


__all__ = ["CARD_SIZES", "CardKind", "renderCard", "renderCardPng", "wrapText"]
