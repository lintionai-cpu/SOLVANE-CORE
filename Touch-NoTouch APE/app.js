'use strict';
/* ============================================================
   OV2UN7 NEXUS — Touch/No Touch Adaptive Probability Engine
   Single-file execution-enabled trading application.
   Deriv API system: api.derivws.com / auth.deriv.com (current),
   NOT the legacy binaryws.com endpoint.
   ============================================================ */

/* ---------------- Global Config ---------------- */
const CONFIG = {
  apiBase: 'https://api.derivws.com',
  wsPublic: 'wss://api.derivws.com/trading/v1/options/ws/public',
  tickBufferMax: 200,
  fastWindow: 20,
  mediumWindow: 50,
  longWindow: 200,
  reentryCooldownTicks: 25,
  weights: {
    velocity: 15,
    acceleration: 10,
    volatility: 15,
    highLowPattern: 15,
    candleStrength: 10,
    EMA: 10,
    RSI: 5,
    ATR: 10,
    pattern: 10
  }
};

/* ---------------- Application State ---------------- */
const STATE = {
  accountMode: 'demo',          // 'demo' | 'real'
  connection: {
    status: 'disconnected',     // disconnected | connecting | connected | error
    ws: null,
    reqId: 0,
    pending: new Map(),         // req_id -> {resolve, reject}
    subscriptions: new Map(),   // req_id -> command (for resubscribe)
    reconnectAttempts: 0,
    maxReconnectAttempts: 5
  },
  auth: {
    appId: '',
    token: '',
    accountId: null,
    accounts: []
  },
  account: {
    balance: null,
    currency: null,
    loginid: null
  },
  market: {
    symbol: 'R_25',
    lastTick: null,
    lastTickTime: null
  },
  contract: {
    stake: 1,
    duration: 5,
    durationUnit: 's',
    barrierOffset: 0.5
  },
  risk: {
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 5,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 30,
    autoExecute: false,
    tradingPaused: false,
    pauseUntil: null,
    sessionStartBalance: null,
    sessionPL: 0,
    consecutiveLosses: 0,
    tradesToday: 0,
    currentStake: 1,
    ticksSinceLastTrade: 999
  },
  killSwitchEngaged: false,
  trades: [],          // full trade history (tradeRecord objects)
  openContracts: new Map(), // contract_id -> tradeRecord (pending)
  currentSignal: null,
  pendingManualSignal: null
};

