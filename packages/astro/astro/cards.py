"""Карточки шеринга: PNG без ПДн.

Пять видов (`day`, `identity`, `moon`, `wheel`, `insight`). `day`, `identity` и
`moon` — «сторис»: 1080×1920 по общему шаблону (см. `TEMPLATE_VERSION`), в
котором контент живёт только в центральной полосе `SAFE_TOP…SAFE_BOTTOM`, а
сверху и снизу стоят имя продукта, дисклеймер и подсказка для поиска.
`wheel` и `insight` нарисованы по-старому: их вёрстка зафиксирована в контракте
1.6.8, и менять её «заодно» нельзя (см. задание итерации 37).

Правила, ради которых этот файл написан именно так:

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

from dataclasses import dataclass
from io import BytesIO
from typing import Final, Literal

from PIL import Image, ImageDraw

from .fonts import pillowFont

CardKind = Literal["day", "wheel", "insight", "identity", "moon"]

#: Размеры из задания: 9:16 для дня, колеса и новых «сторис», квадрат для цитаты.
CARD_SIZES: Final[dict[str, tuple[int, int]]] = {
    "day": (1080, 1920),
    "wheel": (1080, 1920),
    "identity": (1080, 1920),
    "moon": (1080, 1920),
    "insight": (1080, 1080),
}

#: Виды, которые рисуются по шаблону сторис (итерация 37).
STORIES_KINDS: Final[tuple[str, ...]] = ("day", "identity", "moon")

#: Безопасная зона сторис: сверху и снизу по 250 px перекрывает интерфейс
#: Instagram (аватар, поле ответа, кнопки). Всё, что нарисовано за её пределами,
#: человек не увидит — это брак, а не «мелкая погрешность».
SAFE_TOP: Final[int] = 250
SAFE_BOTTOM: Final[int] = 1670

#: Версия шаблона. Хранится в `share_cards.template_version`: смена вёрстки
#: инвалидирует кэш карточек, иначе после редизайна человек получил бы старую
#: картинку из кэша по тому же хешу содержимого.
TEMPLATE_VERSION: Final[str] = "stories-1"

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


# ── Шаблон сторис (итерация 37) ────────────────────────────────────────────
#
# Зачем отдельная раскладка, а не «нарисуем и посмотрим». Карточку открывают в
# Instagram Stories, где сверху и снизу лежит интерфейс приложения: имя автора,
# поле ответа, кнопки. Всё, что попало в эти 250 px, зритель не увидит. Поэтому
# раскладка считается **до** рисования и возвращает координаты каждого блока:
# тест проверяет числа, а не «на глаз по картинке».
#
# Состав шаблона (сверху вниз): имя продукта → контент → приглашение →
# ссылка → дисклеймер → подсказка для поиска. Ни один элемент не выходит за
# `SAFE_TOP…SAFE_BOTTOM`.

_BRAND_SIZE: Final[int] = 34
_HINT_SIZE: Final[int] = 25
_DISCLAIMER_SIZE: Final[int] = 25
_FOOTER_SIZE: Final[int] = 26
_PROMPT_SIZE: Final[int] = 30

#: Размеры тела контента: берём первый, при котором всё влезает в центральную
#: полосу. Меньше 22 px на карточке 1080×1920 уже нечитаемо — там текст
#: обрезается, а не уменьшается дальше.
_BODY_SIZES: Final[tuple[int, ...]] = (38, 34, 30, 26, 22)


@dataclass(frozen=True)
class TextBlock:
    """Нарисованная строка и её место. Координаты — часть контракта шаблона."""

    text: str
    x: int
    y: int
    width: int
    height: int
    role: str
    size: int
    bold: bool = False

    @property
    def bottom(self) -> int:
        return self.y + self.height


@dataclass(frozen=True)
class StoriesLayout:
    """Раскладка карточки-сторис: всё, что будет нарисовано, с координатами."""

    kind: str
    width: int
    height: int
    blocks: tuple[TextBlock, ...]
    #: Центр и радиус лунного диска (`day`, `moon`), если он есть.
    moon: tuple[int, int, int] | None

    def outsideSafeZone(self) -> tuple[TextBlock, ...]:
        """Блоки, вылезшие за `SAFE_TOP…SAFE_BOTTOM`. В норме — пусто."""
        return tuple(
            block for block in self.blocks if block.y < SAFE_TOP or block.bottom > SAFE_BOTTOM
        )


def _block(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: int,
    y: int,
    font,
    role: str,
    *,
    bold: bool = False,
) -> TextBlock:
    return TextBlock(
        text=text,
        x=x,
        y=y,
        width=round(draw.textlength(text, font=font)),
        height=round(font.size * 1.2),
        role=role,
        size=font.size,
        bold=bold,
    )


def storiesLayout(
    kind: str,
    title: str,
    lines: list[str],
    *,
    brand_name: str | None = None,
    brand_hint: str | None = None,
    disclaimer: str | None = None,
    prompt: str | None = None,
    footer: str | None = None,
    moon_illumination: float | None = None,
) -> StoriesLayout:
    """Раскладка «сторис» по общему шаблону.

    Ничего не рисует на картинке (кроме пробного полотна в памяти для метрик
    текста) — только считает координаты. Так безопасную зону можно проверить
    тестом и нельзя «случайно» нарушить правкой одной строки.
    """
    if kind not in STORIES_KINDS:
        raise ValueError(f"шаблон сторис не для вида: {kind}")

    width, height = CARD_SIZES[kind]
    measure = ImageDraw.Draw(Image.new("RGB", (width, height)))
    padding = round(min(width, height) * _PADDING)
    content_width = width - padding * 2

    blocks: list[TextBlock] = []

    # Верх: имя продукта. Не username бота и не «Astro Soul по умолчанию»:
    # значение приходит из конфига API, а если его нет — карточка не собирается
    # вовсе (проверка на стороне API).
    brand_bottom = SAFE_TOP
    if brand_name:
        brand_font = pillowFont(_BRAND_SIZE, bold=True)
        brand = _block(measure, brand_name, padding, SAFE_TOP + 12, brand_font, "brand", bold=True)
        blocks.append(brand)
        brand_bottom = brand.bottom

    # Низ собираем снизу вверх: подсказка для поиска у самого края безопасной
    # зоны, над ней дисклеймер, ссылка и приглашение.
    bottom_top = SAFE_BOTTOM
    gap = 18

    if brand_hint:
        hint_font = pillowFont(_HINT_SIZE)
        hint = _block(
            measure,
            brand_hint,
            padding,
            SAFE_BOTTOM - round(hint_font.size * 1.2),
            hint_font,
            "hint",
        )
        blocks.append(hint)
        bottom_top = hint.y - gap

    if disclaimer:
        disc_font = pillowFont(_DISCLAIMER_SIZE)
        disc_line = round(disc_font.size * 1.35)
        disc_lines = _fit_lines(measure, disclaimer, disc_font, content_width, max_lines=2)
        disc_top = bottom_top - disc_line * len(disc_lines)
        for index, line in enumerate(disc_lines):
            blocks.append(
                _block(
                    measure, line, padding, disc_top + index * disc_line, disc_font, "disclaimer"
                )
            )
        bottom_top = disc_top - gap

    if footer:
        footer_font = pillowFont(_FOOTER_SIZE)
        footer_block = _block(
            measure,
            footer,
            padding,
            bottom_top - round(footer_font.size * 1.2),
            footer_font,
            "footer",
        )
        blocks.append(footer_block)
        bottom_top = footer_block.y - gap

    if prompt:
        prompt_font = pillowFont(_PROMPT_SIZE, bold=True)
        prompt_line = round(prompt_font.size * 1.3)
        prompt_lines = _fit_lines(measure, prompt, prompt_font, content_width, max_lines=2)
        prompt_top = bottom_top - prompt_line * len(prompt_lines)
        for index, line in enumerate(prompt_lines):
            blocks.append(
                _block(
                    measure,
                    line,
                    padding,
                    prompt_top + index * prompt_line,
                    prompt_font,
                    "prompt",
                    bold=True,
                )
            )
        bottom_top = prompt_top - 22

    area_top = brand_bottom + 24
    area_bottom = bottom_top

    moon: tuple[int, int, int] | None = None

    if kind in ("day", "moon") and moon_illumination is not None:
        radius = round(min(width, height) * 0.105)
        moon = (width // 2, area_top + radius, radius)
        area_top = moon[1] + radius + 22

    title_font = pillowFont(round(min(width, height) * 0.058), bold=True)
    title_line = round(title_font.size * 1.25)
    title_lines = _fit_lines(measure, title, title_font, content_width, max_lines=3)

    available = max(0, area_bottom - area_top)
    chosen: tuple[int, int, list[list[str]]] | None = None
    for size in _BODY_SIZES:
        body_font = pillowFont(size)
        body_line = round(size * 1.35)
        wrapped = [
            _fit_lines(measure, text, body_font, content_width, max_lines=4) for text in lines
        ]
        needed = (
            len(title_lines) * title_line
            + 12
            + sum(len(group) * body_line + 14 for group in wrapped)
        )
        if needed <= available:
            chosen = (size, body_line, wrapped)
            break

    if chosen is None:
        # Ни один размер не влез: режем строки, а не вылезаем за зону. Текст
        # такой длины сюда не помещается по смыслу, и лучше меньше строк, чем
        # текст под интерфейсом Instagram.
        size = _BODY_SIZES[-1]
        body_font = pillowFont(size)
        body_line = round(size * 1.35)
        wrapped = []
        used = len(title_lines) * title_line + 12
        for text in lines:
            group = _fit_lines(measure, text, body_font, content_width, max_lines=4)
            cost = len(group) * body_line + 14
            if used + cost > available:
                break
            used += cost
            wrapped.append(group)
        chosen = (size, body_line, wrapped)

    body_size, body_line, wrapped = chosen
    body_font = pillowFont(body_size)

    group_height = (
        len(title_lines) * title_line + 12 + sum(len(group) * body_line + 14 for group in wrapped)
    )
    y = area_top + max(0, (available - group_height) // 2)

    for line in title_lines:
        blocks.append(_block(measure, line, padding, y, title_font, "title", bold=True))
        y += title_line

    y += 12

    for group in wrapped:
        for line in group:
            blocks.append(_block(measure, line, padding, y, body_font, "body"))
            y += body_line
        y += 14

    layout = StoriesLayout(
        kind=kind,
        width=width,
        height=height,
        blocks=tuple(blocks),
        moon=moon,
    )

    outside = layout.outsideSafeZone()

    if outside:
        # Защита от собственных будущих правок: лучше 422 и лог, чем карточка,
        # у которой половина текста под интерфейсом Instagram.
        raise ValueError(
            "карточка выходит за безопасную зону "
            f"{SAFE_TOP}…{SAFE_BOTTOM}: "
            + ", ".join(f"{block.role}@{block.y}" for block in outside)
        )

    return layout


def _drawStories(
    image: Image.Image,
    layout: StoriesLayout,
    moon_illumination: float | None,
) -> None:
    if layout.moon is not None:
        radius = layout.moon[2]
        _moon_disc(
            image,
            (layout.moon[0], layout.moon[1]),
            radius,
            moon_illumination if moon_illumination is not None else 1.0,
        )

    draw = ImageDraw.Draw(image)

    for block in layout.blocks:
        colour = (
            _ACCENT
            if block.role in ("brand", "prompt")
            else (_MUTED if block.role in ("hint", "disclaimer", "footer") else _TEXT)
        )
        draw.text(
            (block.x, block.y),
            block.text,
            font=pillowFont(block.size, bold=block.bold),
            fill=colour,
        )


def renderCard(
    kind: CardKind,
    title: str,
    lines: list[str],
    footer: str | None = None,
    wheel_png: bytes | None = None,
    moon_illumination: float | None = None,
    *,
    brand_name: str | None = None,
    brand_hint: str | None = None,
    disclaimer: str | None = None,
    prompt: str | None = None,
) -> Image.Image:
    """Карточка в растре. `lines` — уже безопасные строки: рендер их только
    раскладывает и ничего не добавляет от себя (кроме подписи-ссылки).

    `brand_name` / `brand_hint` / `disclaimer` / `prompt` — элементы шаблона
    сторис (итерация 37). Для `wheel` и `insight` они не рисуются: вёрстка этих
    двух видов зафиксирована раньше и не меняется.
    """
    if kind not in CARD_SIZES:
        raise ValueError(f"неизвестный вид карточки: {kind}")

    width, height = CARD_SIZES[kind]
    image = _gradient((width, height))

    if kind in STORIES_KINDS:
        layout = storiesLayout(
            kind,
            title,
            lines,
            brand_name=brand_name,
            brand_hint=brand_hint,
            disclaimer=disclaimer,
            prompt=prompt,
            footer=footer,
            moon_illumination=moon_illumination,
        )
        _drawStories(image, layout, moon_illumination)
        return image

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
    *,
    brand_name: str | None = None,
    brand_hint: str | None = None,
    disclaimer: str | None = None,
    prompt: str | None = None,
) -> bytes:
    """Карточка в PNG-байтах — без EXIF и без текстовых чанков."""
    image = renderCard(
        kind,
        title,
        lines,
        footer=footer,
        wheel_png=wheel_png,
        moon_illumination=moon_illumination,
        brand_name=brand_name,
        brand_hint=brand_hint,
        disclaimer=disclaimer,
        prompt=prompt,
    )
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


__all__ = [
    "CARD_SIZES",
    "SAFE_BOTTOM",
    "SAFE_TOP",
    "STORIES_KINDS",
    "TEMPLATE_VERSION",
    "CardKind",
    "StoriesLayout",
    "TextBlock",
    "renderCard",
    "renderCardPng",
    "storiesLayout",
    "wrapText",
]
