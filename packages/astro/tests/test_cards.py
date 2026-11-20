"""Карточки шеринга и PNG-колесо: размеры, отсутствие EXIF, детерминизм.

Проверки намеренно «жёсткие», а не «картинка создалась»:
  * размеры из задания (9:16 и 1:1) — иначе Telegram обрежет композицию;
  * в PNG нет ни EXIF, ни текстовых чанков — карточка уходит наружу, и
    метаданные в ней это ПДн, которых там быть не должно;
  * один вход даёт одни байты — иначе кэш по хешу содержимого не работает;
  * кириллица действительно нарисована (в карточке есть тёмные и светлые
    пиксели, а не пустой фон).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from astro import BirthInput, calcChart
from astro.cards import CARD_SIZES, renderCardPng
from astro.service import app
from astro.wheel_png import renderWheelPng

client = TestClient(app)

BIRTH = {
    "birth_date": "1994-05-17",
    "birth_time": "14:20",
    "birth_place": {
        "name": "Тестоград",
        "region": None,
        "country": "RU",
        "lat": 55.7558,
        "lon": 37.6173,
        "tz": "Europe/Moscow",
    },
}


def _open(png: bytes) -> Image.Image:
    from io import BytesIO

    return Image.open(BytesIO(png))


def test_wheel_png_is_png_and_has_no_exif(known_birth: BirthInput) -> None:
    png = renderWheelPng(calcChart(known_birth), size=520)

    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    image = _open(png)
    assert image.size == (520, 520)
    assert image.getexif() == {}
    # Текстовые/EXIF-чанки в PNG: eXIf, tEXt, zTXt, iTXt.
    for chunk in (b"eXIf", b"tEXt", b"zTXt", b"iTXt"):
        assert chunk not in png


def test_wheel_png_is_deterministic(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)

    assert renderWheelPng(chart, size=420) == renderWheelPng(chart, size=420)


def test_wheel_png_differs_by_theme(known_birth: BirthInput) -> None:
    chart = calcChart(known_birth)

    light = renderWheelPng(chart, size=360, theme="light")
    dark = renderWheelPng(chart, size=360, theme="dark")

    assert light != dark


def test_wheel_png_rejects_unknown_theme(known_birth: BirthInput) -> None:
    with pytest.raises(ValueError):
        renderWheelPng(calcChart(known_birth), theme="neon")


@pytest.mark.parametrize("kind", ["day", "wheel", "insight"])
def test_card_sizes_follow_contract(kind: str) -> None:
    png = renderCardPng(kind, "Луна в Рыбах", ["Сегодня хорошо для тихих разговоров."])

    assert _open(png).size == CARD_SIZES[kind]


def test_day_card_has_no_metadata_and_draws_cyrillic() -> None:
    png = renderCardPng(
        "day",
        "Луна в Рыбах, растущая",
        ["Сегодня хорошо для объёма и «ёлки».", "Освещённость 68%", "20 ноября 2026"],
        footer="t.me/astro_soul_bot?start=sh_k7m2p9",
        moon_illumination=0.68,
    )

    for chunk in (b"eXIf", b"tEXt", b"zTXt", b"iTXt"):
        assert chunk not in png

    image = _open(png).convert("L")
    histogram = image.histogram()
    light = sum(histogram[200:])
    # Текст и луна занимают заметную долю: пустой градиент дал бы почти ноль.
    assert light > 2_000, "на карточке нет светлых пикселей — текст не нарисован"


def test_card_is_deterministic() -> None:
    first = renderCardPng("insight", "«Ты держишь темп»", ["Тихо и по-честному."])
    second = renderCardPng("insight", "«Ты держишь темп»", ["Тихо и по-честному."])

    assert first == second


def test_card_changes_with_content() -> None:
    first = renderCardPng("insight", "«Ты держишь темп»", ["Тихо и по-честному."])
    second = renderCardPng("insight", "«Ты держишь темп»", ["Громко и по-спортивному."])

    assert first != second


def test_card_wheel_variant_pastes_wheel(known_birth: BirthInput) -> None:
    wheel = renderWheelPng(calcChart(known_birth), size=520, theme="dark")

    with_wheel = renderCardPng("wheel", "Моя натальная карта", [], wheel_png=wheel)
    without = renderCardPng("wheel", "Моя натальная карта", [])

    assert with_wheel != without
    assert _open(with_wheel).size == (1080, 1920)


def test_wheel_card_has_no_date_time_or_place(known_birth: BirthInput) -> None:
    """Карточка колеса — без даты, времени и места рождения (даже в байтах)."""
    wheel = renderWheelPng(calcChart(known_birth), size=520, theme="dark")
    png = renderCardPng(
        "wheel",
        "Моя натальная карта",
        [],
        footer="t.me/astro_soul_bot?start=sh_k7m2p9",
        wheel_png=wheel,
    )

    for chunk in (b"eXIf", b"tEXt", b"zTXt", b"iTXt"):
        assert chunk not in png

    # Ни даты рождения, ни времени, ни названия города: колесо — это углы, а не
    # данные человека. Проверяем именно байты файла, а не «что мы туда клали».
    for needle in (b"1994", b"14:20", "Тестоград".encode()):
        assert needle not in png


def test_service_wheel_png_route() -> None:
    chart = client.post("/chart", json=BIRTH).json()

    response = client.post(
        "/wheel/png",
        json={"data": chart, "theme": "light", "size": 360},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["bytes"] > 1_000
    assert body["width"] == 360


def test_service_wheel_png_rejects_bad_theme() -> None:
    chart = client.post("/chart", json=BIRTH).json()

    response = client.post("/wheel/png", json={"data": chart, "theme": "neon"})

    assert response.status_code == 422


def test_service_pdf_build_route() -> None:
    chart = client.post("/chart", json=BIRTH).json()
    wheel = client.post("/wheel/png", json={"data": chart, "theme": "light", "size": 360}).json()

    response = client.post(
        "/pdf/build",
        json={
            "subtitle": "Собрано 20 ноября 2026",
            "chapters": [{"title": "Ядро", "paragraphs": ["Первый абзац с «ё» и тире — вот так."]}],
            "actions": ["Выпиши два варианта"],
            "link": "t.me/astro_soul_bot",
            "wheel_png_base64": wheel["png_base64"],
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["bytes"] > 1_000
    assert body["pages"] >= 3
    assert body["wheel_scale"] == 1.0


def test_service_pdf_build_rejects_empty_chapters() -> None:
    response = client.post(
        "/pdf/build",
        json={"subtitle": "Собрано 20 ноября 2026", "chapters": []},
    )

    assert response.status_code == 422


def test_service_pdf_build_rejects_broken_wheel_base64() -> None:
    response = client.post(
        "/pdf/build",
        json={
            "subtitle": "Собрано 20 ноября 2026",
            "chapters": [{"title": "Ядро", "paragraphs": ["Текст."]}],
            "wheel_png_base64": "не-base64",
        },
    )

    assert response.status_code == 422


def test_service_card_build_route() -> None:
    response = client.post(
        "/card/build",
        json={
            "kind": "insight",
            "title": "«Ты держишь темп»",
            "lines": ["Тихо и по-честному."],
            "footer": "t.me/astro_soul_bot?start=sh_k7m2p9",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["width"], body["height"]) == (1080, 1080)
    assert body["bytes"] > 1_000


def test_service_card_build_rejects_unknown_kind() -> None:
    response = client.post("/card/build", json={"kind": "compat", "title": "Пара", "lines": []})

    assert response.status_code == 422
