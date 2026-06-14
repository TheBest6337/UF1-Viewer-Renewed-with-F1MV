const debug = false;

const { state, driverJustPitted } = require("./state");
const { getCompoundLife, getDriverConfig } = require("./config");

function calcPitWindow(driverNum, currentLap, stintData, degRate, health, battlePenalty, compoundAvgDeg, teammateDeg, totalLaps) {
    if (!stintData || stintData.length === 0) return null;

    const currentStint = stintData[stintData.length - 1];
    const compound = currentStint.Compound || "SOFT";
    const compoundLife = getCompoundLife(compound);
    const stintAge = currentStint.TotalLaps != null ? currentStint.TotalLaps : 0;
    const threatLapThreshold = getDriverConfig("threatLapThreshold", 3);
    const tireAgeRatio = stintAge / compoundLife;

    var justPitted = driverJustPitted(driverNum);
    const isRaceStart = !justPitted && stintAge <= 4 && stintData.length <= 1;
    if (!justPitted && stintAge <= 4) {
        justPitted = true;
    }

    if (justPitted) {
        if (state.driverHistory[driverNum]) {
            state.driverHistory[driverNum].laps = [];
            state.driverHistory[driverNum].segmentScores = [];
            state.driverHistory[driverNum].positions = [];
            state.driverHistory[driverNum].dirtyAirHistory = [];
            state.driverHistory[driverNum].degRate = null;
        }
        return {
            compound: compound,
            stintAge: stintAge,
            minLap: Math.round(currentLap + compoundLife - 3),
            maxLap: Math.round(currentLap + compoundLife + 3),
            urgency: 0,
            extended: false,
            lapsLeft: compoundLife,
            compoundLife: compoundLife,
            effectiveLife: compoundLife,
            justPitted: !isRaceStart,
            isRaceStart: isRaceStart,
            tireAgeRatio: tireAgeRatio,
        };
    }

    var adjustedDeg = degRate;

    if (stintAge >= 5) {
        if (adjustedDeg === null || adjustedDeg === undefined) {
            if (teammateDeg !== null && teammateDeg !== undefined) {
                adjustedDeg = teammateDeg;
            }
        }
    }

    if (adjustedDeg !== null && adjustedDeg !== undefined && compoundAvgDeg !== null && compoundAvgDeg !== undefined) {
        var compoundCount = state.compoundCounts[compound] || 0;

        if (compoundCount >= 3 && compoundAvgDeg > 0.005 && adjustedDeg > compoundAvgDeg * 2.0 && adjustedDeg > 0.05) {
            adjustedDeg = compoundAvgDeg * 1.5;
        }

        if (adjustedDeg < 0 && compoundAvgDeg > 0.03) {
            adjustedDeg = compoundAvgDeg;
        }
    }

    var effectiveLife = compoundLife;
    if (adjustedDeg !== null && adjustedDeg !== undefined) {
        if (adjustedDeg > 0.10) {
            var reduction = Math.min(0.55, (adjustedDeg - 0.10) * 4.0);
            effectiveLife = compoundLife * (1 - reduction);
        } else if (adjustedDeg > 0.05) {
            var reduction = (adjustedDeg - 0.05) * 2.0;
            effectiveLife = compoundLife * (1 - reduction);
        } else if (adjustedDeg <= 0) {
            effectiveLife = compoundLife * 1.2;
        }
    }

    var extDataSelf = state.compoundExtensionData[compound];
    if (extDataSelf && extDataSelf.count >= 2) {
        var selfAvgRatio = extDataSelf.sum / extDataSelf.count;
        if (selfAvgRatio > 1) {
            effectiveLife = Math.max(effectiveLife, compoundLife * selfAvgRatio);
        }
    }

    var fleetMax = state.fleetMaxCompoundAge[compound] || 0;
    if (fleetMax > effectiveLife) {
        effectiveLife = Math.max(effectiveLife, fleetMax + 3);
    }

    var compoundOrder = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];
    var myCompoundIdx = compoundOrder.indexOf(compound);
    if (myCompoundIdx >= 0) {
        var bestBoost = 0;
        var bestDistance = Infinity;
        for (var _ci = 0; _ci < compoundOrder.length; _ci++) {
            if (_ci === myCompoundIdx) continue;
            var otherComp = compoundOrder[_ci];
            var extData = state.compoundExtensionData[otherComp];
            if (extData && extData.count >= 2) {
                var avgExtRatio = extData.sum / extData.count;
                var steps = Math.abs(myCompoundIdx - _ci);
                var crossBoost = (avgExtRatio - 1) * Math.pow(0.5, steps);
                if (crossBoost > 0 && steps < bestDistance) {
                    bestBoost = crossBoost;
                    bestDistance = steps;
                }
            }
        }
        if (bestBoost > 0) {
            effectiveLife = Math.max(effectiveLife, compoundLife * (1 + bestBoost));
        }
    }

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
    if (health && health.score >= 3 && degRate !== null && degRate <= 0) {
        lapsLeft += 5;
        extended = true;
    }

    const safetyMargin = 3;
    const overstayMargin = 3;
    var urgency = 0;
    if (lapsLeft <= -overstayMargin) urgency = 2;
    else if (lapsLeft <= safetyMargin) urgency = 1;

    const minPitLap = Math.max(currentLap + 1, Math.round(currentLap + lapsLeft - safetyMargin));
    const maxPitLap = Math.max(currentLap + 1, Math.round(currentLap + Math.max(0, lapsLeft) + overstayMargin));

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
    };
}

module.exports = { calcPitWindow };
