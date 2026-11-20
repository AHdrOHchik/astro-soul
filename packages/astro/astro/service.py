"""HTTP-сайдкар астро-движка (FastAPI + uvicorn).

Слушает только localhost: API (NestJS) ходит сюда по `ASTRO_SERVICE_URL`.
Эфемериды локальные, наружу сервис ничего не отправляет.

    python -m uvicorn astro.service:app --host 127.0.0.1 --port 8001
    # или: astro-service

Эндпоинты:
    GET  /health      — живость и версия движка
    POST /chart       — натальная карта (контракт + внутренние числа + хеш входа)
    POST /transits    — транзиты на дату по сохранённой карте
    POST /wheel       — SVG-колесо (тема dark|light)
    POST /synastry    — факты совместимости двух карт (`compatibility_facts` v1.0)
    POST /forecast/facts — детерминированные факты дня (итерация 30)
    POST /wheel/png   — колесо растром (PDF, карточки шеринга; итерация 32)
    POST /pdf/build   — PDF разбора: обложка, оглавление, главы, колонтитул
    POST /card/build  — карточка шеринга 9:16 или 1:1, без ПДн

Почему PDF и карточки собираются здесь, а не в Node: PDF — это текст с
встроенным шрифтом и картинкой, а карточка — растр. В Python это Pillow и
reportlab, в Node пришлось бы тянуть шрифтовой стек и растеризатор SVG.
Ни один из этих маршрутов не ходит в сеть и не вызывает модель.
"""

from __future__ import annotations

import base64
import os
import time
from datetime import date as date_type
from datetime import time as time_type
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .cards import CARD_SIZES, renderCardPng
from .constants import DEFAULT_ENGINE_MODE, ENGINE_VERSION
from .daily import ForecastConfigError, day_facts
from .engine import EngineConfigError, calcChart, transitsFor
from .pdf import MAX_PDF_BYTES, PdfBuildError, PdfChapter, PdfSpec, buildPdf
from .synastry import compatFacts
from .types import BirthInput, Chart, GeoPlace
from .wheel import WHEEL_THEMES, renderWheel
from .wheel_png import renderWheelPng
from .wire import chart_from_wire, chart_to_wire

