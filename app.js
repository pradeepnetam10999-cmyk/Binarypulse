(() => {
  const PAYOUT = 0.85;
  const STORAGE_KEY = "pulsebinary_state_v1";

  const TF_SECONDS = {
    "5s": 5,
    "15s": 15,
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
  };

  // App State
  let state = {
    symbol: "BTCUSDT",
    timeframe: "1m",
    chartType: "candles", // 'candles' | 'area'
    showIndicators: true,
    voiceEnabled: true,
    balance: 10000,
    expirySec: 60,
    activeTab: "active",
    candles: [],
    activeTrades: [],
    history: [],
    signalStats: { wins: 0, total: 0 },
    lastSpokenCandleTime: 0,
    lastPreAlertTime: 0,
    visibleCount: 48,
    panOffset: 0,
  };

  let ws = null;
  let audioCtx = null;
  let hoverIdx = null;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartPan = 0;

  // DOM
  const canvas = document.getElementById("chartCanvas");
  const ctx = canvas.getContext("2d");
  const liveStatus = document.getElementById("liveStatus");
  const liveStatusText = document.getElementById("liveStatusText");
  const demoBalanceEl = document.getElementById("demoBalance");
  const tradeAmountEl = document.getElementById("tradeAmount");
  const callReturnEl = document.getElementById("callReturn");
  const putReturnEl = document.getElementById("putReturn");
  const signalBanner = document.getElementById("signalBanner");
  const signalBadge = document.getElementById("signalBadge");
  const signalText = document.getElementById("signalText");
  const rsiBadge = document.getElementById("rsiBadge");
  const signalAccBadge = document.getElementById("signalAccBadge");
  const candleTimerEl = document.getElementById("candleTimer");
  const tradesListEl = document.getElementById("tradesList");
  const activeCountEl = document.getElementById("activeCount");
  const winRateBadgeEl = document.getElementById("winRateBadge");

  function loadPersisted() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved) {
        if (typeof saved.balance === "number") state.balance = saved.balance;
        if (Array.isArray(saved.history)) state.history = saved.history.slice(0, 50);
        if (saved.signalStats) state.signalStats = saved.signalStats;
      }
    } catch (_) {}
  }

  function savePersisted() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          balance: state.balance,
          history: state.history.slice(0, 50),
          signalStats: state.signalStats,
        })
      );
    } catch (_) {}
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  // Audio & Voice Notifications
  function unlockAudio() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) audioCtx = new AudioContext();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  function playChime(type) {
    if (!state.voiceEnabled) return;
    try {
      unlockAudio();
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(
        type === "CALL" ? 880 : type === "PUT" ? 520 : 660,
        audioCtx.currentTime
      );
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } catch (_) {}
  }

  function speakAlert(text, type) {
    if (!state.voiceEnabled) return;
    playChime(type);
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.05;
        utter.pitch = 1.0;
        window.speechSynthesis.speak(utter);
      } catch (_) {}
    }
  }

  // Technical Indicators
  function calcEMA(values, period) {
    const k = 2 / (period + 1);
    const ema = [];
    let prev = values[0];
    ema.push(prev);
    for (let i = 1; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      ema.push(prev);
    }
    return ema;
  }

  function calcRSI(closes, period = 14) {
    const rsi = new Array(closes.length).fill(null);
    if (closes.length <= period) return rsi;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const g = diff > 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return rsi;
  }

  function isSidewaysMarket(closes, idx) {
    if (idx < 20) return false;
    const slice = closes.slice(idx - 19, idx + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const std = Math.sqrt(variance);
    const bbWidthPct = (4 * std) / mean;
    return bbWidthPct < 0.0008; // Very tight squeeze
  }

  function analyzeSignals() {
    const candles = state.candles;
    if (candles.length < 25) return;
    const closes = candles.map((c) => c.close);
    const ema9 = calcEMA(closes, 9);
    const ema20 = calcEMA(closes, 20);
    const rsi = calcRSI(closes, 14);

    for (let i = 21; i < candles.length - 1; i++) {
      const c = candles[i];
      c.ema9 = ema9[i];
      c.ema20 = ema20[i];
      c.rsi = rsi[i];
      if (c.signalEvaluated) continue;

      const prev = candles[i - 1];
      const body = Math.abs(c.close - c.open);
      const range = Math.max(c.high - c.low, 1e-9);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;

      const bullishCross = ema9[i] > ema20[i] && ema9[i - 1] <= ema20[i - 1];
      const bearishCross = ema9[i] < ema20[i] && ema9[i - 1] >= ema20[i - 1];
      const isHammer = lowerWick > body * 1.8 && upperWick < body * 0.7 && c.close > c.open;
      const isShootingStar = upperWick > body * 1.8 && lowerWick < body * 0.7 && c.close < c.open;
      const bullEngulf = c.close > c.open && prev.close < prev.open && c.close >= prev.open && c.open <= prev.close;
      const bearEngulf = c.close < c.open && prev.close > prev.open && c.close <= prev.open && c.open >= prev.close;
      const sideways = isSidewaysMarket(closes, i);

      let sig = null;
      if (!sideways) {
        if ((bullishCross || isHammer || bullEngulf) && rsi[i] !== null && rsi[i] < 65 && c.close > c.open) {
          sig = "CALL";
        } else if ((bearishCross || isShootingStar || bearEngulf) && rsi[i] !== null && rsi[i] > 35 && c.close < c.open) {
          sig = "PUT";
        }
      }

      c.signal = sig;
      c.signalEvaluated = true;

      // Evaluate signal accuracy 2 candles later
      if (i >= 23 && candles[i - 2].signal && !candles[i - 2].accScored) {
        const sCandle = candles[i - 2];
        const won =
          (sCandle.signal === "CALL" && c.close > sCandle.close) ||
          (sCandle.signal === "PUT" && c.close < sCandle.close);
        sCandle.accScored = true;
        state.signalStats.total += 1;
        if (won) state.signalStats.wins += 1;
        savePersisted();
      }
    }

    // Current forming candle metrics & banner
    const lastIdx = candles.length - 1;
    const liveCandle = candles[lastIdx];
    liveCandle.ema9 = ema9[lastIdx];
    liveCandle.ema20 = ema20[lastIdx];
    liveCandle.rsi = rsi[lastIdx];

    const lastClosed = candles[lastIdx - 1];
    const currentRsi = rsi[lastIdx] ? rsi[lastIdx].toFixed(1) : "--";
    rsiBadge.textContent = `RSI: ${currentRsi}`;

    if (state.signalStats.total > 0) {
      const pct = Math.round((state.signalStats.wins / state.signalStats.total) * 100);
      signalAccBadge.textContent = `Sig Win: ${pct}% (${state.signalStats.wins}/${state.signalStats.total})`;
    } else {
      signalAccBadge.textContent = "Sig Win: --";
    }

    const sidewaysNow = isSidewaysMarket(closes, lastIdx);
    const tfSec = TF_SECONDS[state.timeframe];
    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = tfSec - (nowSec % tfSec);

    if (lastClosed && lastClosed.signal) {
      const isCall = lastClosed.signal === "CALL";
      signalBanner.className = `signal-banner ${isCall ? "bullish" : "bearish"}`;
      signalBadge.textContent = isCall ? "BULLISH START ↑" : "BEARISH START ↓";
      signalText.textContent = isCall
        ? `${state.symbol.replace("USDT", "")}: Upward candle run detected from last closed candle`
        : `${state.symbol.replace("USDT", "")}: Downward candle drop detected from last closed candle`;

      if (state.lastSpokenCandleTime !== lastClosed.time) {
        state.lastSpokenCandleTime = lastClosed.time;
        const coin = state.symbol.replace("USDT", "");
        speakAlert(
          isCall
            ? `Bullish signal on ${coin}. Upward move starting.`
            : `Bearish signal on ${coin}. Downward move starting.`,
          lastClosed.signal
        );
      }
    } else if (sidewaysNow) {
      signalBanner.className = "signal-banner neutral";
      signalBadge.textContent = "SIDEWAYS";
      signalText.textContent = "Low momentum squeeze — wait for clear breakout candle";
    } else if (remaining <= Math.max(3, Math.floor(tfSec * 0.25)) && liveCandle) {
      const bullSetup = ema9[lastIdx] > ema20[lastIdx] && liveCandle.close > liveCandle.open;
      const bearSetup = ema9[lastIdx] < ema20[lastIdx] && liveCandle.close < liveCandle.open;
      if (bullSetup || bearSetup) {
        signalBanner.className = "signal-banner prealert";
        signalBadge.textContent = "PRE-ALERT ⚡";
        signalText.textContent = bullSetup
          ? "Bullish momentum building — watch next candle open"
          : "Bearish pressure building — watch next candle open";
        if (state.lastPreAlertTime !== liveCandle.time) {
          state.lastPreAlertTime = liveCandle.time;
          playChime("PRE");
        }
      } else {
        signalBanner.className = "signal-banner neutral";
        signalBadge.textContent = "SCANNING";
        signalText.textContent = "Watching live candles for next start signal...";
      }
    } else {
      signalBanner.className = "signal-banner neutral";
      signalBadge.textContent = "SCANNING";
      signalText.textContent = "Watching live candles for next start signal...";
    }
  }

  // Market Data Fetching & WebSocket
  function setConnStatus(mode, text) {
    const dot = liveStatus.querySelector(".dot");
    dot.className = `dot ${mode}`;
    liveStatusText.textContent = text;
  }

  async function loadMarketData() {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    setConnStatus("connecting", "Loading...");
    state.candles = [];
    state.panOffset = 0;

    const sym = state.symbol;
    const tf = state.timeframe;
    const tfSec = TF_SECONDS[tf];

    try {
      if (tf === "5s" || tf === "15s") {
        // Fetch 1s klines and aggregate into exact 5s / 15s buckets
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1s&limit=600`);
        const raw = await res.json();
        const buckets = new Map();
        for (const k of raw) {
          const sec = Math.floor(k[0] / 1000);
          const bucketTime = Math.floor(sec / tfSec) * tfSec;
          const o = parseFloat(k[1]);
          const h = parseFloat(k[2]);
          const l = parseFloat(k[3]);
          const c = parseFloat(k[4]);
          if (!buckets.has(bucketTime)) {
            buckets.set(bucketTime, { time: bucketTime, open: o, high: h, low: l, close: c });
          } else {
            const b = buckets.get(bucketTime);
            b.high = Math.max(b.high, h);
            b.low = Math.min(b.low, l);
            b.close = c;
          }
        }
        state.candles = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
        connectTradeStream(sym, tfSec);
      } else {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=120`);
        const raw = await res.json();
        state.candles = raw.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
        }));
        connectKlineStream(sym, tf);
      }
      analyzeSignals();
      drawChart();
    } catch (err) {
      setConnStatus("error", "Feed Error");
      showToast("Unable to load live market feed. Check internet.");
    }
  }

  function connectKlineStream(sym, tf) {
    const url = `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@kline_${tf}`;
    ws = new WebSocket(url);
    ws.onopen = () => setConnStatus("live", "Live Feed");
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.k) return;
      const k = msg.k;
      const candle = {
        time: Math.floor(k.t / 1000),
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
      };
      upsertCandle(candle);
    };
    ws.onclose = () => {
      setConnStatus("error", "Reconnecting...");
      setTimeout(() => {
        if (state.symbol === sym && state.timeframe === tf) loadMarketData();
      }, 2500);
    };
  }

  function connectTradeStream(sym, tfSec) {
    const url = `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@trade`;
    ws = new WebSocket(url);
    ws.onopen = () => setConnStatus("live", "Live 1s Tick");
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const price = parseFloat(msg.p);
      const sec = Math.floor(msg.T / 1000);
      const bucketTime = Math.floor(sec / tfSec) * tfSec;
      const last = state.candles[state.candles.length - 1];
      if (!last || last.time < bucketTime) {
        state.candles.push({
          time: bucketTime,
          open: last ? last.close : price,
          high: Math.max(last ? last.close : price, price),
          low: Math.min(last ? last.close : price, price),
          close: price,
        });
        if (state.candles.length > 160) state.candles.shift();
        analyzeSignals();
      } else {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        analyzeSignals();
      }
      drawChart();
    };
    ws.onclose = () => {
      setConnStatus("error", "Reconnecting...");
      setTimeout(() => {
        if (state.symbol === sym && TF_SECONDS[state.timeframe] === tfSec) loadMarketData();
      }, 2500);
    };
  }

  function upsertCandle(c) {
    const last = state.candles[state.candles.length - 1];
    if (!last || last.time < c.time) {
      state.candles.push(c);
      if (state.candles.length > 160) state.candles.shift();
    } else if (last.time === c.time) {
      last.open = c.open;
      last.high = c.high;
      last.low = c.low;
      last.close = c.close;
    }
    analyzeSignals();
    drawChart();
  }

  // Drawing Chart
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function formatPrice(p) {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 10) return p.toFixed(3);
    return p.toFixed(4);
  }

  function drawChart() {
    resizeCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const candles = state.candles;
    if (!candles.length) return;

    const padRight = 68;
    const padTop = 28;
    const padBottom = 24;
    const plotW = w - padRight;
    const plotH = h - padTop - padBottom;

    const endIdx = Math.max(state.visibleCount, candles.length - state.panOffset);
    const startIdx = Math.max(0, endIdx - state.visibleCount);
    const slice = candles.slice(startIdx, endIdx);
    if (!slice.length) return;

    let minP = Infinity;
    let maxP = -Infinity;
    for (const c of slice) {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    }
    for (const t of state.activeTrades) {
      if (t.symbol === state.symbol) {
        minP = Math.min(minP, t.entryPrice);
        maxP = Math.max(maxP, t.entryPrice);
      }
    }
    const padP = (maxP - minP) * 0.14 || maxP * 0.002;
    minP -= padP;
    maxP += padP;

    const priceToY = (p) => padTop + ((maxP - p) / (maxP - minP)) * plotH;
    const stepX = plotW / slice.length;

    // Grid lines
    ctx.strokeStyle = "rgba(36, 48, 71, 0.5)";
    ctx.lineWidth = 1;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#64748b";
    for (let g = 0; g <= 4; g++) {
      const y = padTop + (plotH * g) / 4;
      const pVal = maxP - ((maxP - minP) * g) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.fillText(formatPrice(pVal), plotW + 6, y + 4);
    }

    // Candles or Area
    if (state.chartType === "area") {
      ctx.beginPath();
      slice.forEach((c, i) => {
        const x = i * stepX + stepX / 2;
        const y = priceToY(c.close);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineTo((slice.length - 1) * stepX + stepX / 2, padTop + plotH);
      ctx.lineTo(stepX / 2, padTop + plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      grad.addColorStop(0, "rgba(56, 189, 248, 0.28)");
      grad.addColorStop(1, "rgba(56, 189, 248, 0.0)");
      ctx.fillStyle = grad;
      ctx.fill();
    } else {
      const candleW = Math.max(3, stepX * 0.64);
      slice.forEach((c, i) => {
        const x = i * stepX + stepX / 2;
        const isUp = c.close >= c.open;
        const color = isUp ? "#00e676" : "#ff3d57";

        // Wick
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x, priceToY(c.high));
        ctx.lineTo(x, priceToY(c.low));
        ctx.stroke();

        // Body
        const yOpen = priceToY(c.open);
        const yClose = priceToY(c.close);
        const bodyH = Math.max(2, Math.abs(yClose - yOpen));
        ctx.fillStyle = color;
        ctx.fillRect(x - candleW / 2, Math.min(yOpen, yClose), candleW, bodyH);
      });
    }

    // EMA 9 & EMA 20
    if (state.showIndicators) {
      const drawLine = (key, color) => {
        ctx.beginPath();
        let started = false;
        slice.forEach((c, i) => {
          if (typeof c[key] !== "number") return;
          const x = i * stepX + stepX / 2;
          const y = priceToY(c[key]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      };
      drawLine("ema9", "#ffb300");
      drawLine("ema20", "#a855f7");
    }

    // Start-Candle Signal Arrows
    slice.forEach((c, i) => {
      if (!c.signal) return;
      const x = i * stepX + stepX / 2;
      if (c.signal === "CALL") {
        const y = priceToY(c.low) + 16;
        ctx.fillStyle = "#00e676";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("▲", x, y);
      } else {
        const y = priceToY(c.high) - 8;
        ctx.fillStyle = "#ff3d57";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("▼", x, y);
      }
      ctx.textAlign = "left";
    });

    // Active Trade Entry Lines
    state.activeTrades
      .filter((t) => t.symbol === state.symbol)
      .forEach((t) => {
        const y = priceToY(t.entryPrice);
        const color = t.direction === "CALL" ? "#00e676" : "#ff3d57";
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = color;
        ctx.fillRect(6, y - 16, 86, 15);
        ctx.fillStyle = "#050a12";
        ctx.font = "bold 10px sans-serif";
        const rem = Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 1000));
        ctx.fillText(`${t.direction} $${t.amount} (${rem}s)`, 10, y - 5);
      });

    // Live Price Line
    const latest = candles[candles.length - 1];
    const liveY = priceToY(latest.close);
    const liveColor = latest.close >= latest.open ? "#00e676" : "#ff3d57";
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = liveColor;
    ctx.beginPath();
    ctx.moveTo(0, liveY);
    ctx.lineTo(plotW, liveY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = liveColor;
    ctx.fillRect(plotW + 2, liveY - 9, padRight - 4, 18);
    ctx.fillStyle = "#050a12";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(formatPrice(latest.close), plotW + 6, liveY + 4);

    // OHLC Overlay
    const target = hoverIdx !== null && slice[hoverIdx] ? slice[hoverIdx] : latest;
    document.getElementById("ohlcO").textContent = formatPrice(target.open);
    document.getElementById("ohlcH").textContent = formatPrice(target.high);
    document.getElementById("ohlcL").textContent = formatPrice(target.low);
    document.getElementById("ohlcC").textContent = formatPrice(target.close);
  }

  // Demo Trading & Settlement
  function placeTrade(direction) {
    unlockAudio();
    const amount = parseFloat(tradeAmountEl.value);
    if (!amount || amount <= 0) return showToast("Enter a valid trade amount");
    if (amount > state.balance) return showToast("Insufficient demo balance");
    if (!state.candles.length) return showToast("Waiting for live price...");

    const entryPrice = state.candles[state.candles.length - 1].close;
    state.balance -= amount;
    const trade = {
      id: Date.now() + Math.random(),
      symbol: state.symbol,
      direction,
      amount,
      entryPrice,
      openedAt: Date.now(),
      expiresAt: Date.now() + state.expirySec * 1000,
    };
    state.activeTrades.unshift(trade);
    savePersisted();
    renderUI();
    drawChart();
    showToast(`${direction} $${amount} placed at ${formatPrice(entryPrice)}`);
  }

  function tickLoop() {
    const tfSec = TF_SECONDS[state.timeframe];
    const nowSec = Math.floor(Date.now() / 1000);
    const rem = tfSec - (nowSec % tfSec);
    const mm = String(Math.floor(rem / 60)).padStart(2, "0");
    const ss = String(rem % 60).padStart(2, "0");
    candleTimerEl.textContent = `${mm}:${ss}`;

    // Settle expired trades
    if (state.activeTrades.length && state.candles.length) {
      const now = Date.now();
      const latestPrice = state.candles[state.candles.length - 1].close;
      let changed = false;
      const stillActive = [];

      for (const t of state.activeTrades) {
        if (now >= t.expiresAt && t.symbol === state.symbol) {
          const won =
            (t.direction === "CALL" && latestPrice > t.entryPrice) ||
            (t.direction === "PUT" && latestPrice < t.entryPrice);
          const tie = latestPrice === t.entryPrice;
          const payout = tie ? t.amount : won ? t.amount * (1 + PAYOUT) : 0;
          state.balance += payout;
          state.history.unshift({
            ...t,
            closePrice: latestPrice,
            result: tie ? "TIE" : won ? "WIN" : "LOSS",
            profit: payout - t.amount,
          });
          if (state.history.length > 50) state.history.pop();
          changed = true;
          showToast(won ? `WIN! +$${(t.amount * PAYOUT).toFixed(2)}` : `LOSS -$${t.amount.toFixed(2)}`);
        } else {
          stillActive.push(t);
        }
      }

      if (changed) {
        state.activeTrades = stillActive;
        savePersisted();
      }
      renderTrades();
      drawChart();
    }
  }

  function renderUI() {
    demoBalanceEl.textContent = `$${state.balance.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    const amt = parseFloat(tradeAmountEl.value) || 0;
    const ret = (amt * (1 + PAYOUT)).toFixed(2);
    callReturnEl.textContent = `Return $${ret}`;
    putReturnEl.textContent = `Return $${ret}`;
    renderTrades();
  }

  function renderTrades() {
    activeCountEl.textContent = state.activeTrades.length;
    const wins = state.history.filter((h) => h.result === "WIN").length;
    const total = state.history.length;
    winRateBadgeEl.textContent = total ? `${Math.round((wins / total) * 100)}% Win` : "0% Win";

    if (state.activeTab === "active") {
      if (!state.activeTrades.length) {
        tradesListEl.innerHTML = `<div class="empty-state">No active trades. Tap UP or DOWN to test a demo trade.</div>`;
        return;
      }
      tradesListEl.innerHTML = state.activeTrades
        .map((t) => {
          const rem = Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 1000));
          return `
            <div class="trade-row">
              <div>
                <span class="trade-dir ${t.direction}">${t.direction}</span>
                <b>${t.symbol.replace("USDT", "/USDT")}</b> • $${t.amount}
                <div style="color:#94a3b8;font-size:11px;">Entry: ${formatPrice(t.entryPrice)}</div>
              </div>
              <div class="trade-result LIVE">${rem}s left</div>
            </div>`;
        })
        .join("");
    } else {
      if (!state.history.length) {
        tradesListEl.innerHTML = `<div class="empty-state">No completed trades yet.</div>`;
        return;
      }
      tradesListEl.innerHTML = state.history
        .map((h) => {
          const sign = h.profit >= 0 ? "+" : "-";
          return `
            <div class="trade-row">
              <div>
                <span class="trade-dir ${h.direction}">${h.direction}</span>
                <b>${h.symbol.replace("USDT", "/USDT")}</b> • $${h.amount}
                <div style="color:#94a3b8;font-size:11px;">${formatPrice(h.entryPrice)} → ${formatPrice(h.closePrice)}</div>
              </div>
              <div class="trade-result ${h.result}">
                ${h.result}<br/>
                <span>${sign}$${Math.abs(h.profit).toFixed(2)}</span>
              </div>
            </div>`;
        })
        .join("");
    }
  }

  // Event Listeners
  document.getElementById("assetSelect").addEventListener("change", (e) => {
    state.symbol = e.target.value;
    loadMarketData();
  });

  document.getElementById("timeframePills").addEventListener("click", (e) => {
    const btn = e.target.closest(".tf-btn");
    if (!btn) return;
    document.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.timeframe = btn.dataset.tf;
    loadMarketData();
  });

  document.getElementById("chartTypeBtn").addEventListener("click", (e) => {
    state.chartType = state.chartType === "candles" ? "area" : "candles";
    e.target.textContent = state.chartType === "candles" ? "Candles" : "Area";
    drawChart();
  });

  document.getElementById("indicatorsBtn").addEventListener("click", (e) => {
    state.showIndicators = !state.showIndicators;
    e.target.classList.toggle("active", state.showIndicators);
    drawChart();
  });

  document.getElementById("voiceToggleBtn").addEventListener("click", (e) => {
    unlockAudio();
    state.voiceEnabled = !state.voiceEnabled;
    const btn = document.getElementById("voiceToggleBtn");
    btn.className = `icon-btn ${state.voiceEnabled ? "voice-on" : "voice-off"}`;
    btn.innerHTML = state.voiceEnabled ? `🔊 <span>Voice ON</span>` : `🔇 <span>Muted</span>`;
    if (state.voiceEnabled) speakAlert("Voice signal alerts enabled", "PRE");
  });

  document.getElementById("resetBalanceBtn").addEventListener("click", () => {
    state.balance = 10000;
    savePersisted();
    renderUI();
    showToast("Demo balance reset to $10,000");
  });

  document.querySelectorAll(".qa-btn").forEach((b) =>
    b.addEventListener("click", () => {
      tradeAmountEl.value = b.dataset.amt;
      renderUI();
    })
  );

  document.getElementById("amtMinus").addEventListener("click", () => {
    tradeAmountEl.value = Math.max(1, (parseFloat(tradeAmountEl.value) || 10) - 10);
    renderUI();
  });

  document.getElementById("amtPlus").addEventListener("click", () => {
    tradeAmountEl.value = (parseFloat(tradeAmountEl.value) || 0) + 10;
    renderUI();
  });

  tradeAmountEl.addEventListener("input", renderUI);

  document.getElementById("expiryPills").addEventListener("click", (e) => {
    const btn = e.target.closest(".exp-btn");
    if (!btn) return;
    document.querySelectorAll(".exp-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.expirySec = parseInt(btn.dataset.sec, 10);
  });

  document.getElementById("callBtn").addEventListener("click", () => placeTrade("CALL"));
  document.getElementById("putBtn").addEventListener("click", () => placeTrade("PUT"));

  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      renderTrades();
    })
  );

  // Zoom & Pan (Locked Timeframe)
  document.getElementById("zoomInBtn").addEventListener("click", () => {
    state.visibleCount = Math.max(16, state.visibleCount - 10);
    drawChart();
  });
  document.getElementById("zoomOutBtn").addEventListener("click", () => {
    state.visibleCount = Math.min(120, state.visibleCount + 10);
    drawChart();
  });
  document.getElementById("zoomResetBtn").addEventListener("click", () => {
    state.panOffset = 0;
    drawChart();
  });

  canvas.addEventListener("pointerdown", (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartPan = state.panOffset;
  });
  window.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const shift = Math.round(dx / 8);
    state.panOffset = Math.max(0, Math.min(state.candles.length - 15, dragStartPan + shift));
    drawChart();
  });
  window.addEventListener("pointerup", () => {
    isDragging = false;
  });

  window.addEventListener("resize", drawChart);

  // Init
  loadPersisted();
  renderUI();
  loadMarketData();
  setInterval(tickLoop, 250);
})();