/* ---------------- Logger ---------------- */
const Logger = {
  feedEl: null,
  init(){ this.feedEl = document.getElementById('logFeed'); },
  _write(msg, cls){
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.className = 'log-line' + (cls ? (' ' + cls) : '');
    line.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(msg)}`;
    if (this.feedEl){
      this.feedEl.appendChild(line);
      while (this.feedEl.children.length > 300){
        this.feedEl.removeChild(this.feedEl.firstChild);
      }
    }
    console.log(`[${ts}] ${msg}`);
  },
  info(msg){ this._write(msg, ''); },
  warn(msg){ this._write(msg, 'warn'); },
  error(msg){ this._write(msg, 'error'); },
  trade(msg){ this._write(msg, 'trade'); }
};

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function uid(){
  return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
}

function nowIso(){ return new Date().toISOString(); }

function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

function mean(arr){
  if (!arr.length) return 0;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

function stdDev(arr){
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum,v)=> sum + Math.pow(v-m,2), 0) / arr.length;
  return Math.sqrt(variance);
}

function round(v, dp){
  const f = Math.pow(10, dp === undefined ? 2 : dp);
  return Math.round(v * f) / f;
}

/* ============================================================
   MODULE 1 — Tick Buffer Engine
   Maintains rolling market memory: fast(20)/medium(50)/long(200)
   ============================================================ */
class TickBufferEngine {
  constructor(maxSize = CONFIG.tickBufferMax){
    this.maxSize = maxSize;
    this.prices = [];
    this.timestamps = [];
    this.highs = [];
    this.lows = [];
  }

  addTick(price, time){
    const prevPrice = this.prices.length ? this.prices[this.prices.length-1] : price;
    this.prices.push(price);
    this.timestamps.push(time);
    // Synthetic high/low per-tick (tick data has no OHLC; treat each tick as its own bar)
    this.highs.push(Math.max(price, prevPrice));
    this.lows.push(Math.min(price, prevPrice));

    if (this.prices.length > this.maxSize){
      this.prices.shift();
      this.timestamps.shift();
      this.highs.shift();
      this.lows.shift();
    }
  }

  getWindow(n){
    const len = this.prices.length;
    const start = Math.max(0, len - n);
    return {
      prices: this.prices.slice(start),
      timestamps: this.timestamps.slice(start),
      highs: this.highs.slice(start),
      lows: this.lows.slice(start)
    };
  }

  calculateRange(n){
    const w = this.getWindow(n);
    if (!w.prices.length) return 0;
    return Math.max(...w.highs) - Math.min(...w.lows);
  }

  size(){ return this.prices.length; }
  isReady(n){ return this.prices.length >= n; }
  lastPrice(){ return this.prices.length ? this.prices[this.prices.length-1] : null; }
  prevPrice(){ return this.prices.length > 1 ? this.prices[this.prices.length-2] : null; }
}

/* ============================================================
   MODULE 2 — Feature Generation Engine
   Computes: delta, velocity, acceleration, volatility, trend
   strength, barrier distance ratio, momentum, candle structure,
   EMA, RSI, ATR, expansion/compression strength.
   ============================================================ */
class FeatureEngine {
  constructor(tickBuffer){
    this.buf = tickBuffer;
    this.prevVelocity = 0;
    this.emaCache = { ema10: null, ema25: null, ema50: null };
  }

  computeDelta(){
    const cur = this.buf.lastPrice();
    const prev = this.buf.prevPrice();
    if (cur === null || prev === null) return 0;
    return cur - prev;
  }

  computeVelocity(){
    const len = this.buf.timestamps.length;
    if (len < 2) return 0;
    const cur = this.buf.prices[len-1];
    const prev = this.buf.prices[len-2];
    const tCur = this.buf.timestamps[len-1];
    const tPrev = this.buf.timestamps[len-2];
    const dt = Math.max(0.001, (tCur - tPrev) / 1000); // seconds, avoid div/0
    return Math.abs(cur - prev) / dt;
  }

  computeAcceleration(){
    const v = this.computeVelocity();
    const a = v - this.prevVelocity;
    this.prevVelocity = v;
    return a;
  }

  computeVolatility(windowSize = CONFIG.fastWindow){
    const w = this.buf.getWindow(windowSize);
    return stdDev(w.prices);
  }

  classifyVolatility(vol, avgVol){
    if (avgVol <= 0) return 'LOW';
    const ratio = vol / avgVol;
    if (ratio > 2.5) return 'EXTREME';
    if (ratio > 1.5) return 'HIGH';
    if (ratio > 0.7) return 'MEDIUM';
    return 'LOW';
  }

  computeEMA(period, priceArr){
    if (!priceArr.length) return null;
    const k = 2 / (period + 1);
    let ema = priceArr[0];
    for (let i = 1; i < priceArr.length; i++){
      ema = priceArr[i] * k + ema * (1 - k);
    }
    return ema;
  }

  computeTrendStrength(){
    const w = this.buf.getWindow(CONFIG.mediumWindow);
    if (w.prices.length < 10) return 0;
    const ema10 = this.computeEMA(10, w.prices.slice(-Math.min(10, w.prices.length)));
    const ema50arr = this.buf.getWindow(CONFIG.longWindow).prices;
    const ema50 = this.computeEMA(50, ema50arr.length >= 10 ? ema50arr : w.prices);
    if (ema10 === null || ema50 === null) return 0;
    return ema10 - ema50;
  }

  computeRSI(period = 14){
    const w = this.buf.getWindow(period + 1);
    if (w.prices.length < period + 1) return 50; // neutral default
    let gains = 0, losses = 0;
    for (let i = 1; i < w.prices.length; i++){
      const diff = w.prices[i] - w.prices[i-1];
      if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  computeATR(period = 14){
    const w = this.buf.getWindow(period + 1);
    if (w.prices.length < 2) return Math.max(0.0001, this.buf.lastPrice() ? this.buf.lastPrice() * 0.001 : 0.01);
    let trSum = 0, count = 0;
    for (let i = 1; i < w.highs.length; i++){
      const tr = Math.max(
        w.highs[i] - w.lows[i],
        Math.abs(w.highs[i] - w.prices[i-1]),
        Math.abs(w.lows[i] - w.prices[i-1])
      );
      trSum += tr;
      count++;
    }
    const atr = count ? trSum / count : 0;
    return atr > 0 ? atr : Math.max(0.0001, this.buf.lastPrice() * 0.0005);
  }

  computeBarrierDistanceRatio(barrierPrice){
    const cur = this.buf.lastPrice();
    if (cur === null) return null;
    const atr = this.computeATR();
    const distance = Math.abs(barrierPrice - cur);
    return atr > 0 ? distance / atr : 0;
  }

  classifyBarrierDistance(ratio){
    if (ratio === null) return 'UNKNOWN';
    if (ratio < 0.5) return 'EXTREMELY_CLOSE';
    if (ratio < 1) return 'NEAR';
    if (ratio < 2) return 'MEDIUM';
    return 'FAR';
  }

  computeMomentum(windowSize = 10){
    const w = this.buf.getWindow(windowSize);
    if (w.prices.length < 2) return 0;
    return w.prices[w.prices.length-1] - w.prices[0];
  }

  computeWickRatio(){
    // tick-derived synthetic body/wick: body = |close-open| over the fast window
    const w = this.buf.getWindow(CONFIG.fastWindow);
    if (w.prices.length < 2) return { body: 0, upperWick: 0, lowerWick: 0 };
    const open = w.prices[0];
    const close = w.prices[w.prices.length-1];
    const high = Math.max(...w.highs);
    const low = Math.min(...w.lows);
    const body = Math.abs(close - open) || 0.0001;
    const upperWick = (high - Math.max(open, close)) / body;
    const lowerWick = (Math.min(open, close) - low) / body;
    return { body: close - open, upperWick, lowerWick };
  }

  computeRangeExpansionCompression(){
    const range20 = this.buf.calculateRange(20);
    const range50 = this.buf.calculateRange(50);
    return { range20, range50, compressed: range50 > 0 && range20 < range50 * 0.5 };
  }

  /** Full feature snapshot for the current tick */
  computeAll(barrierPrice){
    const delta = this.computeDelta();
    const velocity = this.computeVelocity();
    const acceleration = this.computeAcceleration();
    const volFast = this.computeVolatility(CONFIG.fastWindow);
    const volMed = this.computeVolatility(CONFIG.mediumWindow);
    const volClass = this.classifyVolatility(volFast, volMed);
    const trendStrength = this.computeTrendStrength();
    const rsi = this.computeRSI(14);
    const atr = this.computeATR(14);
    const barrierRatio = barrierPrice !== null ? this.computeBarrierDistanceRatio(barrierPrice) : null;
    const barrierClass = this.classifyBarrierDistance(barrierRatio);
    const momentum = this.computeMomentum(10);
    const wick = this.computeWickRatio();
    const expComp = this.computeRangeExpansionCompression();

    return {
      delta, velocity, acceleration,
      volatility: volFast, volatilityClass: volClass,
      trendStrength, rsi, atr,
      barrierRatio, barrierClass,
      momentum, wick, expComp,
      avgVelocity: this._avgVelocityCache || velocity
    };
  }
}

/* ============================================================
   MODULE 3 — Pattern Detection Layer
   Detects: Compression, Expansion, Exhaustion, Mean Reversion
   ============================================================ */
class PatternDetector {
  constructor(){
    this.velocityHistory = [];
  }

  trackVelocity(v){
    this.velocityHistory.push(v);
    if (this.velocityHistory.length > 30) this.velocityHistory.shift();
  }

  detect(features, tickBuffer){
    this.trackVelocity(features.velocity);
    const avgVelocity = mean(this.velocityHistory);
    const velocityRising = this.velocityHistory.length > 3 &&
      this.velocityHistory[this.velocityHistory.length-1] > avgVelocity;
    const velocityFalling = this.velocityHistory.length > 3 &&
      this.velocityHistory[this.velocityHistory.length-1] < avgVelocity * 0.7;

    // Compression: range20 < range50 * 0.5
    const compressed = features.expComp.compressed;

    // Expansion: velocity > average AND volatility increasing
    const volatilityIncreasing = features.volatilityClass === 'HIGH' || features.volatilityClass === 'EXTREME';
    const expanding = features.velocity > avgVelocity && volatilityIncreasing;

    // Exhaustion: velocity falling AND acceleration negative AND large wicks
    const largeWicks = Math.abs(features.wick.upperWick) > 1.5 || Math.abs(features.wick.lowerWick) > 1.5;
    const exhausted = velocityFalling && features.acceleration < 0 && largeWicks;

    // Mean reversion: price oscillating around EMA repeatedly (proxy via trendStrength near 0 + alternating delta sign)
    const reverting = Math.abs(features.trendStrength) < (features.atr * 0.1) && this._isOscillating(tickBuffer);

    let pattern = 'NONE';
    if (compressed) pattern = 'MARKET_COMPRESSED';
    else if (expanding) pattern = 'MARKET_EXPANDING';
    else if (exhausted) pattern = 'MARKET_EXHAUSTED';
    else if (reverting) pattern = 'MARKET_REVERSAL';

    return { pattern, compressed, expanding, exhausted, reverting, avgVelocity, velocityRising, velocityFalling };
  }

  _isOscillating(tickBuffer){
    const w = tickBuffer.getWindow(10);
    if (w.prices.length < 6) return false;
    let signChanges = 0;
    for (let i = 2; i < w.prices.length; i++){
      const d1 = w.prices[i-1] - w.prices[i-2];
      const d2 = w.prices[i] - w.prices[i-1];
      if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) signChanges++;
    }
    return signChanges >= 4;
  }
}

/* ============================================================
   MODULE 4 — Market State Machine
   States: IDLE, COMPRESSED, BREAKOUT, TRENDING, EXHAUSTED,
           REVERSING, HIGH_RISK
   ============================================================ */
class MarketStateMachine {
  constructor(){
    this.state = 'IDLE';
    this.prevState = 'IDLE';
    this.stateEnteredAt = Date.now();
  }

  transition(patternResult, features){
    let next = this.state;

    // HIGH_RISK overrides everything: extreme volatility
    if (features.volatilityClass === 'EXTREME'){
      next = 'HIGH_RISK';
    }
    // Compression detected
    else if (patternResult.pattern === 'MARKET_COMPRESSED'){
      next = 'COMPRESSED';
    }
    // Breakout: was compressed, now expanding
    else if (this.state === 'COMPRESSED' && patternResult.pattern === 'MARKET_EXPANDING'){
      next = 'BREAKOUT';
    }
    // Acceleration positive + expanding => TRENDING
    else if (features.acceleration > 0 && (patternResult.pattern === 'MARKET_EXPANDING' || this.state === 'BREAKOUT')){
      next = 'TRENDING';
    }
    // Momentum weakening => EXHAUSTED
    else if (patternResult.pattern === 'MARKET_EXHAUSTED' || (this.state === 'TRENDING' && patternResult.velocityFalling)){
      next = 'EXHAUSTED';
    }
    // Reversal detected
    else if (patternResult.pattern === 'MARKET_REVERSAL'){
      next = 'REVERSING';
    }
    else if (patternResult.pattern === 'NONE' && this.state !== 'IDLE'){
      // Decay back toward IDLE if nothing detected for a while
      next = this.state; // hold state; avoid flapping
    }
    else {
      next = 'IDLE';
    }

    if (next !== this.state){
      this.prevState = this.state;
      this.state = next;
      this.stateEnteredAt = Date.now();
    }
    return this.state;
  }

  getBehavior(){
    const behaviors = {
      IDLE: { allowEntries: false, evaluate: 'none', note: 'No trade.' },
      COMPRESSED: { allowEntries: false, evaluate: 'none', note: 'Watch only. No entries.' },
      BREAKOUT: { allowEntries: true, evaluate: 'touch', note: 'Evaluate Touch.' },
      TRENDING: { allowEntries: true, evaluate: 'touch', note: 'Evaluate continuation probability.' },
      EXHAUSTED: { allowEntries: true, evaluate: 'notouch', note: 'Evaluate No Touch.' },
      REVERSING: { allowEntries: false, evaluate: 'none', note: 'No entries.' },
      HIGH_RISK: { allowEntries: false, evaluate: 'none', note: 'Block all trades.' }
    };
    return behaviors[this.state] || behaviors.IDLE;
  }
}

/* ============================================================
   MODULE 5 — Probability Scoring Engine
   Weighted feature scoring -> touch/no-touch probability +
   confidence, per the uploaded engine spec weights.
   ============================================================ */
class ProbabilityEngine {
  constructor(weights = CONFIG.weights){
    this.weights = weights;
  }

  /** Normalize a raw feature into a 0-1 "bullishness toward touch" score */
  _normVelocity(v, avgV){
    if (avgV <= 0) return 0.5;
    return clamp(v / (avgV * 2), 0, 1);
  }
  _normAcceleration(a){
    return clamp(0.5 + a / 10, 0, 1);
  }
  _normVolatility(volClass){
    const map = { LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, EXTREME: 0.95 };
    return map[volClass] !== undefined ? map[volClass] : 0.5;
  }
  _normHighLow(features, tickBuffer){
    const range20 = tickBuffer.calculateRange(20);
    const range50 = tickBuffer.calculateRange(50) || 1;
    return clamp(range20 / range50, 0, 1);
  }
  _normCandle(wick){
    const bodyMag = Math.abs(wick.body);
    return clamp(bodyMag / (bodyMag + 1), 0, 1);
  }
  _normEMA(trendStrength, atr){
    if (atr <= 0) return 0.5;
    return clamp(0.5 + (trendStrength / atr) * 0.5, 0, 1);
  }
  _normRSI(rsi){
    // Distance from 50 indicates directional conviction (touch-favorable)
    return clamp(Math.abs(rsi - 50) / 50, 0, 1);
  }
  _normATR(atr, refAtr){
    if (refAtr <= 0) return 0.5;
    return clamp(atr / (refAtr * 2), 0, 1);
  }
  _normPattern(patternResult){
    const map = {
      MARKET_EXPANDING: 0.85,
      MARKET_COMPRESSED: 0.35,
      MARKET_EXHAUSTED: 0.15,
      MARKET_REVERSAL: 0.2,
      NONE: 0.5
    };
    return map[patternResult.pattern] !== undefined ? map[patternResult.pattern] : 0.5;
  }

  score(features, patternResult, tickBuffer){
    const w = this.weights;
    const normVelocity = this._normVelocity(features.velocity, patternResult.avgVelocity);
    const normAccel = this._normAcceleration(features.acceleration);
    const normVol = this._normVolatility(features.volatilityClass);
    const normHL = this._normHighLow(features, tickBuffer);
    const normCandle = this._normCandle(features.wick);
    const normEMA = this._normEMA(features.trendStrength, features.atr);
    const normRSI = this._normRSI(features.rsi);
    const normATR = this._normATR(features.atr, features.atr); // self-normalized baseline
    const normPattern = this._normPattern(patternResult);

    const rawScore =
      normVelocity * w.velocity +
      normAccel * w.acceleration +
      normVol * w.volatility +
      normHL * w.highLowPattern +
      normCandle * w.candleStrength +
      normEMA * w.EMA +
      normRSI * w.RSI +
      normATR * w.ATR +
      normPattern * w.pattern;

    const totalWeight = Object.values(w).reduce((a,b)=>a+b,0);
    const touchProbability = clamp(rawScore / totalWeight, 0, 1);
    const noTouchProbability = clamp(1 - touchProbability, 0, 1);

    // Confidence: how far the score sits from the ambiguous 45-60 midband, scaled
    const distanceFromMid = Math.abs(touchProbability * 100 - 50);
    const confidence = clamp(distanceFromMid / 50, 0, 1);

    return {
      touchProbability: round(touchProbability, 4),
      noTouchProbability: round(noTouchProbability, 4),
      confidence: round(confidence, 4),
      rawScore: round(rawScore, 2),
      components: { normVelocity, normAccel, normVol, normHL, normCandle, normEMA, normRSI, normATR, normPattern }
    };
  }
}

/* ============================================================
   MODULE 6 — Trade Validation Layer
   Applies the strict rule sets from the engine spec for
   BUY_TOUCH / BUY_NOTOUCH / rejection bands.
   ============================================================ */
class TradeValidator {
  validate(probResult, features, patternResult, marketState){
    const touchScorePct = probResult.touchProbability * 100;
    const noTouchScorePct = probResult.noTouchProbability * 100;

    // Reject immediately: ambiguous middle bands or extreme volatility
    if (features.volatilityClass === 'EXTREME'){
      return { signal: 'NO_SIGNAL', reason: 'Volatility extreme — rejected.' };
    }
    if (touchScorePct >= 45 && touchScorePct <= 60){
      return { signal: 'NO_SIGNAL', reason: 'Touch score in ambiguous band (45-60).' };
    }
    if (noTouchScorePct >= 45 && noTouchScorePct <= 60){
      return { signal: 'NO_SIGNAL', reason: 'No Touch score in ambiguous band (45-60).' };
    }

    // Touch validation
    const touchOk =
      probResult.touchProbability > 0.75 &&
      features.barrierRatio !== null && features.barrierRatio < 1 &&
      marketState === 'TRENDING' &&
      features.volatilityClass !== 'EXTREME';

    if (touchOk){
      return {
        signal: 'BUY_TOUCH',
        reason: `Touch P=${touchScorePct.toFixed(1)}%, barrierRatio=${features.barrierRatio.toFixed(2)}, state=TRENDING`
      };
    }

    // No Touch validation
    const noTouchOk =
      probResult.noTouchProbability > 0.75 &&
      features.barrierRatio !== null && features.barrierRatio > 2 &&
      marketState === 'EXHAUSTED' &&
      features.volatilityClass !== 'HIGH';

    if (noTouchOk){
      return {
        signal: 'BUY_NOTOUCH',
        reason: `No Touch P=${noTouchScorePct.toFixed(1)}%, barrierRatio=${features.barrierRatio.toFixed(2)}, state=EXHAUSTED`
      };
    }

    return { signal: 'NO_SIGNAL', reason: 'Conditions not met.' };
  }
}

/* ============================================================
   MODULE 7 — Risk Management Engine
   HARD ENFORCEMENT: per-trade %, daily drawdown %, consecutive
   loss limit + cooldown, volatility protection, kill switch.
   This module is the final gate before any buy() call — if it
   says no, no trade fires, regardless of signal strength.
   ============================================================ */
class RiskEngine {
  constructor(state){
    this.state = state;
  }

  /** Call once balance is known to anchor daily drawdown baseline */
  initSession(balance){
    if (this.state.risk.sessionStartBalance === null){
      this.state.risk.sessionStartBalance = balance;
    }
  }

  recordTickPassed(){
    this.state.risk.ticksSinceLastTrade++;
  }

  /** Returns {allowed: bool, reason: string} */
  canTrade(){
    if (this.state.killSwitchEngaged){
      return { allowed: false, reason: 'Kill switch engaged.' };
    }
    if (this.state.risk.tradingPaused){
      const now = Date.now();
      if (this.state.risk.pauseUntil && now < this.state.risk.pauseUntil){
        const remainMin = Math.ceil((this.state.risk.pauseUntil - now) / 60000);
        return { allowed: false, reason: `Trading paused (cooldown). ${remainMin} min remaining.` };
      } else {
        // cooldown expired
        this.state.risk.tradingPaused = false;
        this.state.risk.pauseUntil = null;
        this.state.risk.consecutiveLosses = 0;
        Logger.info('Cooldown expired — trading resumed, consecutive loss counter reset.');
      }
    }
    if (this.state.risk.ticksSinceLastTrade < CONFIG.reentryCooldownTicks){
      return { allowed: false, reason: `Re-entry cooldown: ${CONFIG.reentryCooldownTicks - this.state.risk.ticksSinceLastTrade} ticks remaining.` };
    }
    // Daily drawdown check
    const dd = this.getDailyDrawdownPct();
    if (dd >= this.state.risk.maxDailyDrawdownPct){
      this.engagePause('Max daily drawdown reached.');
      return { allowed: false, reason: `Max daily drawdown (${this.state.risk.maxDailyDrawdownPct}%) reached.` };
    }
    if (this.state.risk.consecutiveLosses >= this.state.risk.maxConsecutiveLosses){
      this.engagePause('Max consecutive losses reached.');
      return { allowed: false, reason: `Max consecutive losses (${this.state.risk.maxConsecutiveLosses}) reached.` };
    }
    return { allowed: true, reason: 'OK' };
  }

  engagePause(reason){
    this.state.risk.tradingPaused = true;
    this.state.risk.pauseUntil = Date.now() + this.state.risk.cooldownMinutes * 60000;
    Logger.warn(`Risk engine paused trading: ${reason} Cooldown ${this.state.risk.cooldownMinutes}min.`);
  }

  getDailyDrawdownPct(){
    const start = this.state.risk.sessionStartBalance;
    if (!start || start <= 0) return 0;
    const current = start + this.state.risk.sessionPL;
    const dd = ((start - current) / start) * 100;
    return Math.max(0, dd);
  }

  /** Computes stake for next trade based on risk-per-trade % of current balance */
  computeStake(currentBalance){
    if (!currentBalance || currentBalance <= 0) return this.state.contract.stake;
    const riskAmt = currentBalance * (this.state.risk.riskPerTradePct / 100);
    const base = this.state.contract.stake;
    // Use risk-derived stake but never exceed a sane multiple of configured base stake,
    // and never below Deriv's practical minimum.
    const stake = clamp(riskAmt, 0.35, base * 5);
    return round(stake, 2);
  }

  recordTradeResult(won, profit){
    this.state.risk.sessionPL += profit;
    this.state.risk.tradesToday++;
    this.state.risk.ticksSinceLastTrade = 0;
    if (won){
      this.state.risk.consecutiveLosses = 0;
    } else {
      this.state.risk.consecutiveLosses++;
    }
  }

  engageKillSwitch(){
    this.state.killSwitchEngaged = true;
    Logger.error('KILL SWITCH ENGAGED — all trading halted. Open contracts will continue to settle but no new trades will be placed.');
  }

  releaseKillSwitch(){
    this.state.killSwitchEngaged = false;
    Logger.info('Kill switch released.');
  }
}

/* ============================================================
   MODULE 8 — Deriv API Service
   REST (api.derivws.com) for account/OTP, WebSocket (OTP-auth
   or public) for ticks, proposals, buy, contract monitoring.
   Uses the CURRENT Deriv API system per project instructions,
   not the legacy binaryws.com endpoint.
   ============================================================ */
class DerivApiService {
  constructor(state){
    this.state = state;
  }

  get headers(){
    return {
      'Authorization': `Bearer ${this.state.auth.token}`,
      'Deriv-App-ID': this.state.auth.appId
    };
  }

  async _restCall(method, path, body){
    const opts = { method, headers: { ...this.headers } };
    if (body){
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${CONFIG.apiBase}${path}`, opts);
    const data = await res.json().catch(()=> ({}));
    if (!res.ok){
      const code = data.errors?.[0]?.code || 'UnknownError';
      const msg = data.errors?.[0]?.message || `HTTP ${res.status}`;
      throw new Error(`[${code}] ${msg}`);
    }
    return data;
  }

  async getAccounts(){
    const data = await this._restCall('GET', '/trading/v1/options/accounts');
    return Array.isArray(data.data) ? data.data : [data.data];
  }

  async createAccount(accountType){
    const data = await this._restCall('POST', '/trading/v1/options/accounts', {
      currency: 'USD', group: 'row', account_type: accountType
    });
    return Array.isArray(data.data) ? data.data[0] : data.data;
  }

  async getOtpUrl(accountId){
    const data = await this._restCall('POST', `/trading/v1/options/accounts/${accountId}/otp`);
    return data.data.url;
  }

  async resetDemoBalance(accountId){
    const data = await this._restCall('POST', `/trading/v1/options/accounts/${accountId}/reset-demo-balance`);
    return data.data;
  }

  /* ---------- WebSocket layer ---------- */

  connectPublic(){
    return this._connect(CONFIG.wsPublic);
  }

  async connectAuthenticated(accountId){
    const wsUrl = await this.getOtpUrl(accountId); // OTP is short-lived — connect immediately
    return this._connect(wsUrl);
  }

  _connect(url){
    return new Promise((resolve, reject) => {
      const conn = this.state.connection;
      conn.status = 'connecting';
      UI.renderConnectionStatus();

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e){
        conn.status = 'error';
        UI.renderConnectionStatus();
        reject(e);
        return;
      }
      conn.ws = ws;

      ws.onopen = () => {
        conn.status = 'connected';
        conn.reconnectAttempts = 0;
        UI.renderConnectionStatus();
        Logger.info('WebSocket connected.');
        this._restoreSubscriptions();
        resolve(ws);
      };

      ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch(e){ return; }
        this._route(data);
      };

      ws.onerror = (err) => {
        conn.status = 'error';
        UI.renderConnectionStatus();
        Logger.error('WebSocket error.');
      };

      ws.onclose = () => {
        const wasConnected = conn.status === 'connected';
        conn.status = 'disconnected';
        UI.renderConnectionStatus();
        if (wasConnected) Logger.warn('WebSocket disconnected.');
        this._scheduleReconnect(url);
      };
    });
  }

  _scheduleReconnect(url){
    const conn = this.state.connection;
    if (this.state.killSwitchEngaged) return;
    if (conn.reconnectAttempts >= conn.maxReconnectAttempts){
      Logger.error('Max reconnect attempts reached. Manual reconnect required.');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
    conn.reconnectAttempts++;
    Logger.warn(`Reconnecting in ${Math.round(delay/1000)}s (attempt ${conn.reconnectAttempts})...`);
    setTimeout(async () => {
      try {
        if (this.state.auth.accountId && this.state.auth.token){
          await this.connectAuthenticated(this.state.auth.accountId);
        } else {
          await this.connectPublic();
        }
      } catch(e){
        Logger.error(`Reconnect failed: ${e.message}`);
      }
    }, delay);
  }

  _restoreSubscriptions(){
    const conn = this.state.connection;
    for (const [, command] of conn.subscriptions){
      conn.reqId++;
      conn.ws.send(JSON.stringify({ ...command, req_id: conn.reqId }));
    }
  }

  send(command){
    return new Promise((resolve, reject) => {
      const conn = this.state.connection;
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN){
        reject(new Error('WebSocket not connected.'));
        return;
      }
      conn.reqId++;
      const reqId = conn.reqId;
      const msg = { ...command, req_id: reqId };

      if (command.subscribe){
        conn.subscriptions.set(reqId, command);
      }
      conn.pending.set(reqId, { resolve, reject });
      conn.ws.send(JSON.stringify(msg));

      // Timeout safeguard
      setTimeout(() => {
        if (conn.pending.has(reqId)){
          conn.pending.delete(reqId);
          reject(new Error('Request timed out.'));
        }
      }, 15000);
    });
  }

  _route(data){
    const conn = this.state.connection;

    if (data.req_id && conn.pending.has(data.req_id)){
      const { resolve, reject } = conn.pending.get(data.req_id);
      conn.pending.delete(data.req_id);
      if (data.error){
        reject(new Error(`[${data.error.code}] ${data.error.message}`));
      } else {
        resolve(data);
      }
    }

    if (data.error){
      Logger.error(`API error [${data.error.code}]: ${data.error.message}`);
    }

    switch (data.msg_type){
      case 'tick':
        Engine.onTick(data.tick);
        break;
      case 'balance':
        this.state.account.balance = data.balance.balance;
        this.state.account.currency = data.balance.currency;
        this.state.account.loginid = data.balance.loginid;
        Risk.initSession(data.balance.balance);
        UI.renderAccount();
        break;
      case 'proposal':
        Engine.onProposal(data);
        break;
      case 'buy':
        Engine.onBuyConfirmed(data);
        break;
      case 'proposal_open_contract':
        Engine.onContractUpdate(data.proposal_open_contract);
        break;
      default:
        break;
    }
  }

  async forgetAll(type){
    try { await this.send({ forget_all: type }); } catch(e){ /* non-fatal */ }
  }

  disconnect(){
    const conn = this.state.connection;
    conn.maxReconnectAttempts = 0;
    if (conn.ws) conn.ws.close();
  }
}