app = FastAPI(
    title="Astro engine sidecar",
    version=ENGINE_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class PlaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    region: str | None = None
    country: str = Field(min_length=2, max_length=2)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    tz: str = Field(min_length=1, max_length=64)


class ChartIn(BaseModel):
    birth_date: date_type
    birth_time: time_type | None = None
    birth_place: PlaceIn
    time_precision: Literal["exact", "approximate", "unknown"] | None = None
    engine: Literal["fallback", "swisseph"] | None = None


class ChartDataIn(BaseModel):
    """То, что API хранит в `charts.data`."""

    chart: dict[str, Any]
    internal: dict[str, Any]
    omitted_planets: list[str] = Field(default_factory=list)


class TransitsIn(BaseModel):
    date: date_type
    data: ChartDataIn
    engine: Literal["fallback", "swisseph"] | None = None


class SynastryIn(BaseModel):
    """Две уже посчитанные карты: своя и партнёра.

    ПДн здесь нет: в запросе только то, что API хранит в `charts.data`
    (положения, дома, аспекты). Поэтому и логировать нечего, кроме факта
    вызова; идентификаторы пишет API, а не сайдкар.
    """

    a: ChartDataIn
    b: ChartDataIn


class ForecastFactsIn(BaseModel):
    """Факты дня: дата, часовой пояс места рождения и сохранённая карта.

    Пояс — именно место рождения, а не текущее местоположение: «сегодня»
    начинается там, где человек родился. Это не техническая деталь, а смысл
    поля, поэтому она повторена в описании маршрута и в `timezone_note`.
    """

    date: date_type
    timezone: str = Field(min_length=1, max_length=64)
    data: ChartDataIn


class WheelIn(BaseModel):
    data: ChartDataIn
    theme: str = "dark"
    size: int = Field(default=560, ge=320, le=1200)


class PdfChapterIn(BaseModel):
    """Глава разбора. Абзацы приходят уже разбитыми: PDF — не markdown-парсер."""

    title: str = Field(min_length=1, max_length=120)
    paragraphs: list[str] = Field(default_factory=list, max_length=40)


class PdfBuildIn(BaseModel):
    """Вход сборки PDF.

    Ни одного поля с ПДн здесь нет и быть не может: `subtitle` — это дата
    сборки, а не дата рождения. Тест проверяет, что в готовом файле нет
    персональных данных, потому что их просто не из чего собрать.
    """

    subtitle: str = Field(min_length=1, max_length=120)
    chapters: list[PdfChapterIn] = Field(min_length=1, max_length=12)
    actions: list[str] = Field(default_factory=list, max_length=5)
    link: str | None = Field(default=None, max_length=120)
    wheel_png_base64: str | None = None
    title: str = Field(default="Твой разбор", min_length=1, max_length=80)
    footer: str = Field(
        default="Разбор — инструмент саморефлексии, не предсказание",
        min_length=1,
        max_length=200,
    )
    max_bytes: int = Field(default=MAX_PDF_BYTES, ge=64_000, le=64 * 1024 * 1024)


class CardBuildIn(BaseModel):
    """Вход карточки шеринга.

    `lines` — строки, которые API уже проверил: ни даты рождения, ни места, ни
    имени. Сайдкар не умеет добавлять что-то от себя, кроме подписи-ссылки,
    поэтому «случайных» ПДн в картинке взяться неоткуда.
    """

    kind: Literal["day", "wheel", "insight"]
    title: str = Field(min_length=1, max_length=200)
    lines: list[str] = Field(default_factory=list, max_length=8)
    footer: str | None = Field(default=None, max_length=120)
    wheel_png_base64: str | None = None
    moon_illumination: float | None = Field(default=None, ge=0, le=1)


def _engine_error(error: EngineConfigError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(error))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engine_version": ENGINE_VERSION,
        "engine_mode": os.environ.get("ASTRO_ENGINE", DEFAULT_ENGINE_MODE),
    }


@app.post("/chart")
def chart(payload: ChartIn) -> dict[str, Any]:
    # «Не знаю времени» с указанным временем — противоречие, а не повод угадывать.
    if payload.time_precision == "unknown" and payload.birth_time is not None:
        raise HTTPException(
            status_code=422,
            detail="time_precision=unknown требует birth_time=null",
        )

    birth = BirthInput(
        date=payload.birth_date,
        time=payload.birth_time,
        place=GeoPlace(**payload.birth_place.model_dump()),
        time_precision=payload.time_precision,
    )
    try:
        result = calcChart(birth, engine=payload.engine)
    except EngineConfigError as error:
        raise _engine_error(error) from error

    return chart_to_wire(result, engine_mode=result.engine_mode)


