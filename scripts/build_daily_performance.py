#!/usr/bin/env python3
"""Build persistent 7/7 Gyan signal snapshots and intraday performance history.

Signals are detected from 125-minute candles derived from the published 15-minute
OHLCV feed using the same NSE-session bucket alignment as csv-import.js.
This is an unofficial Yahoo Finance prototype feed, not a licensed live feed.
"""
from __future__ import annotations

import csv
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
INTRADAY = DATA / "intraday_15m.csv"
SIGNALS = DATA / "daily_7of7_performance.csv"
CHARTS = DATA / "daily_7of7_chart_candles.csv"
IST = ZoneInfo("Asia/Kolkata")

SIGNAL_FIELDS = [
    "date", "symbol", "side", "pattern", "timeframe", "signal_time",
    "signal_price", "score", "entry", "stop_loss", "target",
    "entry_touched", "entry_time", "high_after_signal", "low_after_signal",
    "last_price", "close_return_pct", "max_favorable_pct", "max_adverse_pct",
    "target_hit_time", "stop_hit_time", "outcome", "updated_utc",
]
CHART_FIELDS = ["date", "symbol", "time", "open", "high", "low", "close", "volume"]


def parse_ist(value: str) -> datetime:
    stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    return stamp.astimezone(IST) if stamp.tzinfo else stamp.replace(tzinfo=IST)


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def load_intraday() -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    if not INTRADAY.exists():
        raise FileNotFoundError(f"Missing input OHLCV file: {INTRADAY}")
    with INTRADAY.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        required = {"symbol", "date", "timeframe", "open", "high", "low", "close", "volume"}
        if not required.issubset(set(reader.fieldnames or [])):
            raise ValueError("intraday_15m.csv is missing required OHLCV columns")
        for row in reader:
            if row["timeframe"].strip().lower().replace("-", "") not in {"15minute", "15min"}:
                continue
            try:
                stamp = parse_ist(row["date"])
                candle = {
                    "stamp": stamp,
                    "open": float(row["open"]), "high": float(row["high"]),
                    "low": float(row["low"]), "close": float(row["close"]),
                    "volume": float(row["volume"] or 0),
                }
            except (ValueError, TypeError):
                continue
            if candle["high"] < max(candle["open"], candle["close"], candle["low"]):
                continue
            if candle["low"] > min(candle["open"], candle["close"]):
                continue
            grouped[row["symbol"].strip().upper()].append(candle)
    for values in grouped.values():
        values.sort(key=lambda item: item["stamp"])
    return grouped


def derive_125m(source: list[dict]) -> list[dict]:
    buckets: dict[tuple[str, int], dict] = {}
    for candle in source:
        stamp = candle["stamp"]
        minute_of_day = stamp.hour * 60 + stamp.minute
        offset = minute_of_day - 555
        if offset < 0 or offset >= 375:
            continue
        bucket = offset // 125
        key = (stamp.date().isoformat(), bucket)
        start_minute = 555 + bucket * 125
        start = datetime.combine(stamp.date(), datetime.min.time(), tzinfo=IST) + timedelta(minutes=start_minute)
        current = buckets.get(key)
        if current is None:
            current = {
                "date": start, "open": candle["open"], "high": candle["high"],
                "low": candle["low"], "close": candle["close"],
                "volume": candle["volume"], "end_time": stamp + timedelta(minutes=15),
            }
            buckets[key] = current
        else:
            current["high"] = max(current["high"], candle["high"])
            current["low"] = min(current["low"], candle["low"])
            current["close"] = candle["close"]
            current["volume"] += candle["volume"]
            current["end_time"] = stamp + timedelta(minutes=15)
    result = sorted(buckets.values(), key=lambda item: item["date"])
    for candle in result:
        span = candle["high"] - candle["low"]
        candle["body_pct"] = abs(candle["close"] - candle["open"]) / span * 100 if span else 0
    return result


