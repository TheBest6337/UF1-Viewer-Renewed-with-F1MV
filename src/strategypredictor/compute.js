const debug = false;

const { state } = require("./state");
const { calcSectorHealth, calcDegRate } = require("./degradation");
const { detectBattles } = require("./battles");
const { calcPitWindow } = require("./windows");
const { publishWindow } = require("./stability");
const { detectUndercutOvercut } = require("./threats");

function accumulateData(driverNum, timingData, timingAppLines, currentLap) {
    if (!state.driverHistory[driverNum]) state.driverHistory[driverNum] = {};
    state.driverHistory[driverNum].lastPollLap = currentLap;
}

function getAllStints(timingAppLines, driverNum) {
    if (!timingAppLines || !timingAppLines[driverNum]) return null;
    return timingAppLines[driverNum].Stints || null;
}

// Fires exactly once per registered pit stop (both detection paths dedupe), so the
// per-stint history buffers restart from zero for the new stint.
function resetStintHistory(driverNum) {
    if (!state.driverHistory[driverNum]) return;
    state.driverHistory[driverNum].laps = [];
    state.driverHistory[driverNum].segmentScores = [];
    state.driverHistory[driverNum].positions = [];
    state.driverHistory[driverNum].dirtyAirHistory = [];
    state.driverHistory[driverNum].degRate = null;
    state.driverHistory[driverNum].degEma = null;
    state.driverHistory[driverNum].degConfidence = 0;
}

