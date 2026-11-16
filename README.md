# PulseBinary — Live Demo Binary Trading App

A mobile-first demo binary trading web app with real-time Binance market candles, fixed candle countdown timers, start-candle signal detection, and voice notifications.

## Features
- **100% Real-Time Candles:** Live Binance market feed (`BTC/USDT`, `ETH/USDT`, `SOL/USDT`, `BNB/USDT`, `XRP/USDT`).
- **Fixed Timeframes:** `5s`, `15s`, `1m`, `3m`, `5m`, `15m` with exact countdown timer (zooming never changes the timeframe).
- **Start-Candle Signal Engine:** Marks potential Bullish (`▲`) & Bearish (`▼`) start candles using EMA 9/20, RSI 14, candle patterns, and a Sideways filter, plus live signal win-rate tracking.
- **Voice Notifications:** Browser speech & chime alerts when Pre-Alerts or Start-Candle signals trigger (toggleable in the top bar).
- **Demo Account:** `$10,000` virtual demo balance with `UP (CALL)` / `DOWN (PUT)` trades, live entry lines on the chart, and persistent history.

## GitHub & Vercel Upload Steps (Mobile)
1. Unzip `PulseBinary-GitHub.zip` on your phone.
2. Open your GitHub repository -> **Add file** -> **Upload files**.
3. Select all extracted files (`index.html`, `styles.css`, `app.js`, `README.md`, `vercel.json`) and commit.
4. Import the GitHub repository into **Vercel** and click **Deploy**.
