const debug = false;

const { state, driverJustPitted } = require("./state");
const { getCompoundLife, getDriverConfig } = require("./config");
const { getPriorDeg } = require("./priors");

function calcPitWindow(driverNum, currentLap, stintData, degRate, health, battlePenalty, compoundAvgDeg, teammateDeg, totalLaps) {
    if (!stintData || stintData.length === 0) return null;

    const currentStint = stintData[stintData.length - 1];
    const compound = currentStint.Compound || "SOFT";
    const compoundLife = getCompoundLife(compound);
    // TotalLaps is total wear on the tyre set; StartLaps is the wear it already had
    // when fitted. Track stint age (laps run in THIS stint) is the difference — using
    // TotalLaps for both conflates the two and mis-anchors used-tyre stints.
    const stintAge = currentStint.TotalLaps != null ? currentStint.TotalLaps : 0;
    const startLaps = currentStint.StartLaps != null ? currentStint.StartLaps : 0;
    const trackStintAge = Math.max(0, stintAge - startLaps);
    const stintStartLap = currentLap - trackStintAge;
    const threatLapThreshold = getDriverConfig("threatLapThreshold", 3);
    const tireAgeRatio = stintAge / compoundLife;

    const justPitted = driverJustPitted(driverNum);
    const isRaceStart = !justPitted && stintAge <= 4 && stintData.length <= 1;

    // Base life from live evidence: median wear age at which cars actually pitted this
    // compound today, blended against the configured life with 4 pseudo-observations.
    // This replaces the oldest-survivor ratchet, which grew +1 every lap by construction.
    var baseLife = compoundLife;
    var pitAges = state.observedPitAges[compound] || [];
    if (pitAges.length >= 3) {
        var sortedAges = pitAges.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(sortedAges.length / 2);
        var liveMedian = sortedAges.length % 2 ? sortedAges[mid] : (sortedAges[mid - 1] + sortedAges[mid]) / 2;
        var wLive = Math.min(12, pitAges.length);
        baseLife = (4 * compoundLife + wLive * liveMedian) / (4 + wLive);
    }

    if (justPitted) {
        // Anchor to the stint start, never to currentLap: currentLap-based bounds slide
        // +1 every lap and are what made the window read "next lap" forever. Uses the
        // same evidence-based baseLife as the normal path so the window doesn't lurch
        // when the post-pit cooldown expires. History buffers are reset once by the
        // pit-stop event handler in compute.js, not here.
        const expectedLife = Math.max(5, baseLife - startLaps);
        return {
            compound: compound,
            stintAge: stintAge,
            minLap: Math.round(stintStartLap + expectedLife - 3),
            maxLap: Math.round(stintStartLap + expectedLife + 3),
            urgency: 0,
            extended: false,
            lapsLeft: Math.max(0, Math.round(baseLife) - stintAge),
            compoundLife: compoundLife,
            effectiveLife: baseLife,
            justPitted: true,
            isRaceStart: false,
            tireAgeRatio: tireAgeRatio,
            confidence: 0.2,
        };
    }

    var hist = state.driverHistory[driverNum] || {};
    var degConfidence = hist.degConfidence || 0;

    // Fallback deg when own measurement is missing or young: the fleet's compound
    // average faded in by how mature the fleet's own fits are, over this circuit's
    // historical deg slope; teammate as the last live resort.
    var priorDeg = null;
    var histDeg = getPriorDeg(compound);
    if (compoundAvgDeg !== null && compoundAvgDeg !== undefined && (state.compoundCounts[compound] || 0) >= 2) {
        var fleetConf = (state.compoundConfAvg && state.compoundConfAvg[compound]) || 0;
        priorDeg = histDeg !== null ? fleetConf * compoundAvgDeg + (1 - fleetConf) * histDeg : compoundAvgDeg;
    } else if (histDeg !== null) {
        priorDeg = histDeg;
    } else if (teammateDeg !== null && teammateDeg !== undefined) {
        priorDeg = teammateDeg;
    }

    // Confidence-weighted blend instead of the old hard fallbacks and outlier clamps:
    // a young own-measurement leans on the prior, a mature one stands alone.
    var adjustedDeg;
    if (degRate !== null && degRate !== undefined && priorDeg !== null) {
        adjustedDeg = degConfidence * degRate + (1 - degConfidence) * priorDeg;
    } else if (degRate !== null && degRate !== undefined) {
        adjustedDeg = degRate;
    } else {
        adjustedDeg = priorDeg;
    }

    // A single car reading far above the field on the same compound is traffic/damage/
    // fuel noise more often than a real cliff — cap it near the fleet's rate.
    if (adjustedDeg !== null && compoundAvgDeg !== null && compoundAvgDeg !== undefined &&
        (state.compoundCounts[compound] || 0) >= 4 && adjustedDeg > 0.08 && adjustedDeg > compoundAvgDeg * 2.0) {
        adjustedDeg = Math.max(0.08, compoundAvgDeg * 1.5);
    }

    // Continuous life curve replacing the old hard buckets (>0.10 / >0.05 / <=0):
    // deg <= 0.03 s/lap extends life 15%, then a linear penalty down to a 0.45x floor
    // at 0.13 s/lap. Continuity means a small deg change moves the window a little,
    // not across a bucket boundary.
    var effectiveLife = baseLife;
    if (adjustedDeg !== null && adjustedDeg !== undefined) {
        var lifeFactor = Math.min(1.15, Math.max(0.45, 1.15 - 5.0 * Math.max(0, adjustedDeg - 0.03)));
        effectiveLife = baseLife * lifeFactor;
    }

    // Survivor floor: if ANOTHER car is right now running this compound older than the
    // estimate with low deg, the estimate is provably short. Bounded, and never fed by
    // the driver's own long run (that would recede their window indefinitely).
    var longRuns = state.fleetCurrentLongRun[compound] || [];
    var floorAge = 0;
    for (var _lr = 0; _lr < longRuns.length; _lr++) {
        if (longRuns[_lr].driver !== driverNum && longRuns[_lr].age > floorAge) floorAge = longRuns[_lr].age;
    }
    if (floorAge > effectiveLife) {
        effectiveLife = Math.max(effectiveLife, Math.min(floorAge + 2, baseLife * 1.3));
    }

    // Smooth the life estimate itself, once per lap, reset each stint: the inputs
    // above (EMA deg, compound averages, survivor floor) can each step several laps
    // at once, and the window should not whipsaw with them.
    if (hist.effLifeEma != null && hist.effLifeEmaCompound === compound && hist.effLifeEmaStint === stintStartLap) {
        if (currentLap > hist.effLifeEmaLap) {
            hist.effLifeEma = 0.5 * effectiveLife + 0.5 * hist.effLifeEma;
            hist.effLifeEmaLap = currentLap;
        }
        effectiveLife = hist.effLifeEma;
    } else {
        hist.effLifeEma = effectiveLife;
        hist.effLifeEmaLap = currentLap;
        hist.effLifeEmaCompound = compound;
        hist.effLifeEmaStint = stintStartLap;
    }

    var confidence = Math.min(1, 0.6 * degConfidence + 0.4 * Math.min(1, pitAges.length / 6));

    var remainingCleanLaps = effectiveLife - stintAge;
    var lapsLeft = remainingCleanLaps;

    if (battlePenalty > 0 && lapsLeft > 0 && getDriverConfig("battleDegEnabled", true)) {
        lapsLeft -= battlePenalty * lapsLeft;
    }

    const effectiveAgeRatio = stintAge / effectiveLife;
    if (effectiveAgeRatio > 0.90) {
        if (lapsLeft > threatLapThreshold) {
            lapsLeft = threatLapThreshold;
        }
    }

    if (tireAgeRatio < 0.30 && lapsLeft > threatLapThreshold && (adjustedDeg === null || adjustedDeg <= 0.03)) {
        lapsLeft = Math.max(lapsLeft, threatLapThreshold + 1);
    }

    var extended = false;
    if (health && health.score >= 1.0 && degRate !== null && degRate <= 0) {
        lapsLeft += 5;
        extended = true;
    }

    const safetyMargin = 3;
    const overstayMargin = 3;
    var urgency = 0;
    if (lapsLeft <= -overstayMargin) urgency = 2;
    else if (lapsLeft <= safetyMargin) urgency = 1;

    // No floor at currentLap+1: a window whose min is in the past means "open/overdue",
    // which render.js shows directly. Flooring it made overstayed drivers read
    // "Imminent (1 lap)" indefinitely.
    const minPitLap = Math.round(currentLap + lapsLeft - safetyMargin);
    const maxPitLap = Math.max(minPitLap, Math.round(currentLap + Math.max(0, lapsLeft) + overstayMargin));

    if (totalLaps > 0 && minPitLap > totalLaps - 5) {
        return {
            compound: compound,
            stintAge: stintAge,
            minLap: minPitLap,
            maxLap: maxPitLap,
            urgency: 0,
            extended: false,
            lapsLeft: Math.max(0, lapsLeft),
            compoundLife: compoundLife,
            effectiveLife: effectiveLife,
            tireAgeRatio: tireAgeRatio,
            adjustedDeg: adjustedDeg,
            originalDeg: degRate,
            isRaceStart: isRaceStart,
            confidence: confidence,
            noPitNeeded: true,
        };
    }

    return {
        compound: compound,
        stintAge: stintAge,
        minLap: minPitLap,
        maxLap: maxPitLap,
        urgency: urgency,
        extended: extended,
        lapsLeft: Math.max(0, lapsLeft),
        compoundLife: compoundLife,
        effectiveLife: effectiveLife,
        tireAgeRatio: tireAgeRatio,
        adjustedDeg: adjustedDeg,
        originalDeg: degRate,
        isRaceStart: isRaceStart,
        confidence: confidence,
    };
}

module.exports = { calcPitWindow };
