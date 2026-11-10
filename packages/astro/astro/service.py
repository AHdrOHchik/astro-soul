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
"""

from __future__ import annotations

import os
from datetime import date as date_type
from datetime import time as time_type
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .constants import DEFAULT_ENGINE_MODE, ENGINE_VERSION
from .engine import EngineConfigError, calcChart, transitsFor
from .types import BirthInput, GeoPlace
from .wheel import WHEEL_THEMES, renderWheel
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


class WheelIn(BaseModel):
    data: ChartDataIn
    theme: str = "dark"
    size: int = Field(default=560, ge=320, le=1200)


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
    birth = BirthInput(
        date=payload.birth_date,
        time=payload.birth_time,
        place=GeoPlace(**payload.birth_place.model_dump()),
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
