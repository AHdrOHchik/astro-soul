"""CLI движка — для QA и ручных проверок.

    python -m astro.cli chart --date 1994-05-17 --time 14:20 --lat 55.7558 \\
        --lon 37.6173 --tz Europe/Moscow --name Москва --country RU
    python -m astro.cli context ...      # факты для LLM
    python -m astro.cli wheel ... --out chart.svg
    python -m astro.cli transits --date 2026-11-11 ...  # по той же карте
    python -m astro.cli hash ...

JSON печатается в stdout, предупреждения — в stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date as date_type
from datetime import time as time_type
from typing import Any

from .engine import calcChart, hashInput, llmContext, transitsFor
from .types import BirthInput, GeoPlace
from .wheel import renderWheel


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="astro", description="Астро-движок «Разбор личности»")
    parser.add_argument(
        "command", choices=["chart", "context", "wheel", "transits", "hash"], help="что считаем"
    )
    parser.add_argument("--date", required=True, help="дата рождения, YYYY-MM-DD")
    parser.add_argument("--time", help="время рождения, HH:MM; не указано — неизвестно")
    parser.add_argument("--lat", type=float, required=True, help="широта места рождения")
    parser.add_argument("--lon", type=float, required=True, help="долгота места рождения")
    parser.add_argument("--tz", required=True, help="часовой пояс, например Europe/Moscow")
    parser.add_argument("--name", default="", help="название места (в карту, не в LLM)")
    parser.add_argument("--region", default=None, help="регион")
    parser.add_argument("--country", default="RU", help="страна (ISO-2)")
    parser.add_argument("--engine", choices=["fallback", "swisseph"], default=None)
    parser.add_argument("--transit-date", default=None, help="дата транзитов, YYYY-MM-DD")
    parser.add_argument("--out", default=None, help="файл для SVG")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    place = GeoPlace(
        name=args.name,
        country=args.country,
        lat=args.lat,
        lon=args.lon,
        tz=args.tz,
        region=args.region,
    )
    birth = BirthInput(
        date=date_type.fromisoformat(args.date),
        time=time_type.fromisoformat(args.time) if args.time else None,
        place=place,
    )

    if args.command == "hash":
        payload: Any = {"input_hash": hashInput(birth, engine=args.engine)}
        _print_json(payload)
        return 0

    chart = calcChart(birth, engine=args.engine)

    if chart.omitted_planets:
        print(
            "не рассчитаны (нет файлов эфемерид): " + ", ".join(chart.omitted_planets),
            file=sys.stderr,
        )

    if args.command == "chart":
        _print_json(chart.to_dict())
    elif args.command == "context":
        _print_json(llmContext(chart))
    elif args.command == "transits":
        on_date = (
            date_type.fromisoformat(args.transit_date) if args.transit_date else birth.date
        )
        _print_json(transitsFor(on_date, chart, engine=args.engine).to_dict())
    elif args.command == "wheel":
        svg = renderWheel(chart)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(svg)
            print(f"SVG сохранён: {args.out}", file=sys.stderr)
        else:
            sys.stdout.write(svg + "\n")

    return 0


def _print_json(payload: Any) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
