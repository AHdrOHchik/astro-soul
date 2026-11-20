"""PDF разбора: обложка, оглавление, главы, колонтитул, «Что сделать».

Документ уходит из приложения: его распечатывают, пересылают, показывают
другому человеку. Из этого следуют три правила, которые здесь и зашиты:

  1. **Никаких ПДн.** Ни имени, ни даты/время рождения, ни города, ни
     координат — в документ попадают только главы разбора, дата сборки и
     ссылка на бота. Поэтому в PDF нет ни «шапки профиля», ни водяных знаков
     с датой рождения.
  2. **Дисклеймер на каждой странице.** Не дублирование, а обязательное
     присутствие: отдельный лист живёт без приложения, и подпись «это
     инструмент саморефлексии, не предсказание» должна быть на нём самом.
  3. **Встроенный шрифт.** `astro/fonts.py`: без него кириллица превращается
     в квадраты, и человек получает нечитаемый оплаченный документ.

Сборка — CPU, без модели: ни одного вызова LLM здесь нет.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from io import BytesIO
from typing import Final
from xml.sax.saxutils import escape

from PIL import Image as PilImage
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
)

from .fonts import registerPdfFonts

#: Потолок размера файла из задания. Достигается уменьшением колеса, а не
#: отказом: PDF без колеса лучше, чем «не удалось собрать».
MAX_PDF_BYTES: Final[int] = 12 * 1024 * 1024

#: Единственная подпись-дисклеймер продукта. Одна константа на все продукты:
#: разные формулировки в PDF и в приложении читаются как разные обещания.
FOOTER_TEXT: Final[str] = "Разбор — инструмент саморефлексии, не предсказание"

#: Заголовок документа. Не имя и не «разбор для …»: документ передают дальше.
DOCUMENT_TITLE: Final[str] = "Твой разбор"

#: Ступени уменьшения колеса при превышении потолка байт.
WHEEL_SCALES: Final[tuple[float, ...]] = (1.0, 0.6, 0.35, 0.0)


class PdfBuildError(RuntimeError):
    """Сборка невозможна (нет глав, битый PNG). Код уходит в `pdf_failed`."""


@dataclass(frozen=True, slots=True)
class PdfChapter:
    title: str
    paragraphs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PdfSpec:
    """Вход сборки. Строки уже безопасны: их подготовил API."""

    subtitle: str
    chapters: tuple[PdfChapter, ...]
    actions: tuple[str, ...] = ()
    link: str | None = None
    wheel_png: bytes | None = None
    title: str = DOCUMENT_TITLE
    footer: str = FOOTER_TEXT
    max_bytes: int = MAX_PDF_BYTES


@dataclass(frozen=True, slots=True)
class PdfResult:
    pdf: bytes
    pages: int
    wheel_scale: float
    build_ms: int
    #: Диагностика для лога: сколько раз пришлось уменьшать колесо.
    attempts: int = field(default=0)


def _styles() -> dict[str, ParagraphStyle]:
    regular, bold = registerPdfFonts()

    return {
        "cover_title": ParagraphStyle(
            "cover_title",
            fontName=bold,
            fontSize=34,
            leading=42,
            alignment=TA_CENTER,
            spaceAfter=6 * mm,
        ),
        "cover_subtitle": ParagraphStyle(
            "cover_subtitle",
            fontName=regular,
            fontSize=13,
            leading=18,
            alignment=TA_CENTER,
            textColor="#5d5890",
            spaceAfter=10 * mm,
        ),
        "h1": ParagraphStyle(
            "h1",
            fontName=bold,
            fontSize=21,
            leading=26,
            spaceAfter=6 * mm,
        ),
        "h2": ParagraphStyle(
            "h2",
            fontName=bold,
            fontSize=15,
            leading=20,
            spaceAfter=3 * mm,
        ),
        "body": ParagraphStyle(
            "body",
            fontName=regular,
            fontSize=12.5,
            leading=19,
            alignment=TA_JUSTIFY,
            spaceAfter=4 * mm,
        ),
        "toc": ParagraphStyle(
            "toc",
            fontName=regular,
            fontSize=13,
            leading=22,
        ),
        "action": ParagraphStyle(
            "action",
            fontName=regular,
            fontSize=12.5,
            leading=19,
            spaceAfter=3 * mm,
            leftIndent=6 * mm,
        ),
        "link": ParagraphStyle(
            "link",
            fontName=regular,
            fontSize=12,
            leading=18,
            alignment=TA_CENTER,
            textColor="#6b5fb5",
            spaceBefore=8 * mm,
        ),
    }


class _Document(BaseDocTemplate):
    """Документ с колонтитулом на каждой странице.

    `onPage` вызывается для каждой страницы, включая обложку: подпись нужна
    именно там, где лист отрывается от приложения.
    """

    def __init__(self, buffer: BytesIO, footer: str) -> None:
        super().__init__(
            buffer,
            pagesize=A4,
            leftMargin=22 * mm,
            rightMargin=22 * mm,
            topMargin=20 * mm,
            bottomMargin=22 * mm,
            title=DOCUMENT_TITLE,
            # Автор намеренно пустой: имя человека в метаданные не попадает.
            author="",
            subject=footer,
            creator="astro-soul",
        )
        self._footer = footer
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
        )
        self.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=self._draw_footer)])

    def _draw_footer(self, canvas, doc) -> None:  # noqa: ANN001 - подпись reportlab
        canvas.saveState()
        canvas.setFont(registerPdfFonts()[0], 7.5)
        canvas.setFillColorRGB(0.42, 0.41, 0.55)
        canvas.drawCentredString(
            A4[0] / 2,
            12 * mm,
            self._footer,
        )
        canvas.restoreState()


def _resample(png: bytes, scale: float) -> bytes:
    """Уменьшает саму картинку, а не размер её отрисовки.

    Важная деталь: `drawWidth` в reportlab меняет только рамку, а в PDF всё
    равно уезжает исходный XObject — файл не становится меньше. Поэтому при
    превышении потолка пересжимаем растр (Pillow), и только потом вставляем.
    """
    if scale >= 1:
        return png

    source = PilImage.open(BytesIO(png)).convert("RGB")
    target = max(160, round(source.width * scale))
    resized = source.resize((target, target), PilImage.LANCZOS)
    buffer = BytesIO()
    # JPEG, а не уменьшенный PNG: интерполяция добавляет градиенты, и PNG
    # после ресайза сжимается хуже исходника (проверено: 78 КБ → 110 КБ).
    # JPEG на плоской графике даёт десятки килобайт и в PDF уходит как есть.
    resized.save(buffer, format="JPEG", quality=82, optimize=True)
    return buffer.getvalue()


def _wheel_flowable(wheel_png: bytes | None, scale: float, max_width: float):
    if wheel_png is None or scale <= 0:
        return []

    try:
        data = _resample(wheel_png, scale)
        image = Image(BytesIO(data))
    except Exception as error:  # noqa: BLE001 - битый PNG это не повод падать стеком
        raise PdfBuildError("wheel_png") from error

    ratio = image.imageHeight / image.imageWidth if image.imageWidth else 1
    width = max_width * min(1.0, max(scale, 0.5))
    image.drawWidth = width
    image.drawHeight = width * ratio
    image.hAlign = "CENTER"
    return [image, Spacer(1, 8 * mm)]


def _story(spec: PdfSpec, styles: dict[str, ParagraphStyle], scale: float) -> list:
    story: list = [
        Spacer(1, 14 * mm),
        Paragraph(escape(spec.title), styles["cover_title"]),
        Paragraph(escape(spec.subtitle), styles["cover_subtitle"]),
    ]
    story += _wheel_flowable(spec.wheel_png, scale, A4[0] - 44 * mm)
    story.append(PageBreak())

    story.append(Paragraph("Оглавление", styles["h1"]))
    for index, chapter in enumerate(spec.chapters, start=1):
        story.append(
            Paragraph(f"{index}. {escape(chapter.title)}", styles["toc"]),
        )
    story.append(PageBreak())

    for index, chapter in enumerate(spec.chapters, start=1):
        story.append(Paragraph(f"{index}. {escape(chapter.title)}", styles["h1"]))
        for paragraph in chapter.paragraphs:
            story.append(Paragraph(escape(paragraph), styles["body"]))
        if index < len(spec.chapters):
            story.append(PageBreak())

    if spec.actions:
        story.append(PageBreak())
        story.append(Paragraph("Что сделать", styles["h1"]))
        for index, action in enumerate(spec.actions, start=1):
            story.append(Paragraph(f"{index}. {escape(action)}", styles["action"]))

    if spec.link:
        story.append(Paragraph(escape(spec.link), styles["link"]))

    return story


def _build_once(spec: PdfSpec, scale: float) -> tuple[bytes, int]:
    styles = _styles()
    buffer = BytesIO()
    document = _Document(buffer, spec.footer)
    document.build(_story(spec, styles, scale))
    return buffer.getvalue(), document.page


def buildPdf(spec: PdfSpec) -> PdfResult:
    """Собирает PDF и держит потолок `max_bytes` за счёт качества колеса.

    Уменьшаем не текст (он и есть товар), а картинку: колесо на обложке —
    единственный тяжёлый объект. Если даже без колеса файл больше потолка,
    это ошибка данных, а не повод отдать 12 МБ.
    """
    if not spec.chapters:
        raise PdfBuildError("no_chapters")

    started = time.monotonic()

    for attempts, scale in enumerate(WHEEL_SCALES, start=1):
        pdf, pages = _build_once(spec, scale)
        if len(pdf) <= spec.max_bytes:
            return PdfResult(
                pdf=pdf,
                pages=pages,
                wheel_scale=scale,
                build_ms=round((time.monotonic() - started) * 1000),
                attempts=attempts,
            )

    raise PdfBuildError("too_large")


__all__ = [
    "DOCUMENT_TITLE",
    "FOOTER_TEXT",
    "MAX_PDF_BYTES",
    "PdfBuildError",
    "PdfChapter",
    "PdfResult",
    "PdfSpec",
    "buildPdf",
]
