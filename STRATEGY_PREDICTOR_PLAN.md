# Strategy Predictor — Implementation Plan

## Feature: Live Pit Strategy Predictor for F1 Races

### Overview

Real-time prediction of when each driver will likely pit, what compound they'll switch to, and detection of undercut/overcut threats. Primary display is a **configurable vertical table** sorted by pit urgency with pit window countdowns. Targets Race sessions only.

**Module path:** `src/strategypredictor/`

---

## 1. Data Sources

All data comes from `npm_f1mv_api.LiveTimingAPIGraphQL`. Polled every **2000ms** (strategy doesn't change per-frame).

| Topic | Fields Used | Purpose |
|---|---|---|
| `TimingAppData` | `Lines[driver].Stints[]` → `Compound`, `TotalLaps`, `StartLaps`, `LapTime`, `New` | Tire compound, stint age, stint history |
| `TimingData` | `Lines[driver].Position`, `NumberOfLaps`, `InPit`, `Retired`, `Stopped`, `GapToLeader`, `IntervalToPositionAhead.Value`, `IntervalToPositionAhead.Catching`, `LastLapTime.Value`, `LastLapTime.OverallFastest`, `LastLapTime.PersonalFastest`, `Sectors[].Segments[].Status` | Position, gaps, lap times, sector statuses |
| `TimingStats` | `Lines[driver].PersonalBestLapTime` | Best lap time per driver |
| `DriverList` | `Lines[driver].RacingNumber`, `FirstName`, `LastName`, `Tla`, `TeamName`, `TeamColour` | Driver identity, team grouping, colors |
| `LapCount` | `CurrentLap`, `TotalLaps` | Session progress |
| `SessionInfo` | `Type`, `Name` | Session type check (only active for Race) |
| `TrackStatus` | `Status` (1=Clear, 2=Yellow, 4=SC, 5=Red, 6=VSC, 7=VSC Ending) | SC/VSC override trigger |
| `ExtrapolatedClock` | `Remaining`, `Extrapolating` | Time remaining in session |
| `WeatherData` | `Rainfall` | Rain transition detection |
| `PitLaneTimeCollection` | `PitTimes[driver].Duration` | Pit stop durations → average pit loss |
| `LiveTimingClock` | `paused`, `systemTime`, `trackTime` | Clock sync |

---

## 2. Calculations — Override Hierarchy

Degradation is calculated with a **priority chain**. Real track data always beats hardcoded baselines.

### Priority Chain (top wins)

```
1. SECTOR HEALTH   — If score ≥ +3, tires are still performing → IGNORE baseline, EXTEND
2. RAW DEG RATE    — If degRate ≤ 0 or ≤ 0.02s/lap, tires are stable → EXTEND
3. NON-LINEAR PAT  — Info-only indicator; does NOT adjust window (user decision)
4. COMPOUND BASELINE — FALLBACK: used when no real data OR when data matches it
5. BATTLE PENALTY  — Reduces whatever window was calculated above
```

Scenarios:

| Sector Health | Deg Rate | Pattern | Prediction |
|---|---|---|---|
| ≥ +3 (purple) | ≤ 0 | WARMING | EXTENDED past baseline |
| ≥ +3 | +0.02 | CONSISTENT | EXTENDED — baseline irrelevant |
| -1..+2 | +0.04 | CONSISTENT | Use baseline |
| ≤ -3 | +0.15 | PUSHING | PIT NOW regardless of baseline |

---

## 3. Calculated Metrics

### A. Sector Health Score

Per-driver, per-poll: read all segment statuses from last 5 laps.

```
Scoring per segment:
  Purple (2051)  = +3
  Green  (2049)  = +2
  Yellow (2048)  = -1
  No color (0)   = -3
  Blue   (2064)  = 0  (out lap, ignore)
  Red    (2052/2068) = -2

healthScore = sum(all segment scores across last 5 laps) / lapsWithData
```

Interpretation:

| Score | State | Window effect |
|---|---|---|
| > +8 | FRESH (improving) | Override baseline, extend |
| +3 to +8 | OPTIMAL (at peak) | Standard deg rate |
| -3 to +3 | DEGRADING (falling off) | Baseline applies |
| < -3 | GONE | PIT NOW |

### B. Degradation Rate (Raw)

Per-driver, last 5 clean laps (exclude: lap 1, out laps, SC/VSC laps, laps with missing data):

```
lapTimes = [time1, time2, ... timeN]
degRate = slope of linear regression on (lapNumber, lapTime)
// Positive = getting slower (degrading), Negative = getting faster (warming/improving)
```

### C. Non-Linear Pattern Classification (Info-Only)

```
first3avg = mean(first 3 clean lap times of current stint)
last3avg  = mean(last 3 clean lap times of current stint)

If last3avg < first3avg by >0.3s → "WARMING"   ↑ (getting faster)
If last3avg > first3avg by >0.3s → "PUSHING"   ↓ (pushing, burning tires)
Else                              → "CONSISTENT" → (standard deg)
```

Display icon only. Does NOT adjust pit window.

### D. Pit Window Prediction

```
stintAge = currentLap - stintStartLap
compoundLife = config value (S=16, M=30, H=42, I=20, W=15)

// 1. Calculate effective life based on deg rate:
if degRate > 0.02:
  effectiveLife = min(compoundLife, compoundLife * (0.04 / degRate))
else if degRate <= 0:
  effectiveLife = compoundLife * 1.3  // extend 30%: tires still good
else:
  effectiveLife = compoundLife

// 2. Apply battle penalty to remaining laps:
remainingCleanLaps = effectiveLife - stintAge
remainingCleanLaps -= battlePenalty * remainingCleanLaps  // from section 3.F

// 3. Calculate window:
lapsLeft = max(0, remainingCleanLaps)

if lapsLeft <= 0:          urgency = 2 (PIT NOW / OVERDUE)
elif lapsLeft <= threatLapThreshold: urgency = 1 (IMMINENT)
else:                      urgency = 0 (OK)

minPitLap = max(currentLap + 1, currentLap + lapsLeft - safetyMargin)  // safetyMargin=3
maxPitLap = currentLap + lapsLeft + overstayMargin                      // overstayMargin=3

// 4. Override: if sectorHealth ≥ +3 AND degRate ≤ 0:
// → Set maxPitLap += 5, add "EXTENDED" label, ignore baseline ceiling
```

### E. Undercut/Overcut Detection

For each pair of consecutive drivers (pos N and N+1) with gap < 3.0s:

```
gapBetween = parseFloat(IntervalToPositionAhead.Value for driverBehind)
if gapBetween > 3.0: skip

behindWindow = predictedWindows[driverBehind]
aheadWindow = predictedWindows[driverAhead]

// Undercut: driver behind pits FIRST
if behindWindow.minPitLap < aheadWindow.minPitLap:
  lapsUndercut = aheadWindow.minPitLap - behindWindow.minPitLap
  freshPaceAdvantage = 0.5  // s/lap (estimated)
  netGain = freshPaceAdvantage * lapsUndercut - avgPitLoss
  if netGain > gapBetween:
    → UNDERCUT POSSIBLE (+{netGain}s net gain)

// Overcut: driver ahead pits FIRST and driver behind stays out
if aheadWindow.minPitLap < behindWindow.minPitLap:
  lapsOvercut = behindWindow.minPitLap - aheadWindow.minPitLap
  oldTirePaceLoss = behindDegRate * lapsOvercut
  if gapBetween < oldTirePaceLoss:
    → OVERCUT RISK (behind loses {oldTirePaceLoss}s staying out)
```

### F. Battle Degradation Penalty

Detect 3 conditions from `TimingData`:

| Condition | Detection | Penalty |
|---|---|---|
| **Fighting** | Position changed ≥ 3 times in last 5 laps | +0.05s/lap deg |
| **Dirty Air** | `IntervalToPositionAhead.Value < 1.0` for ≥ 3 of last 5 laps | +0.03s/lap deg |
| **Pushing** | Gained ≥ 2 positions in last 5 laps (opponents on same lap, not lapped) | +0.08s/lap deg |

```
// Penalty stacking — take highest + half of second highest:
penalties = [fighting, dirtyAir, pushing].filter(active)
battlePenalty = max(penalties) + (penalties.length > 1 ? secondHighest(penalties) * 0.5 : 0)
```

Lapped car filter: skip overtaken drivers whose `GapToLeader` contains `"L"`.

### G. SC/VSC Override (Track Status 4, 6, 7)

When SC (4) or VSC (6) deploys:

```
scPitLoss = avgPitLoss * 0.55  // ~55% of normal (~12s vs ~22s)

For each driver, calculate tireUsage = stintAge / compoundLife:
  > 0.85 → 🔴 EXPECTED TO PIT (oldest tires)
  > 0.60 → 🟡 LIKELY TO PIT
  else   → COULD PIT (strategic)

Sort table by tire age descending (oldest first)
Replace normal display with SC banner + expected-pit list
Show time saved: "Pit loss ~{scPitLoss}s (save ~{normal - sc}s)"
```

Track Status 7 (VSC Ending): show "WINDOW CLOSING" warning.

Return to normal table when Track Status becomes 1 (Clear).

### H. Team Deg Sharing

```
Group drivers by TeamName.
For each team with 2 drivers where both have data:
  teamAvgDeg = (driver1.degRate + driver2.degRate) / 2

  If |driver1.degRate - driver2.degRate| > 0.05:
    Flag outlier: "⚠ different deg from teammate"

For drivers with insufficient solo data:
  Use teammate's degRate as initial estimate
  Label: "(teammate estimate)"
```

### I. Compound Reference Deg

Per-poll, calculate per-compound average deg across all drivers:

```
compoundDegAvg[compound] = mean(degRate of all drivers on that compound with ≥5 laps data)
```

Display deviation per driver: `deg +0.18 (+0.06 vs avg S)` — shows who's harder/softer on tires than the field.

---

## 4. Display Layout

### Normal Race (Track Status 1/2)

```
┌──────────────────────────────────────────────────────────────────────┐
│ STRATEGY PREDICTOR                                     Lap 24/57     │
├──────────────────────────────────────────────────────────────────────┤
│  #  DRIVER      COMP ▲  PAT   PIT WINDOW    STATUS                   │
│ ─────────────────────────────────────────────────────────────────── │
│  P4  PIA  [S]   ●●24●    ↓     Lap 24-26     🔴 PIT NOW              │
│      Sectors ▓▓▒▒░░  Health -4  |  deg +0.22 (+0.10 vs avg S)       │
│      ↳ 1.2s behind LEC — Undercut possible (+0.8s net)              │
│                                                                       │
│  P1  VER  [S]   ●●●20    →     Lap 26-30     ⚠ Imminent (2 laps)     │
│      Sectors ▓▓▓▓▓▒  Health +1  |  deg +0.11 (-0.01 vs avg S)       │
│      Team: PER [S] deg +0.10 → similar ✓                             │
│                                                                       │
│  P6  HAM  [S]   ●●22●    ↓⚔    Lap 25-28     ⚠ Imminent (1 lap)      │
│      Sectors ▓▓▒▒░░  Health -3  |  deg +0.22 (+0.04 battle)         │
│      ↳ 3 swaps with RUS in 5 laps — fighting adds +0.04/lap         │
│      Team: RUS [S] deg +0.12 → HAM degrading faster ⚠               │
│                                                                       │
│  P3  NOR  [H]   ●●●40    ↑     Lap 48-54     EXTENDED                │
│      Sectors ▓▓▓▓▓▓  Health +5  |  deg -0.01 (getting faster)       │
│      ⓘ Baseline says 42 laps — real pace overriding                  │
│                                                                       │
│  P2  LEC  [M]   ●███28   ↑     Lap 32-38     OK (8 laps)             │
│      Sectors ▓▓▓▓▓▓  Health +6  |  deg +0.05 (-0.03 vs avg M)       │
│                                                                       │
│  ...                                                                  │
│ ─────────────────────────────────────────────────────────────────── │
│  📊 Pit Loss: 22.3s (SC: ~12s)  │  ⏱ Race End: ~Lap 62              │
│  Deg: [S]=+0.12 (6) [M]=+0.08 (8) [H]=+0.03 (3)                     │
│  SC/VSC: NONE  │  🌧: DRY                                            │
└──────────────────────────────────────────────────────────────────────┘
```

Pattern icons: ↑ (warming), ↓ (pushing), → (consistent)
Battle modifiers: ↓⚔ (degrading+fighting), ↓⇈ (degrading+pushing), →═ (consistent+dirty air)

**Drivers sorted by:** urgency (red first), then minPitLap ascending.

**Configurable:** show "All" (20, scrollable), "Top10", or "Top5" via settings dropdown.

### Safety Car / VSC (Track Status 4/6)

Replaces normal table entirely:

```
┌──────────────────────────────────────────────────────────────────────┐
│ STRATEGY PREDICTOR                                     Lap 32/57     │
├──────────────────────────────────────────────────────────────────────┤
│  ⚠ SAFETY CAR DEPLOYED — Pit loss ~12s (save ~10s vs normal)        │
│  ────────────────────────────────────────────────────────────────── │
│  DRIVERS EXPECTED TO PIT (sorted by tire age):                       │
│                                                                       │
│  P3  NOR  [H]   ●●●38●  Age 38/42  → 🔴 EXPECTED TO PIT             │
│  P8  ALO  [M]   ●███32  Age 32/30  → 🔴 EXPECTED (overdue!)          │
│  P9  TSU  [M]   ●███28  Age 28/30  → 🟡 LIKELY TO PIT               │
│  P1  VER  [S]   ●●●16   Age 16/16  → 🟡 LIKELY TO PIT               │
│  P2  LEC  [M]   ●████24 Age 24/30  → COULD PIT (fresh mediums)      │
│  P4  PIA  [S]   ●●4●    Age 4/16   → FRESH (just pitted)            │
│  ...                                                                  │
│ ─────────────────────────────────────────────────────────────────── │
│  Post-SC: fresh tire advantage ~1.5-2s/lap over cars staying out     │
└──────────────────────────────────────────────────────────────────────┘
```

Track Status 7 (VSC Ending):

```
│  ⚠ VSC ENDING — Pit window closing (~10s remaining)                  │
```

### Rain Transition Banner

When `WeatherData.Rainfall` changes:

```
│  🌧 RAIN STARTING — Intermediates expected. Pit window shifting.      │
│  ☀ DRY LINE EMERGING — Slicks becoming viable. Monitor sector times. │
```

---

## 5. State Buffer (Module-Level Variables)

Persist between polling cycles (standard UF1 pattern):

```javascript
let driverHistory = {};
// "1": {
//   laps: [{lap: 10, time: 83.456, compound: "SOFT", sectors: [...], clean: true}, ...],
//   positions: [{lap: 10, position: 4}, ...],
//   stints: [...raw stint data...]
// }

let predictedWindows = {};
// "1": { minLap: 26, maxLap: 30, compound: "SOFT", urgency: 1, extended: false, battlePenalty: 0 }

let undercutThreats = [];
// [{ driverBehind: "81", driverAhead: "16", gap: 1.2, possible: true, netGain: 0.8 }]

let avgPitLoss = 22.5;
let degRates = { S: 0, M: 0, H: 0, I: 0, W: 0 };    // per-compound averages
let compoundCounts = { S: 0, M: 0, H: 0, I: 0, W: 0 };

let lastTrackStatus = "1";
let lastRainfall = 0;
let sessionType = null;
```

---

## 6. Cold Start & Data Accumulation

**First 5 laps of race:** insufficient data for real predictions.

```
Display: "GATHERING DATA... (need {5 - lapsWithData} more laps)"

During this phase:
  - Show driver list with positions and compounds only
  - Use compoundLife baseline for an initial "expected range" (labeled "BASELINE")
  - Deg rates, sector health, battle penalties = all pending

Transition at lap 5+: fade predictions in row by row as data becomes available per driver
```

---

## 7. Config

### `src/index.js` — config defaults:

```javascript
strategypredictor: {
    showDrivers: "All",           // "All" | "Top10" | "Top5"
    showUndercut: true,           // show undercut/overcut threat rows
    showDegRates: true,           // show per-driver deg rate vs compound avg
    showSectorHealth: true,       // show sector health bar
    showTeamDeg: true,            // show teammate deg comparison
    minLapsForPrediction: 5,      // laps before showing real predictions
    threatLapThreshold: 3,        // laps before window start → "IMMINENT"
    softMaxLaps: 16,
    mediumMaxLaps: 30,
    hardMaxLaps: 42,
    intermediateMaxLaps: 20,
    wetMaxLaps: 15,
    battleDegEnabled: true,       // toggle battle penalty
    swapThreshold: 3,             // position swaps in 5 laps = "fighting"
    dirtyAirThreshold: 3,         // laps <1s behind = "dirty air"
    pushThreshold: 2,             // overtakes in 5 laps = "pushing"
    enabled: true,
}
```

### `internal_settings.windows` — window definition:

```javascript
strategypredictor: {
    path: "strategypredictor/index.html",
    width: 500,
    height: 550,
    frame: false,
    hideMenuBar: true,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: null,
    icon: "icons/windows/strategypredictor.png",
}
```

---

## 8. Files to Create/Modify

### New files (3):

| File | Purpose | ~Lines |
|---|---|---|
| `src/strategypredictor/index.html` | Skeleton HTML, CSS links, scripts | 30 |
| `src/strategypredictor/index.js` | All logic: data fetch → calc → render | 450 |
| `src/strategypredictor/style.css` | Table styling, colors, sector bars | 120 |

### Modified files (3):

| File | Change | ~Lines |
|---|---|---|
| `src/index.js` | Add config defaults + window definition | 30 |
| `src/main/index.html` | Add launcher button in windows section | 3 |
| `src/main/index.js` | Add `strategypredictor()` launcher function | 6 |

### Placeholder icon:

| File | Note |
|---|---|
| `src/icons/windows/strategypredictor.png` | Copy existing icon temporarily |

---

## 9. Implementation Order

| Step | What | Verification |
|---|---|---|
| 1 | Create `index.html` + `style.css` | Window opens and shows static layout |
| 2 | `index.js` — `getConfigurations()` + `apiRequests()` | Data flowing, `debug` logs show API responses |
| 3 | State buffer — accumulate `driverHistory` per lap | Log history at each poll |
| 4 | Sector health score calculator | Log health scores per driver |
| 5 | Degradation rate calculator | Log deg rates per driver |
| 6 | Non-linear pattern classifier | Log pattern per driver |
| 7 | Pit window predictor | Log windows per driver |
| 8 | Render — vertical table rows | Table renders with all drivers |
| 9 | Undercut/overcut detector + render | Threat rows appear/disappear |
| 10 | SC/VSC mode + battle penalty | SC mode replaces table correctly |
| 11 | Team deg sharing + compound ref | Sub-lines and bottom bar show |
| 12 | Main process registration + launcher | Launch from main hub |
| 13 | Final polish | Set `debug = false`, test with live session |

---

## 10. Edge Cases

| Case | Behavior |
|---|---|
| Session is not Race | Show "Only available during Race sessions" |
| First 5 laps | Show "GATHERING DATA..." with baseline estimates |
| Driver retires | Remove from table, don't predict |
| Driver already pitted this lap | Show "JUST PITTED", reset deg buffer, hide window for 2 laps |
| No stint data | Show "NO DATA" row |
| All gaps > 3s | No undercut/overcut rows shown |
| Multiple SC periods | Reset deg buffers each time SC ends |
| SC then VSC back-to-back | Keep SC mode active through transition |
| Rain switch then switch back | Track intermediate → slick transition |
| Driver changes positions with lapped cars | Filter out lapped cars from push/fight detection |
| Very long race (>70 laps) | Projected max laps from `ExtrapolatedClock.Remaining / fastestLap` |
| Window height too small | Scrollable container, drivers sorted by urgency |
| Deg rate = 0 or negative | Override baseline, EXTEND window |

---

## 11. Dependencies

No new npm packages needed. Uses:
- `npm_f1mv_api` (already installed)
- `require("electron")` → `ipcRenderer` (standard)
- `require("../functions/colors.js")` → `getColorFromStatusCodeOrName` for segment colors
- `require("../functions/times.js")` → `parseLapOrSectorTime`, `formatMsToF1` for time parsing

---

## 12. Coding Conventions (from AGENTS.md)

- `const debug = false` at top of `index.js`
- `const { ipcRenderer } = require("electron")` — never `window.electron`
- Config via `config.config.strategypredictor.*` (double nesting)
- `setInterval(fn, loopspeed)` at 2000ms
- Module-level variables persist between polls
- `run()` at bottom of script
- Pure JS, CommonJS `require`, no `import`/`export`
- Scripts loaded via `<script defer>` in HTML
- Include `movemode.js` + `window_info.css` for drag/transparency support
