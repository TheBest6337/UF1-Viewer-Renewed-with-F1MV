const debug = false;

const { state } = require("./state");
const { getCompoundLife } = require("./config");
const { calcSectorHealth, calcDegRate } = require("./degradation");
const { detectBattles } = require("./battles");
const { calcPitWindow } = require("./windows");
const { detectUndercutOvercut } = require("./threats");

function accumulateData(driverNum, timingData, timingAppLines, currentLap) {
    if (!state.driverHistory[driverNum]) state.driverHistory[driverNum] = {};
    state.driverHistory[driverNum].lastPollLap = currentLap;
}

function getAllStints(timingAppLines, driverNum) {
    if (!timingAppLines || !timingAppLines[driverNum]) return null;
    return timingAppLines[driverNum].Stints || null;
}

function detectPitStops(pitTimes, timingAppLines, currentLap) {
    if (!pitTimes || !timingAppLines) return;

    for (var driverNum in pitTimes) {
        var driverPitInfo = pitTimes[driverNum];
        var pitstopString = JSON.stringify(driverPitInfo);

        if (state.oldPitstops.indexOf(pitstopString) !== -1) continue;

        var stints = getAllStints(timingAppLines, driverNum);
        if (!stints || stints.length < 2) continue;

        var lastStint = stints[stints.length - 1];

        if (lastStint.StartLaps === lastStint.TotalLaps) {
            state.oldPitstops.push(pitstopString);
            state.justPittedDrivers[driverNum] = currentLap;
        }
    }

    for (var driverNum in state.justPittedDrivers) {
        if (currentLap - state.justPittedDrivers[driverNum] > 4) {
            delete state.justPittedDrivers[driverNum];
        }
    }
}

function computeGapBetween(behindNum, aheadNum, timingDataLines, positionOrder) {
    const behindTiming = timingDataLines[behindNum];
    const aheadTiming = timingDataLines[aheadNum];
    if (!behindTiming || !aheadTiming) return null;

    const behindPos = parseInt(behindTiming.Position);
    const aheadPos = parseInt(aheadTiming.Position);
    if (isNaN(behindPos) || isNaN(aheadPos) || behindPos <= aheadPos) return null;
    if (behindPos - aheadPos > 8) return null;

    const posToDriver = {};
    for (const entry of positionOrder) posToDriver[entry.pos] = entry.num;

    var totalGap = 0;
    for (var p = aheadPos + 1; p <= behindPos; p++) {
        const dn = posToDriver[p];
        if (!dn) return null;
        const t = timingDataLines[dn];
        if (!t || !t.IntervalToPositionAhead || !t.IntervalToPositionAhead.Value) return null;
        const interval = parseFloat(t.IntervalToPositionAhead.Value);
        if (isNaN(interval)) return null;
        totalGap += interval;
    }
    return totalGap;
}

