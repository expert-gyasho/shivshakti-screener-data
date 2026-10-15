#!/usr/bin/env python3
"""Refresh Shivshakti Trader CSV data.

Prototype data source: Yahoo Finance chart data via yfinance (unofficial).
Default universe: NIFTY 500 constituents. This is not an exchange-licensed feed.
For production/commercial redistribution, replace the provider adapter with a
licensed broker/data-vendor API and comply with its terms.
"""
from __future__ import annotations

import io
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
CANDLES_PATH = ROOT / "candles.csv"
INTRADAY_PATH = DATA_DIR / "intraday_15m.csv"
DAILY_PATH = DATA_DIR / "daily_ohlcv.csv"
STATUS_PATH = ROOT / "status.json"
UNIVERSE_URL = os.getenv(
    "NIFTY500_CSV_URL",
    "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
)
CHUNK_SIZE = int(os.getenv("DOWNLOAD_CHUNK_SIZE", "40"))
DAILY_PERIOD = os.getenv("DAILY_PERIOD", "5y")
INTRADAY_PERIOD = os.getenv("INTRADAY_PERIOD", "5d")
USER_AGENT = "Mozilla/5.0 ShivshaktiTraderDataPipeline/1.0"


def get_symbols() -> list[str]:
    """Fetch the NIFTY 500 constituent list and convert symbols to Yahoo format."""
    response = requests.get(
        UNIVERSE_URL,
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()
    frame = pd.read_csv(io.BytesIO(response.content))
    symbol_col = next((c for c in frame.columns if str(c).strip().lower() in {"symbol", "symbol "}), None)
    if not symbol_col:
        raise RuntimeError(f"Could not find Symbol column in universe CSV: {list(frame.columns)}")
    symbols = (
        frame[symbol_col].dropna().astype(str).str.strip().str.upper()
        .replace("", pd.NA).dropna().drop_duplicates().tolist()
    )
    if not symbols:
        raise RuntimeError("The market universe returned no symbols.")
    return [f"{symbol}.NS" for symbol in symbols]


def get_ticker_frame(download: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """Handle yfinance's multi-index column order across versions."""
    if download is None or download.empty:
        return pd.DataFrame()
    if isinstance(download.columns, pd.MultiIndex):
        if ticker in download.columns.get_level_values(0):
            frame = download[ticker].copy()
        elif ticker in download.columns.get_level_values(-1):
            frame = download.xs(ticker, axis=1, level=-1).copy()
        else:
            return pd.DataFrame()
    else:
        frame = download.copy()
    frame.columns = [str(c).strip().lower().replace(" ", "_") for c in frame.columns]
    required = ["open", "high", "low", "close", "volume"]
    if not all(col in frame.columns for col in required):
        return pd.DataFrame()
    frame = frame[required].copy()
    # Normalize every Yahoo timestamp to naive Asia/Kolkata time. Saved CSV
    # dates are local and timezone-naive; mixing them with Yahoo's timezone-
    # aware index breaks the next incremental merge on later scheduled runs.
    if getattr(frame.index, "tz", None) is not None:
        frame.index = frame.index.tz_convert("Asia/Kolkata").tz_localize(None)
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    frame = frame.dropna(subset=["open", "high", "low", "close"])
    return frame


def download_history(tickers: list[str], period: str, interval: str) -> dict[str, pd.DataFrame]:
    output: dict[str, pd.DataFrame] = {}
    for start in range(0, len(tickers), CHUNK_SIZE):
        chunk = tickers[start : start + CHUNK_SIZE]
        print(f"Downloading {interval} {start + 1}-{start + len(chunk)} of {len(tickers)}")
        try:
            raw = yf.download(
                tickers=chunk,
                period=period,
                interval=interval,
                group_by="ticker",
                auto_adjust=False,
                actions=False,
                threads=True,
                progress=False,
                timeout=25,
                prepost=False,
                repair=False,  # Avoid yfinance's optional scikit-learn repair dependency; validate OHLCV ourselves.
            )
        except Exception as exc:
            print(f"Chunk failed ({interval}): {exc}", file=sys.stderr)
            continue
        for ticker in chunk:
            frame = get_ticker_frame(raw, ticker)
            if not frame.empty:
                output[ticker] = frame
    return output


def rows_for_timeframe(symbol: str, frame: pd.DataFrame, timeframe: str) -> list[dict]:
    if frame.empty:
        return []
    out = frame.reset_index()
    date_col = out.columns[0]
    result = []
    for _, row in out.iterrows():
        stamp = pd.Timestamp(row[date_col])
        if stamp.tzinfo is not None:
            stamp = stamp.tz_convert("Asia/Kolkata").tz_localize(None)
        # Preserve intraday candle times; date-only values collapse all
        # 15-minute bars from the same session into a single deduplicated row.
        date_value = stamp.strftime("%Y-%m-%d %H:%M:%S") if timeframe == "15-Minute" else stamp.strftime("%Y-%m-%d")
        result.append({
            "symbol": symbol,
            "date": date_value,
            "timeframe": timeframe,
            "open": round(float(row["open"]), 4),
            "high": round(float(row["high"]), 4),
            "low": round(float(row["low"]), 4),
            "close": round(float(row["close"]), 4),
            "volume": int(row["volume"]) if pd.notna(row["volume"]) else 0,
        })
    return result


def resample_ohlcv(frame: pd.DataFrame, rule: str) -> pd.DataFrame:
    return frame.resample(rule, label="right", closed="right").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["open", "high", "low", "close"])


def main() -> int:
    started = datetime.now(timezone.utc)
    tickers = get_symbols()
    print(f"Universe contains {len(tickers)} NIFTY 500 symbols")

    # Download full daily history only for the first successful bootstrap.
    # On later 15-minute runs, fetch the recent daily bars and merge them into
    # stored history so the long-term scanners keep their historical candles
    # without re-downloading five years for every run.
    existing_daily: dict[str, pd.DataFrame] = {}
    if DAILY_PATH.exists() and DAILY_PATH.stat().st_size > 20:
        try:
            saved = pd.read_csv(DAILY_PATH)
            if {"symbol", "date", "open", "high", "low", "close", "volume"}.issubset(saved.columns):
                saved["date"] = pd.to_datetime(saved["date"], errors="coerce")
                saved = saved.dropna(subset=["date"])
                for symbol, group in saved.groupby("symbol"):
                    frame = group.set_index("date")[["open", "high", "low", "close", "volume"]].copy()
                    frame.index = pd.DatetimeIndex(frame.index).tz_localize(None)
                    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
                    existing_daily[f"{symbol}.NS"] = frame
        except Exception as exc:
            print(f"Could not reuse stored daily history; will bootstrap full history: {exc}", file=sys.stderr)

    daily_fetch_period = "5d" if existing_daily else DAILY_PERIOD
    print(f"Daily history mode: {'incremental merge' if existing_daily else 'initial full-history bootstrap'} (download period={daily_fetch_period})")
    daily = download_history(tickers, daily_fetch_period, "1d")
    # Merge recent bars over stored history, retaining all earlier bars.
    for ticker, old_frame in existing_daily.items():
        new_frame = daily.get(ticker, pd.DataFrame())
        if new_frame.empty:
            daily[ticker] = old_frame
        else:
            combined = pd.concat([old_frame, new_frame])
            combined = combined[~combined.index.duplicated(keep="last")].sort_index()
            daily[ticker] = combined

    intraday = download_history(tickers, INTRADAY_PERIOD, "15m")
    if not daily and not intraday:
        raise RuntimeError("No market data downloaded. Existing CSVs were not replaced.")

    # Safety gate: never replace the scanner's existing CSV with a small,
    # rate-limited or otherwise incomplete daily universe.
    min_daily_coverage = float(os.getenv("MIN_DAILY_COVERAGE", "0.60"))
    daily_coverage = len(daily) / max(len(tickers), 1)
    print(f"Daily data coverage: {len(daily)}/{len(tickers)} ({daily_coverage:.1%}); minimum required: {min_daily_coverage:.1%}")
    if daily_coverage < min_daily_coverage:
        raise RuntimeError(
            f"Only {len(daily)} of {len(tickers)} symbols downloaded daily data "
            f"({daily_coverage:.1%}); below {min_daily_coverage:.1%} safety threshold. "
            "Existing scanner CSVs were not replaced."
        )

    daily_rows: list[dict] = []
    scanner_rows: list[dict] = []
    intraday_rows: list[dict] = []
    failed_symbols = []

    # The existing dashboard schema expects one row per symbol/candle/timeframe.
    # Daily history powers long-term zone analysis; longer timeframes are
    # aggregated from daily bars, so the same source data stays consistent.
    for ticker in tickers:
        symbol = ticker.removesuffix(".NS")
        dframe = daily.get(ticker, pd.DataFrame())
        if not dframe.empty:
            daily_rows.extend(rows_for_timeframe(symbol, dframe, "Daily"))
            scanner_rows.extend(rows_for_timeframe(symbol, dframe, "Daily"))
            periods = [
                ("Weekly", "W-FRI"),
                ("Monthly", "ME"),
                ("Quarterly", "QE-DEC"),
                ("Half-Yearly", "2QE-DEC"),
                ("Yearly", "YE-DEC"),
            ]
            for label, rule in periods:
                aggregated = resample_ohlcv(dframe, rule)
                scanner_rows.extend(rows_for_timeframe(symbol, aggregated, label))
        else:
            failed_symbols.append(symbol)

        iframe = intraday.get(ticker, pd.DataFrame())
        if not iframe.empty:
            # Keep the latest trading date only to avoid bloating the Git repo.
            local_index = iframe.index
            if getattr(local_index, "tz", None) is not None:
                local_index = local_index.tz_convert("Asia/Kolkata")
                iframe = iframe.copy()
                iframe.index = local_index
            latest_day = iframe.index[-1].date()
            recent = iframe.loc[[idx.date() == latest_day for idx in iframe.index]]
            intraday_rows.extend(rows_for_timeframe(symbol, recent, "15-Minute"))

    def safe_write_csv(rows: list[dict], path: Path, columns: list[str]) -> None:
        if not rows:
            print(f"No new rows for {path.name}; keeping existing file if present.")
            if not path.exists():
                pd.DataFrame(columns=columns).to_csv(path, index=False)
            return
        temp = path.with_suffix(path.suffix + ".tmp")
        pd.DataFrame(rows, columns=columns).to_csv(temp, index=False)
        if temp.stat().st_size == 0:
            raise RuntimeError(f"Refusing to replace {path.name} with an empty file.")
        temp.replace(path)

    columns = ["symbol", "date", "timeframe", "open", "high", "low", "close", "volume"]

    # Validate generated scanner output before replacing the currently published
    # CSVs. This protects the dashboard from empty, duplicate or malformed bars.
    required_timeframes = {"Daily", "Weekly", "Monthly", "Quarterly", "Half-Yearly", "Yearly"}
    present_timeframes = {row["timeframe"] for row in scanner_rows}
    missing_timeframes = sorted(required_timeframes - present_timeframes)
    if missing_timeframes:
        raise RuntimeError(f"Refusing to publish scanner CSV: missing timeframes {missing_timeframes}")

    seen_keys = set()
    timeframe_counts: dict[str, int] = {}
    for row in scanner_rows:
        symbol, date_value, timeframe = row["symbol"], row["date"], row["timeframe"]
        key = (symbol, date_value, timeframe)
        if key in seen_keys:
            raise RuntimeError(f"Refusing to publish duplicate candle key: {key}")
        seen_keys.add(key)
        o, h, low, c, volume = (float(row[k]) for k in ("open", "high", "low", "close", "volume"))
        if not all(math.isfinite(value) for value in (o, h, low, c, volume)):
            raise RuntimeError(f"Refusing to publish non-finite OHLCV row: {key}")
        if min(o, h, low, c) <= 0 or volume < 0 or h < max(o, low, c) or low > min(o, h, c):
            raise RuntimeError(f"Refusing to publish invalid OHLCV values: {key}")
        timeframe_counts[timeframe] = timeframe_counts.get(timeframe, 0) + 1

    safe_write_csv(scanner_rows, CANDLES_PATH, columns)
    safe_write_csv(daily_rows, DAILY_PATH, columns)
    safe_write_csv(intraday_rows, INTRADAY_PATH, columns)

    finished = datetime.now(timezone.utc)
    status = {
        "project": "Shivshakti Trader",
        "provider": "Yahoo Finance via yfinance (unofficial; prototype only)",
        "universe": "NIFTY 500",
        "symbols_requested": len(tickers),
        "daily_symbols_received": len(daily),
        "intraday_symbols_received": len(intraday),
        "failed_daily_symbols": failed_symbols,
        "daily_period": DAILY_PERIOD,
        "intraday_period": INTRADAY_PERIOD,
        "last_successful_run_utc": finished.isoformat(),
        "duration_seconds": round((finished - started).total_seconds(), 1),
        "timeframe_rows": timeframe_counts,
        "timeframes_validated": sorted(present_timeframes),
        "csv_rows": {
            "candles.csv": len(scanner_rows),
            "data/daily_ohlcv.csv": len(daily_rows),
            "data/intraday_15m.csv": len(intraday_rows),
        },
        "warning": "Unofficial market data; verify accuracy and data-use permissions before trading or redistribution.",
    }
    STATUS_PATH.write_text(json.dumps(status, indent=2), encoding="utf-8")
    print(json.dumps(status, indent=2))
    if not scanner_rows:
        raise RuntimeError("Scanner CSV contains no rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