def find_zones(candles: list[dict], side: str) -> list[dict]:
    zones: list[dict] = []
    for start in range(1, len(candles) - 1):
        previous = candles[start - 1]
        if previous["body_pct"] <= 50:
            continue
        end = start
        while end < len(candles) and candles[end]["body_pct"] < 50:
            end += 1
        base_count = end - start
        if base_count < 1 or end >= len(candles):
            continue
        departure = candles[end]
        if departure["body_pct"] <= 50:
            start = end
            continue
        demand = departure["close"] > departure["open"]
        if (side == "demand") != demand:
            continue
        if demand and departure["close"] <= previous["close"]:
            continue
        if not demand and departure["close"] >= previous["close"]:
            continue
        base = candles[start:end]
        body_edges = [(min(c["open"], c["close"]), max(c["open"], c["close"])) for c in base]
        proximal = max(pair[1] for pair in body_edges) if demand else min(pair[0] for pair in body_edges)
        distal = min(c["low"] for c in base) if demand else max(c["high"] for c in base)
        low, high = min(proximal, distal), max(proximal, distal)
        next_candle = candles[end + 1] if end + 1 < len(candles) else None
        gap = departure["low"] > base[-1]["high"] if demand else departure["high"] < base[-1]["low"]
        second_exciting = bool(
            next_candle and next_candle["body_pct"] > 50 and
            (next_candle["close"] > next_candle["open"] if demand else next_candle["close"] < next_candle["open"])
        )
        # Snapshot freshness as it was knowable when the 7/7 setup formed.
        # Later retests must not erase a signal that was already generated.
        signal_end = end if gap else end + 1 if second_exciting else end
        revisits, was_inside = 0, False
        for future in candles[end + 1:signal_end + 1]:
            inside = future["low"] <= high and future["high"] >= low
            if inside and not was_inside:
                revisits += 1
                if revisits >= 2:
                    break
            was_inside = inside
        strength_score = 2 if gap or second_exciting else 1
        freshness_score = 3 if revisits == 0 else 1.5 if revisits == 1 else 0
        base_score = 2 if base_count <= 3 else 1 if base_count <= 5 else 0
        overlapping_prior = any(zone["high"] >= low and zone["low"] <= high for zone in zones)
        pattern = ("DBR" if previous["close"] < previous["open"] else "RBR") if demand else ("RBD" if previous["close"] > previous["open"] else "DBD")
        zones.append({
            "side": side, "low": low, "high": high, "proximal": proximal, "distal": distal,
            "start_date": base[0]["date"], "departure": departure, "departure_index": end,
            "score": freshness_score + strength_score + base_score,
            "authentic": not overlapping_prior, "pattern": pattern,
            "strength_reason": "gap" if gap else "twoCandles" if second_exciting else "singleNoGap",
            "next_candle": next_candle,
        })
        start = end
    return zones


def chart_row(signal_date: str, symbol: str, candle: dict) -> dict:
    return {
        "date": signal_date, "symbol": symbol, "time": candle["stamp"].strftime("%Y-%m-%d %H:%M:%S"),
        "open": candle["open"], "high": candle["high"], "low": candle["low"],
        "close": candle["close"], "volume": candle["volume"],
    }


def update_performance(signal: dict, bars: list[dict]) -> None:
    signal_time = parse_ist(signal["signal_time"])
    later = [bar for bar in bars if bar["stamp"] >= signal_time]
    if not later:
        return
    entry, stop, target = float(signal["entry"]), float(signal["stop_loss"]), float(signal["target"])
    side = signal["side"]
    high_after = max(bar["high"] for bar in later)
    low_after = min(bar["low"] for bar in later)
    last_price = later[-1]["close"]
    entry_index = next((i for i, bar in enumerate(later) if bar["low"] <= entry <= bar["high"]), None)
    entry_time = later[entry_index]["stamp"].strftime("%H:%M") if entry_index is not None else ""
    trade_bars = later[entry_index:] if entry_index is not None else []
    target_time = stop_time = ""
    first_exit_type = ""
    for bar in trade_bars:
        hit_target = bar["high"] >= target if side == "demand" else bar["low"] <= target
        hit_stop = bar["low"] <= stop if side == "demand" else bar["high"] >= stop
        stamp = bar["stamp"].strftime("%H:%M")
        if hit_target and not target_time:
            target_time = stamp
        if hit_stop and not stop_time:
            stop_time = stamp
        if (hit_target or hit_stop) and not first_exit_type:
            first_exit_type = "both" if hit_target and hit_stop else "target" if hit_target else "stop"
    if entry_index is None:
        favourable_close = favourable = adverse = ""
        target_bar = next((bar for bar in later if (bar["high"] >= target if side == "demand" else bar["low"] <= target)), None)
        stop_bar = next((bar for bar in later if (bar["low"] <= stop if side == "demand" else bar["high"] >= stop)), None)
        target_time = target_bar["stamp"].strftime("%H:%M") if target_bar else ""
        stop_time = stop_bar["stamp"].strftime("%H:%M") if stop_bar else ""
        if target_time and stop_time and target_time == stop_time:
            outcome = "Target and SL touched before entry in same 15m candle"
        elif target_time and (not stop_time or target_time < stop_time):
            outcome = "Target touched before entry"
        elif stop_time:
            outcome = "Stop touched before entry"
        else:
            outcome = "Entry not triggered"
    else:
        post_entry = trade_bars
        trade_high = max(bar["high"] for bar in post_entry)
        trade_low = min(bar["low"] for bar in post_entry)
        favourable_close = (last_price - entry) / entry * 100 if side == "demand" else (entry - last_price) / entry * 100
        favourable = (trade_high - entry) / entry * 100 if side == "demand" else (entry - trade_low) / entry * 100
        adverse = (entry - trade_low) / entry * 100 if side == "demand" else (trade_high - entry) / entry * 100
        if first_exit_type == "both":
            outcome = "Both touched in same 15m candle"
        elif first_exit_type == "target":
            outcome = "Target hit"
        elif first_exit_type == "stop":
            outcome = "Stop-loss hit"
        else:
            outcome = "Open"
    signal.update({
        "entry_touched": "Yes" if entry_index is not None else "No",
        "entry_time": entry_time,
        "high_after_signal": f"{high_after:.4f}",
        "low_after_signal": f"{low_after:.4f}",
        "last_price": f"{last_price:.4f}",
        "close_return_pct": "" if favourable_close == "" else f"{favourable_close:.3f}",
        "max_favorable_pct": "" if favourable == "" else f"{favourable:.3f}",
        "max_adverse_pct": "" if adverse == "" else f"{adverse:.3f}",
        "target_hit_time": target_time,
        "stop_hit_time": stop_time,
        "outcome": outcome,
        "updated_utc": datetime.now(timezone.utc).isoformat(),
    })


