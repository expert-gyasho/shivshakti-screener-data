# Shivshakti Screener Data

This public repository holds historical OHLCV candle data for the Shivshakti Trader screener.

## CSV format

Save the data as `candles.csv`, with one row for each stock and candle:

```csv
symbol,date,timeframe,open,high,low,close,volume
```

Use ISO dates (`YYYY-MM-DD`) and timeframe values such as `Daily`, `Weekly`, or `Monthly`. Add only verified market data. The screener calculates candle classification and demand/supply Zone Analysis from the rows provided.

GitHub stores and serves the CSV; it does not generate or refresh market data. Keep API keys, passwords, PINs, and OTPs out of this public repository.
