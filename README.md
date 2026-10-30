# Shivshakti Screener Data

This repository stores OHLCV data for the Shivshakti Trader dashboard and its demand/supply zone scanners.

## Automatic refresh

GitHub Actions is configured to run approximately every 15 minutes during the weekday NSE market-session window. Scheduled runs can be delayed. You can also run it manually from **Actions → Refresh Shivshakti Market Data → Run workflow**.

Files produced:
- `candles.csv.gz` — compressed scanner-ready OHLCV; includes maximum available Daily history, derived higher-timeframe rows, and the latest month of 15-minute candles.
- `data/daily_ohlcv.csv.gz` — compressed daily OHLCV history.
- `data/intraday_15m.csv` — latest month of 15-minute candles.
- `status.json` — last run time, symbol counts, row counts and warnings.

## Data source and limitations

The prototype uses Yahoo Finance through `yfinance` and the NIFTY 500 constituent list. Yahoo Finance is **not an official NSE feed**; availability, accuracy and latency are not guaranteed, and intraday data may be delayed or unavailable. GitHub scheduled jobs can also start late. Do not treat this prototype as guaranteed real-time data or use it for live trade execution without independent validation.

For production use, replace the adapter with an authorized broker or licensed market-data provider API and follow its licensing/redistribution terms. NSE's policy restricts redistribution except as permitted by the relevant agreement: https://www.nseindia.com/static/market-data/nse-data-policy. NSE also lists paid real-time and delayed snapshot products: https://www.nseindia.com/static/market-data/real-time-data-subscription.

## Run locally

```bash
python -m pip install -r requirements.txt
python scripts/refresh_market_data.py
```

Optional environment settings:
- `DAILY_PERIOD` (default `max`, provider's maximum available daily history)
- `INTRADAY_PERIOD` (default `1mo`)
- `DOWNLOAD_CHUNK_SIZE` (default `40`)
- `NIFTY500_CSV_URL` (override the universe CSV URL)

Keep API keys, passwords, PINs and OTPs out of this public repository. If you add a licensed provider later, store credentials in GitHub Actions Secrets.

## 7/7 Daily Performance

The scheduled market-data workflow runs during the NSE session and, after refreshing the 15-minute OHLCV feed, runs `scripts/build_daily_performance.py`. It records authentic 7/7 Gyan zones confirmed before 15:30 IST, keeps the original signal timestamp and Entry/Stop-Loss/2R Target, and appends the session's 15-minute chart candles to:

- `data/daily_7of7_performance.csv`
- `data/daily_7of7_chart_candles.csv`

The dashboard's **7/7 Daily Performance** tab lets you select a session date and open a marked intraday chart. Performance returns and favourable/adverse excursions are calculated only after the Entry level is touched. If Target or Stop is crossed before Entry, it is labelled as such; if both levels are crossed in the same 15-minute candle, the sequence is marked ambiguous.

**Timeframe caveat:** 125-minute Gyan groups are derived from 15-minute candles using the same NSE-session bucket logic as the browser screener. They are approximations, not native exchange 125-minute candles. The Yahoo Finance/yfinance feed is unofficial and may be delayed, incomplete or unavailable; verify prices and data-use permissions independently.