def main() -> int:
    source = load_intraday()
    today = datetime.now(IST).date().isoformat()
    old_signals = read_csv(SIGNALS)
    old_charts = read_csv(CHARTS)
    signals_by_key = {
        (row.get("symbol", ""), row.get("date", ""), row.get("side", ""), row.get("signal_time", "")): row
        for row in old_signals
    }
    charts_by_key = {
        (row.get("date", ""), row.get("symbol", ""), row.get("time", "")): row
        for row in old_charts
    }

    today_candidates: list[dict] = []
    for symbol, source_bars in source.items():
        bars = derive_125m(source_bars)
        if len(bars) < 3:
            continue
        analysis_bars = bars[-100:]
        for side in ("demand", "supply"):
            for zone in find_zones(analysis_bars, side):
                departure = zone["departure"]
                # A 7/7 score must be a fresh, authentic, fully qualified zone.
                if zone["score"] != 7 or not zone["authentic"]:
                    continue
                signal_time = departure["end_time"]
                if zone["strength_reason"] == "twoCandles" and zone["next_candle"]:
                    signal_time = zone["next_candle"]["end_time"]
                if signal_time.date().isoformat() != today:
                    continue
                if signal_time.hour > 15 or (signal_time.hour == 15 and signal_time.minute >= 30):
                    continue
                risk = zone["distal"] - zone["proximal"] if side == "supply" else zone["proximal"] - zone["distal"]
                if risk <= 0:
                    continue
                target = zone["proximal"] - 2 * risk if side == "supply" else zone["proximal"] + 2 * risk
                today_candidates.append({
                    "date": signal_time.date().isoformat(), "symbol": symbol, "side": side,
                    "pattern": zone["pattern"], "timeframe": "125-minute", "signal_time": signal_time.strftime("%Y-%m-%d %H:%M:%S"),
                    "signal_price": f'{departure["close"]:.4f}', "score": "7/7",
                    "entry": f'{zone["proximal"]:.4f}', "stop_loss": f'{zone["distal"]:.4f}',
                    "target": f'{target:.4f}', "entry_touched": "", "entry_time": "",
                    "high_after_signal": "", "low_after_signal": "", "last_price": "",
                    "close_return_pct": "", "max_favorable_pct": "", "max_adverse_pct": "",
                    "target_hit_time": "", "stop_hit_time": "", "outcome": "Pending",
                    "updated_utc": datetime.now(timezone.utc).isoformat(),
                })

    for candidate in today_candidates:
        key = (candidate["symbol"], candidate["date"], candidate["side"], candidate["signal_time"])
        signals_by_key.setdefault(key, candidate)

    all_signals = list(signals_by_key.values())
    signal_days = {(row["date"], row["symbol"]) for row in all_signals}
    for (signal_date, symbol) in signal_days:
        for candle in source.get(symbol, []):
            if candle["stamp"].date().isoformat() == signal_date:
                row = chart_row(signal_date, symbol, candle)
                charts_by_key[(signal_date, symbol, row["time"])] = row

    chart_rows = sorted(charts_by_key.values(), key=lambda row: (row["date"], row["symbol"], row["time"]))
    chart_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in chart_rows:
        try:
            chart_groups[(row["date"], row["symbol"])].append({
                "stamp": parse_ist(row["time"]), "open": float(row["open"]), "high": float(row["high"]),
                "low": float(row["low"]), "close": float(row["close"]), "volume": float(row["volume"]),
            })
        except (ValueError, TypeError):
            continue

    for signal in all_signals:
        update_performance(signal, chart_groups.get((signal["date"], signal["symbol"]), []))
    all_signals.sort(key=lambda row: (row["date"], row["signal_time"], row["symbol"], row["side"]), reverse=True)
    write_csv(SIGNALS, SIGNAL_FIELDS, all_signals)
    write_csv(CHARTS, CHART_FIELDS, chart_rows)
    print(f"7/7 performance: {len(today_candidates)} new candidates today; {len(all_signals)} saved signals; {len(chart_rows)} chart candles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