function computeAll(driverListLines, timingDataLines, timingAppLines, timingStatsLines, currentLap, totalLaps, extrapolatedClock, trackStatus) {
    if (!driverListLines || !timingDataLines) return;

    state.currentPositionOrder = [];
    const posMap = {};
    for (const driverNum in timingDataLines) {
        const driverTiming = timingDataLines[driverNum];
        if (!driverTiming) continue;
        const pos = parseInt(driverTiming.Position);
        if (!isNaN(pos) && !driverTiming.Retired) {
            posMap[pos] = driverNum;
            state.currentPositionOrder.push({ num: driverNum, pos: pos });
        }
    }
    state.currentPositionOrder.sort(function (a, b) { return a.pos - b.pos; });

    // Pit entry detection: capture target driver + gap at the moment each driver enters the pit lane
    for (var _dn in timingDataLines) {
        var _dt = timingDataLines[_dn];
        if (!_dt) continue;
        const nowInPit = _dt.InPit === true;
        const wasInPit = state.prevInPit[_dn] || false;

        if (nowInPit && !wasInPit) {
            const myPos = parseInt(_dt.Position);
            if (!isNaN(myPos)) {
                var aheadEntry = null;
                for (const entry of state.currentPositionOrder) {
                    if (entry.pos === myPos - 1) { aheadEntry = entry; break; }
                }
                if (aheadEntry) {
                    const interval = _dt.IntervalToPositionAhead && _dt.IntervalToPositionAhead.Value
                        ? parseFloat(_dt.IntervalToPositionAhead.Value) : null;
                    if (interval !== null && !isNaN(interval) && interval <= 4.0) {
                        state.pitEntryTargets[_dn] = { target: aheadEntry.num, gapAtEntry: interval, lap: currentLap };
                    }
                }
            }
        }
        state.prevInPit[_dn] = nowInPit;

        if (state.pitEntryTargets[_dn] && currentLap - state.pitEntryTargets[_dn].lap > 6) {
            delete state.pitEntryTargets[_dn];
        }
    }

    var newDegRates = {};
    var newCounts = {};
    var newPredictedWindows = {};
    var allDegRates = {};

    var teammateMap = {};
    var teamDrivers = {};
    for (var dn in driverListLines) {
        var dInfo = driverListLines[dn];
        var tName = dInfo.TeamName;
        if (!teamDrivers[tName]) teamDrivers[tName] = [];
        teamDrivers[tName].push(dn);
    }
    for (var tName in teamDrivers) {
        var drivers = teamDrivers[tName];
        if (drivers.length === 2) {
            teammateMap[drivers[0]] = drivers[1];
            teammateMap[drivers[1]] = drivers[0];
        }
    }

    for (var driverNum in driverListLines) {
        var driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        var stints = getAllStints(timingAppLines, driverNum);
        accumulateData(driverNum, driverTiming, timingAppLines, currentLap);
        var health = calcSectorHealth(driverNum, timingDataLines, currentLap);
        var sessionData = { TimingData: { Lines: timingDataLines } };
        var degRate = calcDegRate(driverNum, currentLap, sessionData);

        if (state.driverHistory[driverNum]) {
            state.driverHistory[driverNum].degRate = degRate;
        }

        allDegRates[driverNum] = { deg: degRate, compound: "" };

        var compound = "---";
        if (stints && stints.length > 0) {
            compound = stints[stints.length - 1].Compound || "---";
        }
        if (degRate !== null && degRate !== undefined && compound !== "---") {
            if (!newDegRates[compound]) newDegRates[compound] = 0;
            if (!newCounts[compound]) newCounts[compound] = 0;
            newDegRates[compound] += degRate;
            newCounts[compound]++;
        }
    }

    state.degRates = newDegRates;
    state.compoundCounts = newCounts;

    var compoundAvgDegMap = {};
    for (var comp in newCounts) {
        if (newCounts[comp] > 0) {
            compoundAvgDegMap[comp] = newDegRates[comp] / newCounts[comp];
        }
    }

    state.compoundExtensionData = {};
    state.fleetMaxCompoundAge = {};
    for (var _dn in allDegRates) {
        var _stints = getAllStints(timingAppLines, _dn);
        if (!_stints || _stints.length === 0) continue;
        var _stint = _stints[_stints.length - 1];
        var _comp = _stint.Compound || "---";
        if (_comp === "---") continue;
        var _age = _stint.TotalLaps != null ? _stint.TotalLaps : 0;
        var _nomLife = getCompoundLife(_comp);
        var _deg = allDegRates[_dn] ? allDegRates[_dn].deg : null;

        if (_age > 5 && (_deg === null || _deg <= 0.10)) {
            if (!state.fleetMaxCompoundAge[_comp] || _age > state.fleetMaxCompoundAge[_comp]) {
                state.fleetMaxCompoundAge[_comp] = _age;
            }
        }

        if (_age >= _nomLife && (_deg === null || _deg <= 0.05)) {
            if (!state.compoundExtensionData[_comp]) state.compoundExtensionData[_comp] = { sum: 0, count: 0 };
            state.compoundExtensionData[_comp].sum += _age / _nomLife;
            state.compoundExtensionData[_comp].count++;
        }
    }

    for (var driverNum in driverListLines) {
        var driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        var stints = getAllStints(timingAppLines, driverNum);
        var degRateEntry = allDegRates[driverNum];
        var drDegRate = degRateEntry ? degRateEntry.deg : null;
        var drHealth = calcSectorHealth(driverNum, timingDataLines, currentLap);
        var battleResult = detectBattles(driverNum, timingDataLines, currentLap);

        var compoundKey = "---";
        if (stints && stints.length > 0) {
            compoundKey = stints[stints.length - 1].Compound || "---";
        }

        if (compoundKey !== "---" && state.previousCompounds[driverNum] && state.previousCompounds[driverNum] !== compoundKey && !state.justPittedDrivers[driverNum]) {
            state.justPittedDrivers[driverNum] = currentLap;
            if (state.driverHistory[driverNum]) {
                state.driverHistory[driverNum].laps = [];
                state.driverHistory[driverNum].segmentScores = [];
                state.driverHistory[driverNum].positions = [];
                state.driverHistory[driverNum].dirtyAirHistory = [];
                state.driverHistory[driverNum].degRate = null;
            }
        }
        state.previousCompounds[driverNum] = compoundKey;

        var teammateNum = teammateMap[driverNum];
        var teammateDeg = null;
        if (teammateNum && allDegRates[teammateNum]) {
            teammateDeg = allDegRates[teammateNum].deg;
        }

        var compoundAvgDeg = compoundAvgDegMap[compoundKey] || null;

        var window = calcPitWindow(
            driverNum, currentLap, stints, drDegRate, drHealth,
            battleResult.penalty, compoundAvgDeg, teammateDeg, totalLaps
        );

        if (window) {
            newPredictedWindows[driverNum] = window;
        }
    }

    const newUndercutThreats = [];
    const activeUndercutPairs = new Set();

    // Active undercuts: drivers who pitted with a captured target at pit entry
    for (var _pdn in state.justPittedDrivers) {
        const entry = state.pitEntryTargets[_pdn];
        if (!entry) continue;

        var currentGap = computeGapBetween(_pdn, entry.target, timingDataLines, state.currentPositionOrder);
        if (currentGap === null) currentGap = entry.gapAtEntry;

        newUndercutThreats.push({ behind: _pdn, ahead: entry.target, gap: currentGap, type: "undercut_active" });

        const histKey = _pdn + "_" + entry.target;
        if (!state.undercutHistory[histKey]) state.undercutHistory[histKey] = [];
        const hist = state.undercutHistory[histKey];
        hist.push(currentGap);
        if (hist.length > 6) hist.shift();

        activeUndercutPairs.add(_pdn + "_" + entry.target);
    }

    // Predicted undercuts: adjacent pairs not already tracked as active
    for (var i = 0; i < state.currentPositionOrder.length - 1; i++) {
        const driverBehind = state.currentPositionOrder[i + 1];
        const driverAhead = state.currentPositionOrder[i];
        if (activeUndercutPairs.has(driverBehind.num + "_" + driverAhead.num)) continue;
        const behindTiming = timingDataLines[driverBehind.num];
        if (behindTiming && behindTiming.IntervalToPositionAhead && behindTiming.IntervalToPositionAhead.Value) {
            const gap = parseFloat(behindTiming.IntervalToPositionAhead.Value);
            const threat = detectUndercutOvercut(driverBehind.num, driverAhead.num, gap, timingDataLines, currentLap);
            if (threat) {
                newUndercutThreats.push({
                    behind: driverBehind.num,
                    ahead: driverAhead.num,
                    gap: gap,
                    type: threat.type,
                    netGain: threat.netGain,
                    paceLoss: threat.paceLoss,
                    lapsUndercut: threat.lapsUndercut,
                    lapsOvercut: threat.lapsOvercut,
                });
            }
        }
    }

    state.predictedWindows = newPredictedWindows;
    state.undercutThreats = newUndercutThreats;

    const activeUCKeys = new Set(
        newUndercutThreats
            .filter(function (t) { return t.type === "undercut_active"; })
            .map(function (t) { return t.behind + "_" + t.ahead; })
    );
    for (const key in state.undercutHistory) {
        if (!activeUCKeys.has(key)) delete state.undercutHistory[key];
    }
    state.degRates = newDegRates;
    state.compoundCounts = newCounts;
}

module.exports = { computeAll, detectPitStops };