// Live evidence of real tyre life: the wear age of the set that just came off.
// Keyed by stint count so the two detection paths (PitTimes and compound change)
// can't both record the same stop.
function recordObservedPitAge(driverNum, stints) {
    if (!stints || stints.length < 2) return;
    if (state.lastPitAgeStintCount[driverNum] === stints.length) return;
    state.lastPitAgeStintCount[driverNum] = stints.length;

    var prevStint = stints[stints.length - 2];
    var comp = prevStint.Compound;
    var age = prevStint.TotalLaps;
    if (!comp || comp === "---" || comp === "UNKNOWN" || age == null || age < 3) return;
    if (!state.observedPitAges[comp]) state.observedPitAges[comp] = [];
    state.observedPitAges[comp].push(age);
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
            if (!state.justPittedDrivers[driverNum]) resetStintHistory(driverNum);
            state.justPittedDrivers[driverNum] = currentLap;
            recordObservedPitAge(driverNum, stints);
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

    // justPittedDrivers also gets cleared inside detectPitStops, but that function only
    // runs when the live PitLaneTimeCollection feed happens to have data for this lap.
    // When it doesn't (which is common), a driver's first-stop flag never clears, which
    // permanently blocks detecting that driver's second and third stops below and leaves
    // stale entries in the undercut-threat tracking. Clear it unconditionally every lap.
    for (var _jpd in state.justPittedDrivers) {
        var _jpdLap = typeof state.justPittedDrivers[_jpd] === "object"
            ? state.justPittedDrivers[_jpd].lap
            : state.justPittedDrivers[_jpd];
        if (currentLap - _jpdLap > 4) {
            delete state.justPittedDrivers[_jpd];
        }
    }

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

    // Pit entry detection from InPit edges — the earliest live pit signal. On entry:
    // record the event, capture the undercut target, and flag every driver ahead
    // within undercut range to respond (their window is forced OPEN this poll).
    for (var _dn in timingDataLines) {
        var _dt = timingDataLines[_dn];
        if (!_dt) continue;
        const nowInPit = _dt.InPit === true;
        const wasInPit = state.prevInPit[_dn] || false;

        if (nowInPit && !wasInPit) {
            if (!state.pitEvents[_dn]) state.pitEvents[_dn] = [];
            state.pitEvents[_dn].push({ entryLap: currentLap });

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

                // Rival-pit response: only drivers this stop genuinely threatens.
                // The undercut reach is the fresh-tyre gain the pitting car can make
                // over a ~3-lap response horizon (a few seconds) — NOT the pit loss;
                // and a driver can only "respond" if pitting now is a real option:
                // tyres old enough, own window near, not fresh out of the pits.
                const posToDriverAhead = {};
                for (const entry of state.currentPositionOrder) posToDriverAhead[entry.pos] = entry.num;
                for (var _p = myPos - 1; _p >= 1 && myPos - _p <= 8; _p--) {
                    const yNum = posToDriverAhead[_p];
                    if (!yNum) break;
                    const gapToY = computeGapBetween(_dn, yNum, timingDataLines, state.currentPositionOrder);
                    if (gapToY === null) break;

                    const yWindow = state.predictedWindows[yNum];
                    const yDeg = yWindow && yWindow.adjustedDeg > 0 ? Math.min(0.5, yWindow.adjustedDeg) : 0.1;
                    const yAge = yWindow ? yWindow.stintAge || 0 : 10;
                    const undercutReach = Math.min(8, Math.max(2.5, yDeg * yAge * 3));
                    if (gapToY > undercutReach) break;

                    if (state.justPittedDrivers[yNum]) continue;
                    if (yWindow && (yWindow.justPitted || yWindow.noPitNeeded)) continue;
                    if (yWindow && yWindow.minLap - currentLap > 8) continue;
                    const yStints = getAllStints(timingAppLines, yNum);
                    if (yStints && yStints.length > 0) {
                        const yStint = yStints[yStints.length - 1];
                        const yTrackAge = (yStint.TotalLaps || 0) - (yStint.StartLaps || 0);
                        if (yTrackAge < 6) continue;
                    }

                    state.respondTo[yNum] = { rival: _dn, setLap: currentLap, expiresLap: currentLap + 3 };
                }

                // A driver who enters the pit has responded (or made their own call) —
                // stop telling them to.
                delete state.respondTo[_dn];
            }
        } else if (!nowInPit && wasInPit) {
            const evts = state.pitEvents[_dn];
            if (evts && evts.length > 0 && evts[evts.length - 1].exitLap == null) {
                evts[evts.length - 1].exitLap = currentLap;
            }
        }
        state.prevInPit[_dn] = nowInPit;

        if (state.pitEntryTargets[_dn] && currentLap - state.pitEntryTargets[_dn].lap > 6) {
            delete state.pitEntryTargets[_dn];
        }
    }

    var newDegRates = {};
    var newCounts = {};
    var newConfSums = {};
    var newPredictedWindows = {};
    var allDegRates = {};

    // Only SC/VSC/red transitions republish every window immediately (bypassing the
    // stability layer's hysteresis) — plain yellow flickers don't move pit strategy.
    var wasNeutralized = state.publishTrackStatus === "4" || state.publishTrackStatus === "5" || state.publishTrackStatus === "6" || state.publishTrackStatus === "7";
    var nowNeutralized = trackStatus === "4" || trackStatus === "5" || trackStatus === "6" || trackStatus === "7";
    var trackStatusEvent = state.publishTrackStatus !== undefined && wasNeutralized !== nowNeutralized;
    state.publishTrackStatus = trackStatus;

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
            if (!newConfSums[compound]) newConfSums[compound] = 0;
            newDegRates[compound] += degRate;
            newCounts[compound]++;
            newConfSums[compound] += (state.driverHistory[driverNum] && state.driverHistory[driverNum].degConfidence) || 0;
        }
    }

    state.degRates = newDegRates;
    state.compoundCounts = newCounts;
    // How mature the fleet's own deg estimates are, per compound (0..1). Early in a
    // race/stint cycle the fleet average is built from junk 4-lap fits and should not
    // displace the historical prior all at once.
    state.compoundConfAvg = {};
    for (var _cc in newCounts) {
        if (newCounts[_cc] > 0) state.compoundConfAvg[_cc] = newConfSums[_cc] / newCounts[_cc];
    }

    var compoundAvgDegMap = {};
    for (var comp in newCounts) {
        if (newCounts[comp] > 0) {
            compoundAvgDegMap[comp] = newDegRates[comp] / newCounts[comp];
        }
    }

    // Long low-deg runs per compound among cars CURRENTLY on track. Rebuilt fresh each
    // poll so it is non-monotonic: when the long-runner pits, the floor it provided
    // disappears (unlike the old fleetMaxCompoundAge running max, which grew +1 every
    // lap by construction and made every window recede).
    state.fleetCurrentLongRun = {};
    for (var _dn in allDegRates) {
        var _stints = getAllStints(timingAppLines, _dn);
        if (!_stints || _stints.length === 0) continue;
        var _stint = _stints[_stints.length - 1];
        var _comp = _stint.Compound || "---";
        if (_comp === "---" || _comp === "UNKNOWN") continue;
        var _age = _stint.TotalLaps != null ? _stint.TotalLaps : 0;
        var _deg = allDegRates[_dn] ? allDegRates[_dn].deg : null;

        if (_age > 5 && (_deg === null || _deg < 0.05)) {
            if (!state.fleetCurrentLongRun[_comp]) state.fleetCurrentLongRun[_comp] = [];
            state.fleetCurrentLongRun[_comp].push({ age: _age, driver: _dn });
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

        // The live timing feed occasionally reports a transient "UNKNOWN" compound for a
        // lap before resolving to the real one. Treat that as "still on the last known
        // compound" rather than a fresh value, so it doesn't look like a pit stop and
        // doesn't make calcPitWindow fall back to the SOFT compound-life default.
        var effectiveStints = stints;
        var lastKnownCompound = state.previousCompounds[driverNum];
        if (compoundKey === "UNKNOWN" && lastKnownCompound && lastKnownCompound !== "---" && lastKnownCompound !== "UNKNOWN") {
            compoundKey = lastKnownCompound;
            effectiveStints = stints.slice(0, -1).concat([Object.assign({}, stints[stints.length - 1], { Compound: compoundKey })]);
        }

        // No "!state.justPittedDrivers[driverNum]" guard here: the previousCompounds
        // diff above already only fires once per genuine compound transition, so the
        // guard added nothing except blocking detection of a second stop that happens
        // within the same 4-lap cooldown as the first (e.g. back-to-back pit stops).
        if (compoundKey !== "---" && state.previousCompounds[driverNum] && state.previousCompounds[driverNum] !== "---" && state.previousCompounds[driverNum] !== compoundKey) {
            state.justPittedDrivers[driverNum] = currentLap;
            resetStintHistory(driverNum);
            recordObservedPitAge(driverNum, stints);
        }
        state.previousCompounds[driverNum] = compoundKey;

        var teammateNum = teammateMap[driverNum];
        var teammateDeg = null;
        if (teammateNum && allDegRates[teammateNum]) {
            teammateDeg = allDegRates[teammateNum].deg;
        }

        var compoundAvgDeg = compoundAvgDegMap[compoundKey] || null;

        var window = calcPitWindow(
            driverNum, currentLap, effectiveStints, drDegRate, drHealth,
            battleResult.penalty, compoundAvgDeg, teammateDeg, totalLaps
        );

        var respond = state.respondTo[driverNum];
        if (respond && currentLap > respond.expiresLap) {
            delete state.respondTo[driverNum];
            respond = null;
        }

        if (window) {
            state.driverEstimates[driverNum] = window;
            var eventOverride = trackStatusEvent ||
                state.justPittedDrivers[driverNum] === currentLap ||
                (respond && respond.setLap === currentLap);
            var published = publishWindow(driverNum, window, currentLap, eventOverride);
            if (published) {
                // A driver fresh out of the pits has nothing to respond to.
                if (respond && !window.justPitted) published.respondTo = respond;
                newPredictedWindows[driverNum] = published;
            }
        }
    }

    const newUndercutThreats = [];
    const activeUndercutPairs = new Set();

    // Active undercuts: drivers who pitted with a captured target at pit entry.
    for (var _pdn in state.justPittedDrivers) {
        const entry = state.pitEntryTargets[_pdn];
        if (!entry) continue;

        // The duel is over once the target covers by pitting too, and the user can
        // dismiss a card they don't need.
        var targetPitLap = typeof state.justPittedDrivers[entry.target] === "object"
            ? state.justPittedDrivers[entry.target].lap
            : state.justPittedDrivers[entry.target];
        if (targetPitLap !== undefined && targetPitLap >= entry.lap) continue;
        if (state.dismissedUndercuts[_pdn + "_" + entry.target]) continue;

        var currentGap = computeGapBetween(_pdn, entry.target, timingDataLines, state.currentPositionOrder);
        if (currentGap === null) currentGap = entry.gapAtEntry;

        newUndercutThreats.push({ behind: _pdn, ahead: entry.target, gap: currentGap, gapAtEntry: entry.gapAtEntry, type: "undercut_active" });

        const histKey = _pdn + "_" + entry.target;
        if (!state.undercutHistory[histKey]) state.undercutHistory[histKey] = [];
        const hist = state.undercutHistory[histKey];
        hist.push(currentGap);
        if (hist.length > 6) hist.shift();

        activeUndercutPairs.add(_pdn + "_" + entry.target);
    }

    // Predicted undercuts/overcuts: for each driver, every rival ahead within pit-loss
    // range — not just the adjacent car; a genuine undercut threat can sit 2-3
    // positions back. Nearest rival first so the display shows the closest threat.
    const posToDriverNum = {};
    for (const entry of state.currentPositionOrder) posToDriverNum[entry.pos] = entry.num;
    for (var i = 1; i < state.currentPositionOrder.length; i++) {
        const driverBehind = state.currentPositionOrder[i];
        for (var aheadPos = driverBehind.pos - 1; aheadPos >= 1 && driverBehind.pos - aheadPos <= 8; aheadPos--) {
            const aheadNum = posToDriverNum[aheadPos];
            if (!aheadNum) break;
            if (activeUndercutPairs.has(driverBehind.num + "_" + aheadNum)) continue;
            const gap = computeGapBetween(driverBehind.num, aheadNum, timingDataLines, state.currentPositionOrder);
            if (gap === null || gap > state.avgPitLoss + 3) break;
            const threat = detectUndercutOvercut(driverBehind.num, aheadNum, gap, timingDataLines, currentLap);
            if (threat) {
                newUndercutThreats.push({
                    behind: driverBehind.num,
                    ahead: aheadNum,
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
    // A dismissal lives as long as the duel it silences; once the underlying pit
    // tracking expires, clear it so a future duel between the same cars shows again.
    for (const key in state.dismissedUndercuts) {
        const dismissedBehind = key.split("_")[0];
        if (!state.justPittedDrivers[dismissedBehind] || !state.pitEntryTargets[dismissedBehind]) {
            delete state.dismissedUndercuts[key];
        }
    }
    state.degRates = newDegRates;
    state.compoundCounts = newCounts;
}

module.exports = { computeAll, detectPitStops };