@app.post("/transits")
def transits(payload: TransitsIn) -> dict[str, Any]:
    try:
        natal = chart_from_wire(
            {
                "chart": payload.data.chart,
                "internal": payload.data.internal,
                "omitted_planets": payload.data.omitted_planets,
            }
        )
        report = transitsFor(payload.date, natal, engine=payload.engine)
    except (EngineConfigError, KeyError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return report.to_dict()


def _chart_of(payload: ChartDataIn) -> Chart:
    return chart_from_wire(
        {
            "chart": payload.chart,
            "internal": payload.internal,
            "omitted_planets": payload.omitted_planets,
        }
    )


@app.post("/synastry")
def synastry(payload: SynastryIn) -> dict[str, Any]:
    try:
        facts = compatFacts(_chart_of(payload.a), _chart_of(payload.b))
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return facts


@app.post("/forecast/facts")
def forecast_facts(payload: ForecastFactsIn) -> dict[str, Any]:
    """Детерминированные факты дня — без модели и без сети.

    Один и тот же вход даёт побайтово один и тот же JSON: ни времени процесса,
    ни случайности здесь нет. Поэтому API может кэшировать ответ и сравнивать
    прогоны между собой.
    """
    try:
        facts = day_facts(payload.date, payload.timezone, _chart_of(payload.data))
    except ForecastConfigError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return facts


@app.post("/wheel")
def wheel(payload: WheelIn) -> dict[str, str]:
    if payload.theme not in WHEEL_THEMES:
        raise HTTPException(status_code=422, detail=f"неизвестная тема колеса: {payload.theme}")

    try:
        natal = chart_from_wire(
            {
                "chart": payload.data.chart,
                "internal": payload.data.internal,
                "omitted_planets": payload.data.omitted_planets,
            }
        )
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return {"svg": renderWheel(natal, size=payload.size, theme=payload.theme)}


@app.post("/wheel/png")
def wheel_png(payload: WheelIn) -> dict[str, Any]:
    """Колесо растром: PDF-обложка и карточка `wheel`.

    Отдельный маршрут, а не «SVG плюс растеризатор»: в контейнере сайдкара нет
    librsvg/cairo, и добавлять системную библиотеку ради картинки — лишняя
    точка отказа. Колесо рисуется тем же Pillow из тех же чисел движка.
    """
    if payload.theme not in WHEEL_THEMES:
        raise HTTPException(status_code=422, detail=f"неизвестная тема колеса: {payload.theme}")

    try:
        natal = _chart_of(payload.data)
        png = renderWheelPng(natal, size=payload.size, theme=payload.theme)
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return {
        "png_base64": base64.b64encode(png).decode("ascii"),
        "bytes": len(png),
        "width": payload.size,
        "height": payload.size,
    }


@app.post("/pdf/build")
def pdf_build(payload: PdfBuildIn) -> dict[str, Any]:
    wheel: bytes | None = None
    if payload.wheel_png_base64:
        try:
            wheel = base64.b64decode(payload.wheel_png_base64, validate=True)
        except ValueError as error:
            raise HTTPException(status_code=422, detail="wheel_png_base64: не base64") from error

    spec = PdfSpec(
        subtitle=payload.subtitle,
        chapters=tuple(
            PdfChapter(title=chapter.title, paragraphs=tuple(chapter.paragraphs))
            for chapter in payload.chapters
        ),
        actions=tuple(payload.actions),
        link=payload.link,
        wheel_png=wheel,
        title=payload.title,
        footer=payload.footer,
        max_bytes=payload.max_bytes,
    )

    started = time.monotonic()
    try:
        result = buildPdf(spec)
    except PdfBuildError as error:
        raise HTTPException(status_code=422, detail=f"pdf_failed: {error}") from error

    return {
        "pdf_base64": base64.b64encode(result.pdf).decode("ascii"),
        "bytes": len(result.pdf),
        "pages": result.pages,
        "wheel_scale": result.wheel_scale,
        "attempts": result.attempts,
        "build_ms": result.build_ms,
        "total_ms": round((time.monotonic() - started) * 1000),
    }


@app.post("/card/build")
def card_build(payload: CardBuildIn) -> dict[str, Any]:
    wheel: bytes | None = None
    if payload.wheel_png_base64:
        try:
            wheel = base64.b64decode(payload.wheel_png_base64, validate=True)
        except ValueError as error:
            raise HTTPException(status_code=422, detail="wheel_png_base64: не base64") from error

    try:
        png = renderCardPng(
            payload.kind,
            payload.title,
            list(payload.lines),
            footer=payload.footer,
            wheel_png=wheel,
            moon_illumination=payload.moon_illumination,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    width, height = CARD_SIZES[payload.kind]
    return {
        "png_base64": base64.b64encode(png).decode("ascii"),
        "bytes": len(png),
        "width": width,
        "height": height,
    }


def main() -> None:
    import uvicorn

    uvicorn.run(
        "astro.service:app",
        host=os.environ.get("ASTRO_HOST", "127.0.0.1"),
        port=int(os.environ.get("ASTRO_PORT", "8001")),
        log_level=os.environ.get("ASTRO_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
