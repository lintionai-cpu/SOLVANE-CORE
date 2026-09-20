# DIGIT EDGE — Statistical Digit Options Engine (MVP v1.0)

Single-file HTML5 PWA (`index.html`, no build step) for Deriv Options **DIFFERS** and **OVER 2** digit contracts. `sw.js` is optional (mobile notifications / install).

## 1. Architecture
Connection (dual sockets: public feed + OTP-authenticated trade socket, req_id routing, heartbeat, backoff, generation guards) → Digit extraction (`toFixed(pip decimals)`, never raw float) → Ring buffer (≤5000, incremental transition matrix, duplicate/out-of-order rejection) → Rolling windows 10–100 → Consensus / entropy / chi-square / transitions / sequences → DIFFERS + OVER 2 engines → Signal fusion (7 configurable, decomposable components) → Qualify → `canTrade()` gate → Warm proposal → Buy → `proposal_open_contract` monitor → Journal / performance. UI is rAF-batched with canvas charts.

## 2. Install
Open `index.html` in a modern browser, or host the two files over HTTPS (needed for install-to-home-screen and notifications on phones).

## 3–4. App ID and PAT
Register an app at developers.deriv.com (PAT type), create a PAT with `trade` scope (+`account_manage` to auto-create a demo account). Legacy App IDs and OAuth tokens will not work with a PAT app. The PAT is masked, kept in memory, never logged, and sent only to api.derivws.com. Optional "remember" stores it AES-GCM-encrypted with a non-extractable key in IndexedDB.

## 5–6. Demo / Real
Default is DEMO · MANUAL · AUTO OFF. Market analysis and proposals work with no login (public feed). REAL requires typing `REAL`; arming auto on a real account requires typing `CONFIRM`.

## 7. API flow
PAT → `GET /trading/v1/options/accounts` → `POST …/accounts/{id}/otp` → `wss://api.derivws.com/trading/v1/options/ws/{demo|real}?otp=…`. Fresh OTP on every reconnect. Requests use `underlying_symbol`; no `loginid`, no legacy `authorize`.

## 8. Trading workflow
Signal → risk → proposal (kept warm, so a buy is one round trip) → validation → manual confirm or auto → `buy` with the live proposal id → contract id → open-contract stream → settlement → statistics. Nothing is shown as executed until Deriv returns a contract id.

## 9. Statistical methodology
Per window: count, %, deviation from 10%, z-score, rank. Hot = top-3 with z ≥ 0.75, cold = bottom-3 with z ≤ −0.75. Consensus is an analytical score, not a probability. Shannon entropy and chi-square (df 9, exact p-value). DIFFERS has two selectable hypotheses (HOT target = reversion, COLD target = persistence) that the backtest compares. OVER 2 compares digits 3–9 to a 70% baseline. Baselines, empirical frequency and out-of-sample hit rate are kept separate.

## 10. Backtesting
Walk-forward: each signal uses only earlier ticks (tested for look-ahead). Train 0–50% / validation 50–70% / test 70–100%. Threshold optimisation uses validation only; judge the TEST columns. Edge verdict = Wilson 95% interval of OOS hit rate vs contract break-even: VALIDATED / NOT SIGNIFICANT / NO EDGE / INSUFFICIENT EVIDENCE.

## 11. Risk controls
`PB` bounds table + `enforce()` for every numeric setting; max stake, exposure, daily loss, consecutive losses, trades/session, open contracts, cooldown, session TP/SL, payout-ratio floor, stale-tick and connection checks, kill switch. Stake progression is off by default and always capped. Auto-cycle is two-phase and in place: Phase 1 blocks entries and waits for open contracts, Phase 2 resets session counters and re-arms after a delay, without touching sockets. Daily loss is a hard stop. After any reconnect, auto waits for a revalidation period.

## 12. Known limitations
- Deriv synthetic digits are designed to be memoryless; expect NO EDGE / NOT SIGNIFICANT. With "require validated edge" ON, auto will rarely or never fire. That is the intended behaviour.
- DIFFERS/OVER 2 payouts carry a house margin (break-even is above the theoretical win rate).
- Browsers throttle background tabs; keep the app in the foreground for auto (wake lock is requested).
- Not verified against live Deriv servers in this build: tested against a mock server plus unit tests. Try DEMO first; field names follow the supplied schemas.
- Browser CORS or content blockers may block REST calls to api.derivws.com.
- Not financial advice.
