"""
Astro engine — ядро для Telegram mini app «Разбор личности».
Считает натальную карту (планеты, дома, аспекты) через Swiss Ephemeris
и отдаёт компактный JSON, который дальше уходит в LLM как «факты».

Установка:  pip install pyswisseph
Запуск демо: python astro/engine.py
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime
from zoneinfo import ZoneInfo

import swisseph as swe

# Путь к файлам эфемерид (sepl_18.se1, semo_18.se1, seas_18.se1).
# В проде: положить в /app/ephe и указать SE_EPHE_PATH.
swe.set_ephe_path("astro/ephe")

# --- Справочники (ru) -------------------------------------------------------

SIGNS = [
    "Овен", "Телец", "Близнецы", "Рак", "Лев", "Дева",
    "Весы", "Скорпион", "Стрелец", "Козерог", "Водолей", "Рыбы",
]

SIGN_GLYPH = "♈♉♊♋♌♍♎♏♐♑♒♓"

PLANETS = {
    "Sun": (swe.SUN, "Солнце", "☉"),
    "Moon": (swe.MOON, "Луна", "☽"),
    "Mercury": (swe.MERCURY, "Меркурий", "☿"),
    "Venus": (swe.VENUS, "Венера", "♀"),
    "Mars": (swe.MARS, "Марс", "♂"),
    "Jupiter": (swe.JUPITER, "Юпитер", "♃"),
    "Saturn": (swe.SATURN, "Сатурн", "♄"),
    "Uranus": (swe.URANUS, "Уран", "♅"),
    "Neptune": (swe.NEPTUNE, "Нептун", "♆"),
    "Pluto": (swe.PLUTO, "Плутон", "♇"),
    "Chiron": (swe.CHIRON, "Хирон", "⚷"),
    "NorthNode": (swe.TRUE_NODE, "Узел", "☊"),
}

# Аспекты: (название, угол, допустимое отклонение, вес для «силы»)
ASPECTS = [
    ("соединение", 0, 8, 1.0),
    ("оппозиция", 180, 7, 0.9),
    ("трин", 120, 6, 0.8),
    ("квадрат", 90, 6, 0.85),
    ("секстиль", 60, 4, 0.5),
]

ELEMENTS = {
    "Овен": "Огонь", "Лев": "Огонь", "Стрелец": "Огонь",
    "Телец": "Земля", "Дева": "Земля", "Козерог": "Земля",
    "Близнецы": "Воздух", "Весы": "Воздух", "Водолей": "Воздух",
    "Рак": "Вода", "Скорпион": "Вода", "Рыбы": "Вода",
}

MODALITIES = {
    "Овен": "кардинальный", "Рак": "кардинальный", "Весы": "кардинальный", "Козерог": "кардинальный",
    "Телец": "фиксированный", "Лев": "фиксированный", "Скорпион": "фиксированный", "Водолей": "фиксированный",
    "Близнецы": "мутабельный", "Дева": "мутабельный", "Стрелец": "мутабельный", "Рыбы": "мутабельный",
}


# --- Утилиты ----------------------------------------------------------------

def sign_of(lon: float) -> str:
    return SIGNS[int(lon % 360 // 30)]


def deg_in_sign(lon: float) -> tuple[int, int]:
    x = lon % 30
    return int(x), int(round((x - int(x)) * 60))


def format_pos(lon: float) -> str:
    d, m = deg_in_sign(lon)
    return f"{d}°{m:02d}′ {sign_of(lon)}"


# --- Расчёт карты -----------------------------------------------------------

@dataclass
class Chart:
    born_at: str
    city: str
    lat: float
    lon: float
    planets: dict
    houses: dict
    aspects: list
    balances: dict

    def to_dict(self) -> dict:
        return asdict(self)


def calc_chart(
    date: str, time: str, city: str, lat: float, lon: float, tzname: str
) -> Chart:
    """date: 'YYYY-MM-DD', time: 'HH:MM' локальное, tzname: 'Europe/Moscow'."""
    local = datetime.fromisoformat(f"{date}T{time}").replace(tzinfo=ZoneInfo(tzname))
    utc = local.astimezone(ZoneInfo("UTC"))
    jd = swe.julday(
        utc.year, utc.month, utc.day, utc.hour + utc.minute / 60 + utc.second / 3600
    )

    flags = swe.FLG_SWIEPH | swe.FLG_SPEED
    planets = {}
    for key, (pid, ru, glyph) in PLANETS.items():
        res = swe.calc_ut(jd, pid, flags)[0]
        lonp, speed = res[0], res[3]
        planets[key] = {
            "name": ru,
            "glyph": glyph,
            "lon": round(lonp, 4),
            "sign": sign_of(lonp),
            "pos": format_pos(lonp),
            "retrograde": speed < 0,
            "speed": round(speed, 4),
        }

    # Дома по Плацидусу
    cusps, ascmc = swe.houses(jd, lat, lon, b"P")
    houses = {f"H{i+1}": round(c, 4) for i, c in enumerate(cusps)}
    asc, mc = ascmc[0], ascmc[1]

    # Аспекты между планетами (без узла/Хирона для чистоты)
    aspects = []
    keys = [k for k in PLANETS if k not in ("NorthNode", "Chiron")]
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            diff = abs(planets[a]["lon"] - planets[b]["lon"]) % 360
            diff = min(diff, 360 - diff)
            for name, angle, orb, weight in ASPECTS:
                delta = abs(diff - angle)
                if delta <= orb:
                    aspects.append({
                        "a": planets[a]["name"],
                        "b": planets[b]["name"],
                        "type": name,
                        "orb": round(delta, 2),
                        "strength": round(weight * (1 - delta / orb), 3),
                    })
    aspects.sort(key=lambda x: -x["strength"])

    # Баланс стихий и крестов (по 10 планетам, светила с весом 2)
    el = {k: 0.0 for k in ("Огонь", "Земля", "Воздух", "Вода")}
    mod = {k: 0.0 for k in ("кардинальный", "фиксированный", "мутабельный")}
    for k in keys:
        s = planets[k]["sign"]
        w = 2.0 if k in ("Sun", "Moon") else 1.0
        el[ELEMENTS[s]] += w
        mod[MODALITIES[s]] += w

    balances = {
        "elements": el,
        "modalities": mod,
        "dominant_element": max(el, key=el.get),
        "dominant_modality": max(mod, key=mod.get),
    }

    return Chart(
        born_at=local.isoformat(),
        city=city,
        lat=lat,
        lon=lon,
        planets=planets,
        houses={"cusp": houses, "asc": round(asc, 4), "mc": round(mc, 4),
                "asc_pos": format_pos(asc), "mc_pos": format_pos(mc)},
        aspects=aspects,
        balances=balances,
    )


# --- Компактный «контекст» для LLM -----------------------------------------

def llm_context(chart: Chart) -> dict:
    """Только факты, без интерпретаций. Модель не должна ничего вычислять."""
    p = chart.planets
    return {
        "солнце": f"{p['Sun']['pos']}",
        "луна": f"{p['Moon']['pos']}",
        "асцендент": chart.houses["asc_pos"],
        "mc": chart.houses["mc_pos"],
        "планеты": {v["name"]: v["pos"] + (" (R)" if v["retrograde"] else "")
                    for v in p.values()},
        "дома": {k: format_pos(v) for k, v in chart.houses["cusp"].items()},
        "сильнейшие_аспекты": [
            f"{a['a']} — {a['type']} — {a['b']} (орб {a['orb']}°)" for a in chart.aspects[:8]
        ],
        "стихии": chart.balances["elements"],
        "кресты": chart.balances["modalities"],
    }


# --- Отрисовка колеса (SVG) -------------------------------------------------

def render_svg(chart: Chart, size: int = 560) -> str:
    import math

    cx = cy = size / 2
    r_out = size / 2 - 4
    r_sign = r_out - 42
    r_house = r_sign - 40
    r_inner = r_house - 78

    asc = chart.houses["asc"]

    def pt(radius, deg):
        # Колесо повёрнуто так, что Асцендент всегда слева (9 часов),
        # долготы растут против часовой стрелки — стандарт натальной карты.
        a = math.radians(180 + (deg - asc))
        return cx + radius * math.cos(a), cy - radius * math.sin(a)

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
           f'width="{size}" height="{size}" font-family="DejaVu Sans, Segoe UI Symbol, Apple Symbols, Noto Sans Symbols 2, Georgia, serif">']
    out.append(f'<rect width="{size}" height="{size}" fill="#0b1020"/>')
    for r, w in ((r_out, 1.5), (r_sign, 1), (r_house, 1), (r_inner, 1)):
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="#8b7fd4" stroke-width="{w}" opacity="0.8"/>')

    # Знаки
    for i in range(12):
        deg = i * 30
        x1, y1 = pt(r_out, deg)
        x2, y2 = pt(r_inner, deg)
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#3d3a63" stroke-width="0.6"/>')
        gx, gy = pt((r_out + r_sign) / 2, deg + 15)
        col = ["#ff9f6e", "#8fd6a0", "#9fc9ff", "#a9d8e8", "#ff9f6e", "#8fd6a0",
               "#9fc9ff", "#a9d8e8", "#ff9f6e", "#8fd6a0", "#9fc9ff", "#a9d8e8"][i]
        out.append(f'<text x="{gx:.1f}" y="{gy:.1f}" fill="{col}" font-size="19" '
                   f'text-anchor="middle" dominant-baseline="central">{"♈♉♊♋♌♍♎♏♐♑♒♓"[i]}</text>')

    # Куспиды домов + номера
    for i, cusp in enumerate([chart.houses["cusp"][f"H{i+1}"] for i in range(12)], start=1):
        x1, y1 = pt(r_house, cusp)
        x2, y2 = pt(r_inner, cusp)
        bold = i in (1, 4, 7, 10)
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                   f'stroke="{"#c9c2ff" if bold else "#4a4670"}" stroke-width="{1.4 if bold else 0.6}"/>')
        nx, ny = pt(r_inner + 12, cusp + 12)
        out.append(f'<text x="{nx:.1f}" y="{ny:.1f}" fill="#7b76a8" font-size="10" '
                   f'text-anchor="middle" dominant-baseline="central">{i}</text>')

    # Планеты (с раскладкой по коллизиям)
    used = []
    for key, v in chart.planets.items():
        d = v["lon"]
        rr = r_house - 16
        for _ in range(6):
            if all(abs(((d - u + 180) % 360) - 180) > 6 for u in used) or not used:
                break
            rr -= 14
        used.append(d)
        px, py = pt(rr, d)
        out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="10" fill="#1b1c33" stroke="#8b7fd4" stroke-width="0.8"/>')
        out.append(f'<text x="{px:.1f}" y="{py:.1f}" fill="#efe9ff" font-size="13" '
                   f'text-anchor="middle" dominant-baseline="central">{v["glyph"]}</text>')
        dx, dy = pt(rr - 14, d)
        out.append(f'<text x="{dx:.1f}" y="{dy:.1f}" fill="#9d97c9" font-size="8" '
                   f'text-anchor="middle" dominant-baseline="central">'
                   f'{deg_in_sign(d)[0]}°{"R" if v["retrograde"] else ""}</text>')

    # Аспекты внутри круга
    style = {"соединение": ("#ffd479", 1.2), "оппозиция": ("#ff7a7a", 1.0),
             "трин": ("#6ee7a8", 1.0), "квадрат": ("#ff8a5c", 1.0), "секстиль": ("#7cc6ff", 0.8)}
    for a in chart.aspects[:22]:
        pa = next(v for v in chart.planets.values() if v["name"] == a["a"])
        pb = next(v for v in chart.planets.values() if v["name"] == a["b"])
        x1, y1 = pt(r_inner - 6, pa["lon"])
        x2, y2 = pt(r_inner - 6, pb["lon"])
        col, w = style[a["type"]]
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                   f'stroke="{col}" stroke-width="{w}" opacity="{0.25 + a["strength"] * 0.6:.2f}"/>')

    out.append(f'<text x="{cx}" y="{cy + 6}" fill="#5d5890" font-size="12" text-anchor="middle">'
               f'{chart.city}</text>')
    out.append("</svg>")
    return "\n".join(out)


if __name__ == "__main__":
    chart = calc_chart("1994-05-17", "14:20", "Москва", 55.7558, 37.6173, "Europe/Moscow")
    print(json.dumps(llm_context(chart), ensure_ascii=False, indent=2))
    with open("astro/chart_sample.svg", "w", encoding="utf-8") as f:
        f.write(render_svg(chart))
    print("\nSVG сохранён: astro/chart_sample.svg")