/* ============================================================
   MODULE 9 — Trade Record Factory (Database Structure)
   ============================================================ */
function createTradeRecord(opts){
  return {
    id: uid(),
    market: opts.market,
    tradeType: opts.tradeType,       // 'TOUCH' | 'NOTOUCH'
    entryPrice: opts.entryPrice,
    barrier: opts.barrier,
    duration: opts.duration,
    durationUnit: opts.durationUnit,
    stake: opts.stake,
    touchProbability: opts.touchProbability,
    noTouchProbability: opts.noTouchProbability,
    confidence: opts.confidence,
    marketState: opts.marketState,
    contractId: null,
    proposalId: null,
    result: 'pending',               // 'pending' | 'win' | 'loss'
    profit: 0,
    timestamp: nowIso()
  };
}

/* ============================================================
   PERFORMANCE ANALYTICS
   ============================================================ */
const Analytics = {
  summarize(){
    const closed = STATE.trades.filter(t => t.result === 'win' || t.result === 'loss');
    if (!closed.length){
      return { winRate: null, touchAcc: null, noTouchAcc: null, profitFactor: null, ev: null, maxDD: null };
    }
    const wins = closed.filter(t => t.result === 'win');
    const losses = closed.filter(t => t.result === 'loss');
    const winRate = wins.length / closed.length;

    const touchClosed = closed.filter(t => t.tradeType === 'TOUCH');
    const noTouchClosed = closed.filter(t => t.tradeType === 'NOTOUCH');
    const touchAcc = touchClosed.length ? touchClosed.filter(t=>t.result==='win').length / touchClosed.length : null;
    const noTouchAcc = noTouchClosed.length ? noTouchClosed.filter(t=>t.result==='win').length / noTouchClosed.length : null;

    const grossWin = wins.reduce((s,t)=> s + Math.max(0,t.profit), 0);
    const grossLoss = Math.abs(losses.reduce((s,t)=> s + Math.min(0,t.profit), 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);

    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const lossRate = 1 - winRate;
    const ev = (winRate * avgWin) - (lossRate * avgLoss);

    // Max drawdown across cumulative P&L curve
    let cum = 0, peak = 0, maxDD = 0;
    for (const t of closed){
      cum += t.profit;
      peak = Math.max(peak, cum);
      maxDD = Math.max(maxDD, peak - cum);
    }

    return { winRate, touchAcc, noTouchAcc, profitFactor, ev, maxDD };
  }
};

/* ============================================================
   CENTRAL ENGINE — orchestrates modules 1-9 per tick, and
   drives the execution layer: proposal() -> buy() ->
   proposal_open_contract() -> monitor -> saveTrade()
   ============================================================ */
const Engine = {
  tickBuffer: null,
  featureEngine: null,
  patternDetector: null,
  stateMachine: null,
  probabilityEngine: null,
  validator: null,
  api: null,
  awaitingProposal: false,
  lastProposal: null,
  tickTimestampsForRate: [],

  init(){
    this.tickBuffer = new TickBufferEngine();
    this.featureEngine = new FeatureEngine(this.tickBuffer);
    this.patternDetector = new PatternDetector();
    this.stateMachine = new MarketStateMachine();
    this.probabilityEngine = new ProbabilityEngine();
    this.validator = new TradeValidator();
    this.api = new DerivApiService(STATE);
  },

  /** Computes a dynamic barrier given current spot + configured offset, used for proposal barrier */
  computeBarrier(forTouch){
    const spot = this.tickBuffer.lastPrice();
    if (spot === null) return null;
    const atr = this.featureEngine.computeATR();
    const offset = STATE.contract.barrierOffset;
    // Touch trades use a NEAR barrier (small ATR multiple); No Touch uses a FAR barrier
    const mult = forTouch ? offset : offset * 3;
    const distance = Math.max(atr * mult, 0.001);
    // Direction: favor the side with stronger recent momentum
    const momentum = this.featureEngine.computeMomentum(10);
    const sign = momentum >= 0 ? 1 : -1;
    return round(spot + sign * distance, 4);
  },

  onTick(tick){
    const price = tick.quote;
    const time = tick.epoch * 1000;

    this.tickBuffer.addTick(price, time);
    STATE.market.lastTick = price;
    STATE.market.lastTickTime = time;
    Risk.recordTickPassed();

    this.tickTimestampsForRate.push(Date.now());
    this.tickTimestampsForRate = this.tickTimestampsForRate.filter(t => Date.now() - t < 1000);

    UI.renderChart(this.tickBuffer);
    UI.renderSpot(price);

    if (!this.tickBuffer.isReady(20)){
      UI.renderBufferFill(this.tickBuffer.size());
      return; // not enough data yet
    }

    // Use a provisional barrier (near, for touch-style evaluation) purely for feature/ratio display.
    // The actual trade barrier is computed at signal time based on which side qualifies.
    const provisionalBarrier = this.computeBarrier(true);
    const features = this.featureEngine.computeAll(provisionalBarrier);
    const patternResult = this.patternDetector.detect(features, this.tickBuffer);
    const marketState = this.stateMachine.transition(patternResult, features);
    const probResult = this.probabilityEngine.score(features, patternResult, this.tickBuffer);
    const validation = this.validator.validate(probResult, features, patternResult, marketState);

    UI.renderFeatures(features, patternResult, marketState);
    UI.renderProbabilities(probResult);
    UI.renderBufferFill(this.tickBuffer.size());

    STATE.currentSignal = { ...validation, probResult, features, marketState, time: Date.now() };
    UI.renderSignal(STATE.currentSignal);

    this.evaluateExecution(STATE.currentSignal);
  },

  evaluateExecution(signalCtx){
    if (signalCtx.signal === 'NO_SIGNAL') return;
    if (this.awaitingProposal) return; // one in flight at a time

    const gate = Risk.canTrade();
    UI.renderRiskStatus(gate);
    if (!gate.allowed){
      return;
    }

    if (STATE.risk.autoExecute){
      this.executeSignal(signalCtx);
    } else {
      STATE.pendingManualSignal = signalCtx;
      UI.showManualConfirm(signalCtx);
    }
  },

  async executeSignal(signalCtx){
    if (STATE.connection.status !== 'connected'){
      Logger.error('Cannot execute: not connected.');
      return;
    }
    const gate = Risk.canTrade();
    if (!gate.allowed){
      Logger.warn(`Execution blocked: ${gate.reason}`);
      return;
    }

    this.awaitingProposal = true;
    const isTouch = signalCtx.signal === 'BUY_TOUCH';
    const contractType = isTouch ? 'ONETOUCH' : 'NOTOUCH';
    const barrier = this.computeBarrier(isTouch);
    const spot = this.tickBuffer.lastPrice();
    const stake = Risk.computeStake(STATE.account.balance);

    Logger.info(`Requesting proposal: ${contractType} barrier=${barrier} stake=$${stake}`);

    try {
      const proposalData = await this.api.send({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: contractType,
        currency: STATE.account.currency || 'USD',
        duration: STATE.contract.duration,
        duration_unit: STATE.contract.durationUnit,
        underlying_symbol: STATE.market.symbol,
        barrier: String(barrier)
      });

      if (!proposalData.proposal){
        Logger.error('Proposal response missing proposal data.');
        this.awaitingProposal = false;
        return;
      }

      const proposalId = proposalData.proposal.id;
      const askPrice = proposalData.proposal.ask_price;
      Logger.info(`Proposal received: ${contractType} @ $${askPrice} (id ${proposalId})`);

      const record = createTradeRecord({
        market: STATE.market.symbol,
        tradeType: isTouch ? 'TOUCH' : 'NOTOUCH',
        entryPrice: spot,
        barrier,
        duration: STATE.contract.duration,
        durationUnit: STATE.contract.durationUnit,
        stake: askPrice,
        touchProbability: signalCtx.probResult.touchProbability,
        noTouchProbability: signalCtx.probResult.noTouchProbability,
        confidence: signalCtx.probResult.confidence,
        marketState: signalCtx.marketState
      });
      record.proposalId = proposalId;

      const buyData = await this.api.send({ buy: proposalId, price: askPrice });
      this.onBuyConfirmedDirect(buyData, record);

    } catch(e){
      Logger.error(`Execution failed: ${e.message}`);
    } finally {
      this.awaitingProposal = false;
    }
  },

  onBuyConfirmedDirect(buyData, record){
    if (!buyData.buy){
      Logger.error('Buy response missing data.');
      return;
    }
    record.contractId = buyData.buy.contract_id;
    record.stake = buyData.buy.buy_price;
    STATE.trades.unshift(record);
    STATE.openContracts.set(record.contractId, record);
    Logger.trade(`BOUGHT ${record.tradeType} | contract ${record.contractId} | $${record.stake}`);
    UI.renderTradeHistory();

    // Monitor the contract
    this.api.send({
      proposal_open_contract: 1,
      contract_id: record.contractId,
      subscribe: 1
    }).catch(e => Logger.error(`Monitor subscription failed: ${e.message}`));
  },

  onProposal(data){
    // Handled inline via send() promise resolution in executeSignal; this is a fallback log hook
  },

  onBuyConfirmed(data){
    // Handled inline via send() promise in executeSignal for the primary flow.
  },

  onContractUpdate(contract){
    const record = STATE.openContracts.get(contract.contract_id);
    if (!record) return;

    if (contract.is_sold){
      const profit = contract.profit;
      const won = profit > 0;
      record.result = won ? 'win' : 'loss';
      record.profit = round(profit, 2);
      STATE.openContracts.delete(contract.contract_id);

      Risk.recordTradeResult(won, profit);
      Logger.trade(`${won ? 'WIN' : 'LOSS'} | contract ${contract.contract_id} | P&L $${record.profit}`);

      UI.renderTradeHistory();
      UI.renderRiskPanel();
      UI.renderPerformance();
    }
  }
};

const Risk = new RiskEngine(STATE);

/* ============================================================
   UI RENDERING LAYER
   ============================================================ */
const UI = {
  els: {},
  chartCtx: null,

  init(){
    const ids = [
      'accountModeToggle','btnDemo','btnReal','connDot','connLabel','btnConnect','btnKillSwitch',
      'realBanner','appIdInput','patInput','acctBalance','acctCurrency','acctId',
      'marketSelect','stakeInput','durationInput','durationUnitSelect','barrierOffsetInput',
      'riskPerTradeInput','maxDrawdownInput','maxLossesInput','cooldownInput','autoExecSwitch',
      'tickCanvas','spotPrice','tickRate','bufferFill','tickStreamStatus',
      'stateBadge','featVelocity','featVolatility','featTrend','featBarrierRatio','featPattern','featRSI',
      'touchProbVal','touchProbFill','noTouchProbVal','noTouchProbFill','confVal','confFill','riskScoreVal','riskScoreFill',
      'signalText','signalSub','manualConfirmWrap','btnManualExecute',
      'riskTradingStatus','riskSessionPL','riskDrawdown','riskConsecLosses','riskCurrentStake','riskTradeCount','riskCooldown',
      'perfWinRate','perfTouchAcc','perfNoTouchAcc','perfProfitFactor','perfEV','perfMaxDD',
      'tradeHistoryBody','tradeHistoryEmpty','logFeed'
    ];
    ids.forEach(id => this.els[id] = document.getElementById(id));
    this.chartCtx = this.els.tickCanvas.getContext('2d');
    this._resizeCanvas();
    window.addEventListener('resize', () => this._resizeCanvas());
  },

  _resizeCanvas(){
    const c = this.els.tickCanvas;
    const rect = c.parentElement.getBoundingClientRect();
    c.width = rect.width * devicePixelRatio;
    c.height = rect.height * devicePixelRatio;
  },

  renderConnectionStatus(){
    const status = STATE.connection.status;
    this.els.connDot.className = 'conn-dot ' + (status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : '');
    const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected', error: 'Connection error' };
    this.els.connLabel.textContent = labels[status] || status;
    this.els.btnConnect.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    this.els.btnKillSwitch.disabled = status !== 'connected';
  },

  renderAccountMode(){
    const isReal = STATE.accountMode === 'real';
    this.els.btnDemo.classList.toggle('active', !isReal);
    this.els.btnReal.classList.toggle('active', isReal);
    this.els.realBanner.classList.toggle('show', isReal);
  },

  renderAccount(){
    if (STATE.account.balance !== null){
      this.els.acctBalance.textContent = round(STATE.account.balance, 2).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
      this.els.acctCurrency.textContent = STATE.account.currency || '';
      this.els.acctId.textContent = STATE.account.loginid || '';
    }
  },

  renderChart(tickBuffer){
    const ctx = this.chartCtx;
    const c = this.els.tickCanvas;
    const w = c.width, h = c.height;
    ctx.clearRect(0,0,w,h);

    const prices = tickBuffer.getWindow(100).prices;
    if (prices.length < 2) return;

    const min = Math.min(...prices), max = Math.max(...prices);
    const range = (max - min) || 1;
    const padding = h * 0.1;

    ctx.strokeStyle = '#2fd9c4';
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.beginPath();
    prices.forEach((p, i) => {
      const x = (i / (prices.length - 1)) * w;
      const y = h - padding - ((p - min) / range) * (h - padding * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // gradient fill under line
    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0, 'rgba(47,217,196,0.18)');
    grad.addColorStop(1, 'rgba(47,217,196,0)');
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  },

  renderSpot(price){
    this.els.spotPrice.textContent = round(price, 4);
    this.els.tickRate.textContent = `${Engine.tickTimestampsForRate.length} ticks/s`;
  },

  renderBufferFill(n){
    this.els.bufferFill.textContent = `Buffer: ${n}/${CONFIG.tickBufferMax}`;
  },

  renderFeatures(features, patternResult, marketState){
    this.els.stateBadge.textContent = marketState;
    this.els.stateBadge.className = 'state-badge state-' + marketState;
    this.els.featVelocity.textContent = round(features.velocity, 2);
    this.els.featVolatility.textContent = features.volatilityClass;
    this.els.featTrend.textContent = round(features.trendStrength, 3);
    this.els.featBarrierRatio.textContent = features.barrierRatio !== null ? round(features.barrierRatio, 2) + ' (' + features.barrierClass + ')' : '—';
    this.els.featPattern.textContent = patternResult.pattern.replace('MARKET_','');
    this.els.featRSI.textContent = round(features.rsi, 1);
  },

  renderProbabilities(probResult){
    const tp = Math.round(probResult.touchProbability * 100);
    const ntp = Math.round(probResult.noTouchProbability * 100);
    const conf = Math.round(probResult.confidence * 100);
    this.els.touchProbVal.textContent = tp + '%';
    this.els.touchProbFill.style.width = tp + '%';
    this.els.noTouchProbVal.textContent = ntp + '%';
    this.els.noTouchProbFill.style.width = ntp + '%';
    this.els.confVal.textContent = conf + '%';
    this.els.confFill.style.width = conf + '%';

    const dd = Risk.getDailyDrawdownPct();
    const riskPct = Math.round(clamp(dd / STATE.risk.maxDailyDrawdownPct, 0, 1) * 100);
    this.els.riskScoreVal.textContent = riskPct + '%';
    this.els.riskScoreFill.style.width = riskPct + '%';
  },

  renderSignal(ctx){
    const map = {
      BUY_TOUCH: { text: 'BUY TOUCH', cls: 'touch' },
      BUY_NOTOUCH: { text: 'BUY NO TOUCH', cls: 'notouch' },
      NO_SIGNAL: { text: 'NO SIGNAL', cls: 'none' }
    };
    const m = map[ctx.signal] || map.NO_SIGNAL;
    this.els.signalText.textContent = m.text;
    this.els.signalText.className = 'signal-text ' + m.cls;
    this.els.signalSub.textContent = ctx.reason;
    if (ctx.signal === 'NO_SIGNAL'){
      this.els.manualConfirmWrap.style.display = 'none';
    }
  },

  showManualConfirm(ctx){
    this.els.manualConfirmWrap.style.display = 'block';
  },

  hideManualConfirm(){
    this.els.manualConfirmWrap.style.display = 'none';
    STATE.pendingManualSignal = null;
  },

  renderRiskStatus(gate){
    this.els.riskTradingStatus.textContent = gate.allowed ? 'Active' : gate.reason;
    this.els.riskTradingStatus.className = 'value ' + (gate.allowed ? 'good' : 'bad');
  },

  renderRiskPanel(){
    const pl = STATE.risk.sessionPL;
    this.els.riskSessionPL.textContent = (pl >= 0 ? '+' : '') + '$' + round(pl,2).toFixed(2);
    this.els.riskSessionPL.className = 'value ' + (pl >= 0 ? 'good' : 'bad');

    const dd = Risk.getDailyDrawdownPct();
    this.els.riskDrawdown.textContent = round(dd,2) + '%';
    this.els.riskDrawdown.className = 'value ' + (dd >= STATE.risk.maxDailyDrawdownPct * 0.7 ? 'bad' : '');

    this.els.riskConsecLosses.textContent = STATE.risk.consecutiveLosses;
    this.els.riskConsecLosses.className = 'value ' + (STATE.risk.consecutiveLosses >= STATE.risk.maxConsecutiveLosses - 1 ? 'bad' : '');

    this.els.riskCurrentStake.textContent = '$' + Risk.computeStake(STATE.account.balance).toFixed(2);
    this.els.riskTradeCount.textContent = STATE.risk.tradesToday;

    if (STATE.risk.tradingPaused && STATE.risk.pauseUntil){
      const remainMin = Math.max(0, Math.ceil((STATE.risk.pauseUntil - Date.now())/60000));
      this.els.riskCooldown.textContent = `${remainMin} min`;
      this.els.riskCooldown.className = 'value bad';
    } else {
      this.els.riskCooldown.textContent = '—';
      this.els.riskCooldown.className = 'value';
    }
  },

  renderPerformance(){
    const s = Analytics.summarize();
    this.els.perfWinRate.textContent = s.winRate !== null ? round(s.winRate*100,1) + '%' : '—';
    this.els.perfTouchAcc.textContent = s.touchAcc !== null ? round(s.touchAcc*100,1) + '%' : '—';
    this.els.perfNoTouchAcc.textContent = s.noTouchAcc !== null ? round(s.noTouchAcc*100,1) + '%' : '—';
    this.els.perfProfitFactor.textContent = s.profitFactor !== null ? (s.profitFactor === Infinity ? '∞' : round(s.profitFactor,2)) : '—';
    this.els.perfEV.textContent = s.ev !== null ? '$' + round(s.ev,3) : '—';
    this.els.perfMaxDD.textContent = s.maxDD !== null ? '$' + round(s.maxDD,2) : '—';
  },

  renderTradeHistory(){
    const body = this.els.tradeHistoryBody;
    body.innerHTML = '';
    const trades = STATE.trades.slice(0, 50);
    this.els.tradeHistoryEmpty.style.display = trades.length ? 'none' : 'block';
    trades.forEach(t => {
      const tr = document.createElement('tr');
      const time = new Date(t.timestamp).toLocaleTimeString();
      const resultCls = t.result === 'win' ? 'win' : t.result === 'loss' ? 'loss' : 'pending';
      const resultText = t.result === 'pending' ? 'Open' : t.result.toUpperCase();
      const plText = t.result === 'pending' ? '—' : (t.profit >= 0 ? '+' : '') + '$' + round(t.profit,2).toFixed(2);
      tr.innerHTML = `
        <td>${time}</td>
        <td>${t.tradeType}</td>
        <td>$${round(t.stake,2).toFixed(2)}</td>
        <td class="${resultCls}">${resultText}</td>
        <td class="${resultCls}">${plText}</td>
      `;
      body.appendChild(tr);
    });
  }
};

/* ============================================================
   EVENT WIRING + BOOTSTRAP
   ============================================================ */
function syncConfigFromInputs(){
  STATE.auth.appId = UI.els.appIdInput.value.trim();
  STATE.auth.token = UI.els.patInput.value.trim();
  STATE.market.symbol = UI.els.marketSelect.value;
  STATE.contract.stake = parseFloat(UI.els.stakeInput.value) || 1;
  STATE.contract.duration = parseInt(UI.els.durationInput.value) || 5;
  STATE.contract.durationUnit = UI.els.durationUnitSelect.value;
  STATE.contract.barrierOffset = parseFloat(UI.els.barrierOffsetInput.value) || 0.5;
  STATE.risk.riskPerTradePct = parseFloat(UI.els.riskPerTradeInput.value) || 1;
  STATE.risk.maxDailyDrawdownPct = parseFloat(UI.els.maxDrawdownInput.value) || 5;
  STATE.risk.maxConsecutiveLosses = parseInt(UI.els.maxLossesInput.value) || 3;
  STATE.risk.cooldownMinutes = parseInt(UI.els.cooldownInput.value) || 30;
}

async function handleConnect(){
  if (STATE.connection.status === 'connected'){
    Engine.api.disconnect();
    STATE.connection.subscriptions.clear();
    Logger.info('Disconnected by user.');
    return;
  }

  syncConfigFromInputs();

  if (!STATE.auth.appId){
    Logger.error('App ID is required to connect.');
    return;
  }

  try {
    if (STATE.auth.token){
      // Authenticated flow: fetch accounts, pick one matching mode, connect via OTP
      Logger.info('Fetching accounts...');
      const accounts = await Engine.api.getAccounts();
      STATE.auth.accounts = accounts;

      let account = accounts.find(a => a.account_type === STATE.accountMode && a.status === 'active');
      if (!account){
        Logger.warn(`No active ${STATE.accountMode} account found — attempting to create one.`);
        account = await Engine.api.createAccount(STATE.accountMode);
      }
      STATE.auth.accountId = account.account_id;
      STATE.account.balance = account.balance;
      STATE.account.currency = account.currency;
      STATE.account.loginid = account.account_id;
      UI.renderAccount();
      Risk.initSession(account.balance);

      Logger.info(`Connecting authenticated WebSocket for ${account.account_id} (${STATE.accountMode})...`);
      await Engine.api.connectAuthenticated(account.account_id);

      await Engine.api.send({ balance: 1, subscribe: 1 });
    } else {
      Logger.info('No PAT provided — connecting to public market-data WebSocket only (no trading).');
      await Engine.api.connectPublic();
    }

    // Subscribe to tick stream for selected market
    await Engine.api.send({ ticks: STATE.market.symbol, subscribe: 1 });
    Logger.info(`Subscribed to ticks for ${STATE.market.symbol}.`);

  } catch(e){
    Logger.error(`Connection failed: ${e.message}`);
    STATE.connection.status = 'error';
    UI.renderConnectionStatus();
  }
}

function handleKillSwitch(){
  if (STATE.killSwitchEngaged){
    Risk.releaseKillSwitch();
    UI.els.btnKillSwitch.textContent = '⏹ Stop All';
  } else {
    Risk.engageKillSwitch();
    UI.els.btnKillSwitch.textContent = '▶ Resume';
    UI.hideManualConfirm();
  }
}

function wireEvents(){
  UI.els.btnDemo.addEventListener('click', () => {
    if (STATE.accountMode === 'demo') return;
    STATE.accountMode = 'demo';
    UI.renderAccountMode();
    Logger.info('Switched to DEMO account mode. Reconnect to apply.');
  });

  UI.els.btnReal.addEventListener('click', () => {
    if (STATE.accountMode === 'real') return;
    const confirmed = window.confirm(
      'You are switching to REAL money trading. Trades placed in this mode use real funds and real risk. Are you sure you want to continue?'
    );
    if (!confirmed) return;
    STATE.accountMode = 'real';
    UI.renderAccountMode();
    Logger.warn('Switched to REAL account mode. Reconnect to apply. Real funds are now at risk when trading.');
  });

  UI.els.btnConnect.addEventListener('click', handleConnect);
  UI.els.btnKillSwitch.addEventListener('click', handleKillSwitch);

  UI.els.autoExecSwitch.addEventListener('click', () => {
    STATE.risk.autoExecute = !STATE.risk.autoExecute;
    UI.els.autoExecSwitch.classList.toggle('on', STATE.risk.autoExecute);
    Logger.info(`Auto-execute ${STATE.risk.autoExecute ? 'enabled' : 'disabled'}.`);
  });

  UI.els.btnManualExecute.addEventListener('click', () => {
    if (STATE.pendingManualSignal){
      Engine.executeSignal(STATE.pendingManualSignal);
      UI.hideManualConfirm();
    }
  });

  // Live-sync simple config fields (do not require reconnect)
  ['stakeInput','durationInput','durationUnitSelect','barrierOffsetInput',
   'riskPerTradeInput','maxDrawdownInput','maxLossesInput','cooldownInput'].forEach(id => {
    UI.els[id].addEventListener('change', syncConfigFromInputs);
  });

  UI.els.marketSelect.addEventListener('change', async () => {
    const newSymbol = UI.els.marketSelect.value;
    if (STATE.connection.status === 'connected'){
      await Engine.api.forgetAll('ticks');
      Engine.tickBuffer = new TickBufferEngine();
      Engine.featureEngine = new FeatureEngine(Engine.tickBuffer);
      Engine.patternDetector = new PatternDetector();
      Engine.stateMachine = new MarketStateMachine();
    }
    STATE.market.symbol = newSymbol;
    if (STATE.connection.status === 'connected'){
      await Engine.api.send({ ticks: newSymbol, subscribe: 1 });
      Logger.info(`Switched market to ${newSymbol}.`);
    }
  });

  // Periodic UI refresh for time-based panels (cooldown countdown, risk panel)
  setInterval(() => {
    UI.renderRiskPanel();
  }, 1000);

  window.addEventListener('beforeunload', () => {
    if (STATE.connection.ws){
      try { Engine.api.forgetAll('ticks'); Engine.api.forgetAll('proposal'); Engine.api.forgetAll('balance'); } catch(e){}
    }
  });
}

function bootstrap(){
  Logger.init();
  UI.init();
  Engine.init();
  wireEvents();
  UI.renderConnectionStatus();
  UI.renderAccountMode();
  UI.renderRiskPanel();
  UI.renderPerformance();
  Logger.info('OV2UN7 Nexus initialized. Enter App ID + PAT and click Connect to begin.');
  Logger.warn('Demo mode is active by default. Switching to Real requires explicit confirmation.');
}

document.addEventListener('DOMContentLoaded', bootstrap);
