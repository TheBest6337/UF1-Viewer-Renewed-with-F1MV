const debug = false;

const loopspeed = 2000;

const f1mvApi = require("npm_f1mv_api");

const { ipcRenderer } = require("electron");

const { getColorFromStatusCodeOrName } = require("../functions/colors.js");

const { parseLapOrSectorTime } = require("../functions/times.js");

const { logLap } = require("./strategy-log.js");

let driverHistory = {};

let predictedWindows = {};

let undercutThreats = [];

var oldPitstops = [];

var justPittedDrivers = {};

var previousCompounds = {};

let avgPitLoss = 22.5;

let degRates = {};

let compoundCounts = {};

let lastTrackStatus = "1";

let lastRainfall = 0;
let prevRainfall = 0;
let rainTransitionMessage = "";
let rainTransitionTimer = 0;

let sessionType = null;

let configData = {};
let host = "localhost";
let port = 10101;

let currentPositionOrder = [];

async function getConfigurations() {
    const configFile = (await ipcRenderer.invoke("get_store")).config;
    host = configFile.network.host;
    port = (await f1mvApi.discoverF1MVInstances(host)).port;
    configData = configFile.strategypredictor || {};
    if (debug) {
        console.log("strategy config:", configData);
    }
}

function getDriverConfig(key, defaultValue) {
    if (configData[key] !== undefined && configData[key] !== null && configData[key] !== "") {
        if (typeof defaultValue === "number") {
            const parsed = parseFloat(configData[key]);
            if (!isNaN(parsed)) return parsed;
            return defaultValue;
        }
        if (typeof defaultValue === "boolean") {
            if (configData[key] === "true" || configData[key] === true) return true;
            if (configData[key] === "false" || configData[key] === false) return false;
            return defaultValue;
        }
        return configData[key];
    }
    return defaultValue;
}

function getCompoundLife(compound) {
    switch (compound) {
        case "SOFT": return getDriverConfig("softMaxLaps", 16);
        case "MEDIUM": return getDriverConfig("mediumMaxLaps", 30);
        case "HARD": return getDriverConfig("hardMaxLaps", 42);
        case "INTERMEDIATE": return getDriverConfig("intermediateMaxLaps", 20);
        case "WET": return getDriverConfig("wetMaxLaps", 15);
        default: return getDriverConfig("softMaxLaps", 16);
    }
}

async function apiRequests() {
    const config = {
        host: host,
        port: port,
    };

    try {
        const liveTimingState = await f1mvApi.LiveTimingAPIGraphQL(config, [
            "DriverList",
            "TimingAppData",
            "TimingData",
            "TimingStats",
            "LapCount",
            "SessionInfo",
            "TrackStatus",
            "ExtrapolatedClock",
            "WeatherData",
            "PitLaneTimeCollection",
            "CarData",
            "SessionStatus",
        ]);

        return liveTimingState;
    } catch (error) {
        if (debug) console.log("api error:", error);
        return null;
    }
}

function parseSegmentStatus(status) {
    switch (status) {
        case 2051: return 3;
        case 2049: return 2;
        case 2048: return -1;
        case 2064: return 0;
        case 2052: return -2;
        case 2068: return -2;
        default: return -3;
    }
}

function calcSectorHealth(driverNum, timingData, currentLap) {
    const driverTiming = timingData[driverNum];
    if (!driverTiming || !driverTiming.Sectors || !driverTiming.Sectors[0]) return null;

    if (!driverHistory[driverNum] || !driverHistory[driverNum].segmentScores) {
        if (!driverHistory[driverNum]) driverHistory[driverNum] = {};
        driverHistory[driverNum].segmentScores = [];
    }

    let currentScore = 0;
    let segmentCount = 0;
    for (const sector of driverTiming.Sectors) {
        if (sector && sector.Segments) {
            for (const segment of sector.Segments) {
                currentScore += parseSegmentStatus(segment.Status);
                segmentCount++;
            }
        }
    }

    if (segmentCount === 0) return null;

    const scores = driverHistory[driverNum].segmentScores;
    scores.push({ lap: currentLap, score: currentScore });

    if (scores.length > 5) {
        scores.shift();
    }

    const lapsWithData = scores.length;
    if (lapsWithData === 0) return null;

    let totalScore = 0;
    for (const entry of scores) {
        totalScore += entry.score;
    }

    const healthScore = totalScore / lapsWithData;

    let state;
    if (healthScore > 8) state = "FRESH";
    else if (healthScore >= 3) state = "OPTIMAL";
    else if (healthScore >= -3) state = "DEGRADING";
    else state = "GONE";

    return { score: healthScore, state: state, segmentCount: segmentCount };
}

function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
}

function calcDegRate(driverNum, currentLap, sessionData) {
    const timingData = sessionData.TimingData?.Lines;
    const driverTiming = timingData ? timingData[driverNum] : null;
    if (!driverTiming) return null;

    if (!driverHistory[driverNum]) driverHistory[driverNum] = {};
    if (!driverHistory[driverNum].laps) driverHistory[driverNum].laps = [];

    const lapTimeValue = driverTiming.LastLapTime?.Value;
    if (!lapTimeValue || lapTimeValue === "") return null;

    const lapTimeSec = parseLapOrSectorTime(lapTimeValue);
    if (isNaN(lapTimeSec)) return null;

    const isInPit = driverTiming.InPit;
    const isOutLap = driverTiming.Sectors && driverTiming.Sectors[0] && driverTiming.Sectors[0].Segments && driverTiming.Sectors[0].Segments[0] && driverTiming.Sectors[0].Segments[0].Status === 2064;
    const isSCLap = lastTrackStatus === "4" || lastTrackStatus === "6";

    const history = driverHistory[driverNum].laps;
    const alreadyRecorded = history.some(function (entry) { return entry.lap === currentLap; });

    if (!alreadyRecorded && currentLap > 1 && !isInPit && !isOutLap && !isSCLap && lapTimeSec > 0) {
        history.push({ lap: currentLap, time: lapTimeSec, clean: true });
        if (history.length > 5) {
            history.shift();
        }
    }

    const cleanLaps = history.filter(function (entry) { return entry.clean; });
    if (cleanLaps.length < 3) return null;

    const points = cleanLaps.map(function (entry) {
        return { x: entry.lap, y: entry.time };
    });

    return linearRegression(points);
}

function classifyPattern(driverNum) {
    if (!driverHistory[driverNum] || !driverHistory[driverNum].laps) return "---";

    const laps = driverHistory[driverNum].laps;
    if (laps.length < 3) return "---";

    const firstHalf = laps.slice(0, Math.ceil(laps.length / 2));
    const secondHalf = laps.slice(-Math.ceil(laps.length / 2));

    const firstAvg = firstHalf.reduce(function (s, e) { return s + e.time; }, 0) / firstHalf.length;
    const lastAvg = secondHalf.reduce(function (s, e) { return s + e.time; }, 0) / secondHalf.length;

    const diff = lastAvg - firstAvg;

    if (diff < -0.3) return "up";
    if (diff > 0.3) return "down";
    return "flat";
}

function detectBattles(driverNum, timingDataLines, currentLap) {
    const driverTiming = timingDataLines[driverNum];
    if (!driverTiming) return { fighting: false, dirtyAir: false, pushing: false, penalty: 0 };

    if (!driverHistory[driverNum]) driverHistory[driverNum] = {};
    if (!driverHistory[driverNum].positions) driverHistory[driverNum].positions = [];

    const currentPos = parseInt(driverTiming.Position);
    const positions = driverHistory[driverNum].positions;

    if (!isNaN(currentPos)) {
        const alreadyRecorded = positions.some(function (e) { return e.lap === currentLap; });
        if (!alreadyRecorded) {
            positions.push({ lap: currentLap, position: currentPos });
            if (positions.length > 5) positions.shift();
        }
    }

    if (positions.length < 2) return { fighting: false, dirtyAir: false, pushing: false, penalty: 0 };

    let fighting = false;
    let positionChanges = 0;
    for (let i = 1; i < positions.length; i++) {
        if (positions[i].position !== positions[i - 1].position) {
            positionChanges++;
        }
    }
    const swapThreshold = getDriverConfig("swapThreshold", 3);
    if (positionChanges >= swapThreshold) fighting = true;

    let dirtyAir = false;
    const intervalData = driverTiming.IntervalToPositionAhead;
    let dirtyAirCount = 0;
    if (intervalData && intervalData.Value) {
        const gapToAhead = parseFloat(intervalData.Value);
        if (gapToAhead < 1.0) dirtyAirCount = 1;
    }

    if (!driverHistory[driverNum].dirtyAirHistory) driverHistory[driverNum].dirtyAirHistory = [];
    const daHistory = driverHistory[driverNum].dirtyAirHistory;
    daHistory.push(dirtyAirCount > 0);
    if (daHistory.length > 5) daHistory.shift();
    const daInLast5 = daHistory.filter(function (v) { return v; }).length;
    const dirtyAirThreshold = getDriverConfig("dirtyAirThreshold", 3);
    if (daInLast5 >= dirtyAirThreshold) dirtyAir = true;

    let pushing = false;
    const positionsInLast5 = positions;
    const gainedPositions = positionsInLast5.filter(function (entry, idx) {
        if (idx === 0 || !positionsInLast5[idx - 1]) return false;
        const prevPos = positionsInLast5[idx - 1].position;
        return entry.position < prevPos;
    }).length;
    const pushThreshold = getDriverConfig("pushThreshold", 2);
    if (gainedPositions >= pushThreshold) pushing = true;

    let penalty = 0;
    const penalties = [];
    if (fighting) penalties.push(0.05);
    if (dirtyAir) penalties.push(0.03);
    if (pushing) penalties.push(0.08);

    if (penalties.length > 0) {
        penalties.sort(function (a, b) { return b - a; });
        penalty = penalties[0];
        if (penalties.length > 1) penalty += penalties[1] * 0.5;
    }

    return { fighting: fighting, dirtyAir: dirtyAir, pushing: pushing, penalty: penalty };
}

function calcPitWindow(driverNum, currentLap, stintData, degRate, health, battlePenalty, compoundAvgDeg, teammateDeg) {
    if (!stintData || stintData.length === 0) return null;

    const currentStint = stintData[stintData.length - 1];
    const compound = currentStint.Compound || "SOFT";
    const compoundLife = getCompoundLife(compound);
    const stintAge = currentStint.TotalLaps != null ? currentStint.TotalLaps : 0;
    const threatLapThreshold = getDriverConfig("threatLapThreshold", 3);
    const tireAgeRatio = stintAge / compoundLife;

    var justPitted = driverJustPitted(driverNum);
    if (!justPitted && stintAge <= 4) {
        justPitted = true;
    }

    if (justPitted) {
        if (driverHistory[driverNum]) {
            driverHistory[driverNum].laps = [];
            driverHistory[driverNum].segmentScores = [];
            driverHistory[driverNum].positions = [];
            driverHistory[driverNum].dirtyAirHistory = [];
            driverHistory[driverNum].degRate = null;
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
            justPitted: true,
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
        var compoundCount = compoundCounts[compound] || 0;

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

    var remainingCleanLaps = effectiveLife - stintAge;

    if (battlePenalty > 0 && getDriverConfig("battleDegEnabled", true)) {
        remainingCleanLaps -= battlePenalty * remainingCleanLaps;
    }

    var lapsLeft = Math.max(0, remainingCleanLaps);

    if (tireAgeRatio > 0.85) {
        if (lapsLeft > threatLapThreshold) {
            lapsLeft = threatLapThreshold;
        }
    }

    if (tireAgeRatio < 0.30 && lapsLeft > threatLapThreshold && (adjustedDeg === null || adjustedDeg <= 0.03)) {
        lapsLeft = Math.max(lapsLeft, threatLapThreshold + 1);
    }

    var urgency = 0;
    if (lapsLeft <= 0) urgency = 2;
    else if (lapsLeft <= threatLapThreshold) urgency = 1;

    var extended = false;
    if (health && health.score >= 3 && degRate !== null && degRate <= 0) {
        lapsLeft += 5;
        extended = true;
    }

    const safetyMargin = 3;
    const overstayMargin = 3;
    const minPitLap = Math.max(currentLap + 1, Math.round(currentLap + lapsLeft - safetyMargin));
    const maxPitLap = Math.round(currentLap + lapsLeft + overstayMargin);

    return {
        compound: compound,
        stintAge: stintAge,
        minLap: minPitLap,
        maxLap: maxPitLap,
        urgency: urgency,
        extended: extended,
        lapsLeft: lapsLeft,
        compoundLife: compoundLife,
        effectiveLife: effectiveLife,
        tireAgeRatio: tireAgeRatio,
        adjustedDeg: adjustedDeg,
        originalDeg: degRate,
    };
}

function detectUndercutOvercut(driverBehindNum, driverAheadNum, gapBetween, timingDataLines, currentLap) {
    const behindWindow = predictedWindows[driverBehindNum];
    const aheadWindow = predictedWindows[driverAheadNum];
    if (!behindWindow || !aheadWindow) return null;
    if (gapBetween > 3.0) return null;

    const behindMinLap = behindWindow.minLap;
    const aheadMinLap = aheadWindow.minLap;

    if (behindMinLap < aheadMinLap) {
        const lapsUndercut = aheadMinLap - behindMinLap;
        const freshPaceAdvantage = 0.5;
        const netGain = freshPaceAdvantage * lapsUndercut - avgPitLoss;
        if (netGain > gapBetween) {
            return { type: "undercut", netGain: netGain, lapsUndercut: lapsUndercut };
        }
    }

    if (aheadMinLap < behindMinLap) {
        const lapsOvercut = behindMinLap - aheadMinLap;
        const behindDeg = (driverHistory[driverBehindNum] && driverHistory[driverBehindNum].degRate) || 0;
        const oldTirePaceLoss = behindDeg * lapsOvercut;
        if (gapBetween < oldTirePaceLoss) {
            return { type: "overcut", paceLoss: oldTirePaceLoss, lapsOvercut: lapsOvercut };
        }
    }

    return null;
}

function calcTeamDeg(driverListLines) {
    if (!driverListLines) return {};

    const teamDrivers = {};
    for (const driverNum in driverListLines) {
        const driver = driverListLines[driverNum];
        const teamName = driver.TeamName;
        if (!teamDrivers[teamName]) teamDrivers[teamName] = [];
        teamDrivers[teamName].push(driverNum);
    }

    const teamResults = {};
    for (const teamName in teamDrivers) {
        const drivers = teamDrivers[teamName];
        if (drivers.length < 2) continue;

        const teamDegRates = drivers.map(function (d) {
            return predictedWindows[d] ? (driverHistory[d] ? driverHistory[d].degRate : null) : null;
        });

        const validRates = teamDegRates.filter(function (r) { return r !== null && r !== undefined; });
        if (validRates.length === 0) continue;

        const teamAvgDeg = validRates.reduce(function (s, r) { return s + r; }, 0) / validRates.length;

        let flaggedPair = null;
        if (validRates.length === 2 && Math.abs(validRates[0] - validRates[1]) > 0.10) {
            flaggedPair = {
                driver1: drivers[0],
                driver2: drivers[1],
                rate1: validRates[0],
                rate2: validRates[1],
            };
        }

        teamResults[teamName] = {
            avgDeg: teamAvgDeg,
            drivers: drivers,
            flaggedPair: flaggedPair,
        };
    }

    return teamResults;
}

function calcCompoundRefDeg(currentDegRates, currentCounts) {
    const compoundDegAvg = {};
    for (const compound in currentCounts) {
        if (currentDegRates[compound] !== undefined) {
            compoundDegAvg[compound] = {
                avg: currentCounts[compound] > 0 ? currentDegRates[compound] / currentCounts[compound] : 0,
                count: currentCounts[compound],
            };
        }
    }
    return compoundDegAvg;
}

function handleSCVSC(trackStatus) {
    const statusNum = trackStatus ? parseInt(trackStatus) : 1;
    let mode = "normal";
    let message = "";

    const validPitLoss = !isNaN(avgPitLoss) && avgPitLoss > 0;
    switch (statusNum) {
        case 4:
            mode = "sc";
            message = validPitLoss
                ? "SAFETY CAR DEPLOYED — Pit loss ~" + (avgPitLoss * 0.55).toFixed(1) + "s (save ~" + (avgPitLoss - avgPitLoss * 0.55).toFixed(1) + "s)"
                : "SAFETY CAR DEPLOYED — Pit loss: calculating...";
            break;
        case 6:
            mode = "vsc";
            message = validPitLoss
                ? "VIRTUAL SAFETY CAR DEPLOYED — Pit loss ~" + (avgPitLoss * 0.55).toFixed(1) + "s (save ~" + (avgPitLoss - avgPitLoss * 0.55).toFixed(1) + "s)"
                : "VIRTUAL SAFETY CAR DEPLOYED — Pit loss: calculating...";
            break;
        case 7:
            mode = "vsc_ending";
            message = "VSC ENDING — Pit window closing";
            break;
        default:
            mode = "normal";
            message = "";
    }

    return { mode: mode, message: message };
}

function accumulateData(driverNum, timingData, timingAppLines, currentLap) {
    if (!driverHistory[driverNum]) driverHistory[driverNum] = {};
    driverHistory[driverNum].lastPollLap = currentLap;
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

        if (oldPitstops.indexOf(pitstopString) !== -1) continue;

        var stints = getAllStints(timingAppLines, driverNum);
        if (!stints || stints.length < 2) continue;

        var lastStint = stints[stints.length - 1];

        if (lastStint.StartLaps === lastStint.TotalLaps) {
            oldPitstops.push(pitstopString);
            justPittedDrivers[driverNum] = currentLap;
        }
    }

    for (var driverNum in justPittedDrivers) {
        if (currentLap - justPittedDrivers[driverNum] > 4) {
            delete justPittedDrivers[driverNum];
        }
    }
}

function driverJustPitted(driverNum) {
    return justPittedDrivers[driverNum] !== undefined;
}

function computeAll(driverListLines, timingDataLines, timingAppLines, timingStatsLines, currentLap, totalLaps, extrapolatedClock, trackStatus) {
    if (!driverListLines || !timingDataLines) return;

    currentPositionOrder = [];
    const posMap = {};
    for (const driverNum in timingDataLines) {
        const driverTiming = timingDataLines[driverNum];
        if (!driverTiming) continue;
        const pos = parseInt(driverTiming.Position);
        if (!isNaN(pos) && !driverTiming.Retired) {
            posMap[pos] = driverNum;
            currentPositionOrder.push({ num: driverNum, pos: pos });
        }
    }
    currentPositionOrder.sort(function (a, b) { return a.pos - b.pos; });

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

        if (driverHistory[driverNum]) {
            driverHistory[driverNum].degRate = degRate;
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

    degRates = newDegRates;
    compoundCounts = newCounts;

    var compoundAvgDegMap = {};
    for (var comp in newCounts) {
        if (newCounts[comp] > 0) {
            compoundAvgDegMap[comp] = newDegRates[comp] / newCounts[comp];
        }
    }

    for (var driverNum in driverListLines) {
        var driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        var stints = getAllStints(timingAppLines, driverNum);
        var degRateEntry = allDegRates[driverNum];
        var degRate = degRateEntry ? degRateEntry.deg : null;
        var health = calcSectorHealth(driverNum, timingDataLines, currentLap);
        var battleResult = detectBattles(driverNum, timingDataLines, currentLap);

        var compoundKey = "---";
        if (stints && stints.length > 0) {
            compoundKey = stints[stints.length - 1].Compound || "---";
        }

        if (compoundKey !== "---" && previousCompounds[driverNum] && previousCompounds[driverNum] !== compoundKey && !justPittedDrivers[driverNum]) {
            justPittedDrivers[driverNum] = currentLap;
            if (driverHistory[driverNum]) {
                driverHistory[driverNum].laps = [];
                driverHistory[driverNum].segmentScores = [];
                driverHistory[driverNum].positions = [];
                driverHistory[driverNum].dirtyAirHistory = [];
                driverHistory[driverNum].degRate = null;
            }
        }
        previousCompounds[driverNum] = compoundKey;

        var teammateNum = teammateMap[driverNum];
        var teammateDeg = null;
        if (teammateNum && allDegRates[teammateNum]) {
            teammateDeg = allDegRates[teammateNum].deg;
        }

        var compoundAvgDeg = compoundAvgDegMap[compoundKey] || null;

        var window = calcPitWindow(
            driverNum, currentLap, stints, degRate, health,
            battleResult.penalty, compoundAvgDeg, teammateDeg
        );

        if (window) {
            newPredictedWindows[driverNum] = window;
        }
    }

    const newUndercutThreats = [];
    for (let i = 0; i < currentPositionOrder.length - 1; i++) {
        const driverBehind = currentPositionOrder[i + 1];
        const driverAhead = currentPositionOrder[i];
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

    predictedWindows = newPredictedWindows;
    undercutThreats = newUndercutThreats;
    degRates = newDegRates;
    compoundCounts = newCounts;
}

function renderNormal(driverListLines, timingDataLines, timingAppLines, currentLap, totalLaps, scResult, extrapolatedClock) {
    const tbody = document.getElementById("table-body");
    tbody.innerHTML = "";

    const sortedDrivers = [];

    for (const driverNum in driverListLines) {
        const driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        const window = predictedWindows[driverNum];
        const urgency = window ? window.urgency : 0;

        sortedDrivers.push({
            num: driverNum,
            urgency: urgency,
            minLap: window ? window.minLap : 999,
        });
    }

    sortedDrivers.sort(function (a, b) {
        if (b.urgency !== a.urgency) return b.urgency - a.urgency;
        return a.minLap - b.minLap;
    });

    const showDrivers = getDriverConfig("showDrivers", "All");
    let maxDrivers = sortedDrivers.length;
    if (showDrivers === "Top5") maxDrivers = 5;
    else if (showDrivers === "Top10") maxDrivers = 10;

    const teamDegData = calcTeamDeg(driverListLines);
    const compoundRefDeg = calcCompoundRefDeg(degRates, compoundCounts);

    let displayedCount = 0;
    for (const entry of sortedDrivers) {
        if (displayedCount >= maxDrivers) break;
        displayedCount++;

        const driverNum = entry.num;
        const driverInfo = driverListLines[driverNum];
        const driverTiming = timingDataLines[driverNum];
        const stintData = timingAppLines ? (timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null) : null;
        const windowEntry = predictedWindows[driverNum];
        const degRate = (driverHistory[driverNum] && driverHistory[driverNum].degRate) || null;
        const health = calcSectorHealth(driverNum, timingDataLines, currentLap);
        const pattern = classifyPattern(driverNum);
        const battleResult = detectBattles(driverNum, timingDataLines, currentLap);

        const tla = driverInfo.Tla;
        const teamName = driverInfo.TeamName;
        const teamColour = driverInfo.TeamColour;
        const position = parseInt(driverTiming.Position);

        let urgencyClass = "";
        if (windowEntry) {
            if (windowEntry.urgency === 2) urgencyClass = "urgency-2";
            else if (windowEntry.urgency === 1) urgencyClass = "urgency-1";
        }

        const compound = stintData && stintData.length > 0 ? stintData[stintData.length - 1].Compound : "---";
        const shortCompound = compound ? compound.charAt(0) : "-";
        const compoundColor = getColorFromStatusCodeOrName(compound.charAt(0)) || "#5b5b5d";

        const stintAge = windowEntry ? windowEntry.stintAge : 0;
        const compLife = windowEntry ? windowEntry.compoundLife : 16;
        const agePercent = Math.min(100, Math.max(0, (stintAge / compLife) * 100));

        let windowText = "--";
        let statusText = "";
        let statusClass = "";

        if (windowEntry) {
            const minL = windowEntry.minLap;
            const maxL = windowEntry.maxLap;
            windowText = "Lap " + minL + "-" + maxL;

            if (windowEntry.justPitted) {
                statusText = "JUST PITTED";
                statusClass = "ok";
            } else if (windowEntry.urgency === 2) {
                statusText = "PIT NOW";
                statusClass = "urgent";
                if (windowEntry.tireAgeRatio > 0.85) statusText += " (old tires)";
            } else if (windowEntry.urgency === 1) {
                const untilLap = windowEntry.minLap - currentLap;
                statusText = "Imminent (" + untilLap + " lap" + (untilLap !== 1 ? "s" : "") + ")";
                statusClass = "imminent";
                if (windowEntry.tireAgeRatio > 0.85) statusText += " (old tires)";
            } else if (windowEntry.extended) {
                statusText = "EXTENDED";
                statusClass = "extended";
            } else {
                const lapsLeft = windowEntry.minLap - currentLap;
                var okLabel = "OK (" + Math.max(0, lapsLeft) + " laps)";
                if (windowEntry.tireAgeRatio < 0.30) okLabel = "FRESH (" + Math.max(0, lapsLeft) + " laps)";
                statusText = okLabel;
                statusClass = "ok";
            }
        } else {
            statusText = "NO DATA";
        }

        let patternIcon = "→";
        let patternTitle = "consistent";
        if (pattern === "up") { patternIcon = "↑"; patternTitle = "warming"; }
        else if (pattern === "down") { patternIcon = "↓"; patternTitle = "pushing"; }

        let battleModifier = "";
        if (battleResult.fighting && pattern === "down") battleModifier = "⚔";
        else if (battleResult.pushing && pattern === "down") battleModifier = "⇈";
        else if (battleResult.dirtyAir && pattern === "flat") battleModifier = "═";
        else if (battleResult.fighting && pattern !== "down") battleModifier = "⚔";

        if (battleModifier) patternIcon += battleModifier;

        const teamHex = teamColour ? "#" + teamColour : "#5b5b5d";

        const posDisplay = isNaN(position) ? "--" : "P" + position;

        const mainRow = document.createElement("tr");
        mainRow.className = urgencyClass;
        mainRow.innerHTML =
            '<td class="pos-cell">' + posDisplay + '</td>' +
            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + tla + '</span></td>' +
            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span><span style="font-size:11px;color:rgba(255,255,255,0.4)">●'.repeat(Math.min(5, Math.ceil(agePercent / 20))) + '</span><span style="font-size:11px;color:rgba(255,255,255,0.2)">' + ('●'.repeat(Math.max(0, 5 - Math.min(5, Math.ceil(agePercent / 20))))) + '</span></td>' +
            '<td class="pit-window-cell"><span class="window-range">' + windowText + '</span></td>' +
            '<td class="status-cell"><span class="' + statusClass + '">' + patternIcon + ' ' + statusText + '</span></td>';
        tbody.appendChild(mainRow);

        const detailRow = document.createElement("tr");
        detailRow.className = "detail-row";
        let detailHtml = "";

        if (getDriverConfig("showSectorHealth", true) && health) {
            let healthBarColor = "#4caf50";
            if (health.score > 8) healthBarColor = "#9c27b0";
            else if (health.score >= 3) healthBarColor = "#4caf50";
            else if (health.score >= -3) healthBarColor = "#fdd835";
            else healthBarColor = "#f44336";

            const healthPct = Math.min(100, Math.max(0, ((health.score + 10) / 20) * 100));
            detailHtml += 'Sectors Health ' + health.score.toFixed(0) + ' <span class="health-bar"><span class="health-bar-fill" style="width:' + healthPct + '%;background:' + healthBarColor + '"></span></span>';
        }

        if (getDriverConfig("showDegRates", true) && degRate !== null) {
            var displayDeg = degRate;
            var cappedNote = "";
            if (windowEntry && windowEntry.adjustedDeg !== null && windowEntry.adjustedDeg !== undefined &&
                windowEntry.originalDeg !== null && windowEntry.originalDeg !== undefined &&
                Math.abs(windowEntry.adjustedDeg - windowEntry.originalDeg) > 0.001) {
                displayDeg = windowEntry.adjustedDeg;
                cappedNote = " (capped from " + (degRate >= 0 ? "+" : "") + degRate.toFixed(2) + ")";
            }
            var degStr = (displayDeg >= 0 ? "+" : "") + displayDeg.toFixed(2);
            const compoundKey = shortCompound;
            if (compoundRefDeg[compoundKey] && compoundRefDeg[compoundKey].count > 0) {
                const diff = displayDeg - compoundRefDeg[compoundKey].avg;
                const diffStr = (diff >= 0 ? "+" : "") + diff.toFixed(2);
                degStr += " (" + diffStr + " vs avg " + compoundKey + ")";
            }
            degStr += cappedNote;
            detailHtml += '  |  deg ' + degStr;
        }

        if (battleResult.penalty > 0 && getDriverConfig("battleDegEnabled", true)) {
            detailHtml += '  |  <span style="color:#f44336">battle +' + battleResult.penalty.toFixed(2) + '/lap</span>';
        }

        if (detailHtml.length > 0) {
            detailRow.innerHTML = '<td colspan="5">' + detailHtml + '</td>';
            tbody.appendChild(detailRow);
        }

        if (getDriverConfig("showUndercut", true)) {
            for (const threat of undercutThreats) {
                if (threat.behind === driverNum) {
                    const threatRow = document.createElement("tr");
                    threatRow.className = "detail-row";
                    let threatText = "";
                    if (threat.type === "undercut") {
                        threatText = "↳ " + threat.gap.toFixed(1) + "s behind #" +
                            (driverListLines[threat.ahead] ? driverListLines[threat.ahead].Tla : threat.ahead) +
                            " — Undercut possible (+" + threat.netGain.toFixed(1) + "s net)";
                    } else if (threat.type === "overcut") {
                        threatText = "↳ " + threat.gap.toFixed(1) + "s behind #" +
                            (driverListLines[threat.ahead] ? driverListLines[threat.ahead].Tla : threat.ahead) +
                            " — Overcut risk (-" + threat.paceLoss.toFixed(1) + "s staying out)";
                    }
                    threatRow.innerHTML = '<td colspan="5" style="color:#fdd835">' + threatText + '</td>';
                    tbody.appendChild(threatRow);
                }
            }
        }

        if (getDriverConfig("showTeamDeg", true) && teamDegData[teamName]) {
            const teamData = teamDegData[teamName];
            const teammateNum = teamData.drivers.find(function (d) { return d !== driverNum; });
            if (teammateNum && predictedWindows[teammateNum]) {
                const teammateDeg = (driverHistory[teammateNum] && driverHistory[teammateNum].degRate) || null;
                if (teammateDeg !== null) {
                    const teamRow = document.createElement("tr");
                    teamRow.className = "detail-row";
                    let teamText = 'Team: ' + (driverListLines[teammateNum] ? driverListLines[teammateNum].Tla : teammateNum) +
                        ' [' + (predictedWindows[teammateNum] ? predictedWindows[teammateNum].compound.charAt(0) : '-') +
                        '] deg ' + (teammateDeg >= 0 ? "+" : "") + teammateDeg.toFixed(2);
                    if (degRate !== null && Math.abs(degRate - teammateDeg) > 0.10) {
                        teamText += ' → deg differs';
                    } else {
                        teamText += ' → on pace';
                    }
                    teamRow.innerHTML = '<td colspan="5" class="team-label">' + teamText + '</td>';
                    tbody.appendChild(teamRow);
                }
            }
        }
    }

}

function renderSCVSC(driverListLines, timingDataLines, timingAppLines, currentLap, scResult) {
    const tbody = document.getElementById("table-body");
    tbody.innerHTML = "";

    document.getElementById("sc-banner").classList.remove("hidden");
    document.getElementById("sc-banner").textContent = scResult.message;

    if (scResult.mode === "vsc_ending") {
        if (!document.getElementById("vsc-ending-banner")) {
            const banner = document.createElement("div");
            banner.id = "vsc-ending-banner";
            banner.style.cssText = "padding:4px 12px;font-size:11px;text-align:center;color:#f44336;background:rgba(244,67,54,0.1);";
            banner.textContent = "WINDOW CLOSING — Pit now or commit to staying out";
            document.getElementById("sc-banner").after(banner);
        }
    }

    if (scResult.mode !== "sc" && scResult.mode !== "vsc") return;

    const expiryRows = [];
    for (const driverNum in driverListLines) {
        const driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        const stintData = timingAppLines ? (timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null) : null;
        if (!stintData || stintData.length === 0) continue;

        const currentStint = stintData[stintData.length - 1];
        const compound = currentStint.Compound || "SOFT";
        const compoundLife = getCompoundLife(compound);
        const stintAge = currentStint.TotalLaps != null ? currentStint.TotalLaps : 0;
        const tireUsage = compoundLife > 0 ? stintAge / compoundLife : 0;

        let expectedLabel = "";
        let expectedClass = "";

        if (stintAge <= 4) {
            expectedLabel = "FRESH (just pitted)";
            expectedClass = "#4caf50";
        } else if (tireUsage > 0.85) {
            expectedLabel = "EXPECTED TO PIT";
            expectedClass = "#f44336";
        } else if (tireUsage > 0.60) {
            expectedLabel = "LIKELY TO PIT";
            expectedClass = "#fdd835";
        } else {
            expectedLabel = "COULD PIT (strategic)";
            expectedClass = "#ffffff";
        }

        if (stintAge > compoundLife) {
            expectedLabel = "EXPECTED (overdue!)";
            expectedClass = "#f44336";
        }

        expiryRows.push({
            num: driverNum,
            stintAge: stintAge,
            compoundLife: compoundLife,
            tireUsage: tireUsage,
            label: expectedLabel,
            color: expectedClass,
            compound: compound,
        });
    }

    expiryRows.sort(function (a, b) { return b.tireUsage - a.tireUsage; });

    for (const row of expiryRows) {
        const driverInfo = driverListLines[row.num];
        const driverTiming = timingDataLines[row.num];
        const tla = driverInfo.Tla;
        const teamHex = driverInfo.TeamColour ? "#" + driverInfo.TeamColour : "#5b5b5d";
        const position = parseInt(driverTiming.Position);
        const posDisplay = isNaN(position) ? "--" : "P" + position;
        const compound = row.compound;
        const shortCompound = compound.charAt(0);
        const compoundColor = getColorFromStatusCodeOrName(compound.charAt(0)) || "#5b5b5d";
        const agePercent = Math.min(100, Math.max(0, (row.stintAge / row.compoundLife) * 100));

        const tr = document.createElement("tr");
        tr.className = "sc-row";
        tr.innerHTML =
            '<td class="pos-cell">' + posDisplay + '</td>' +
            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + tla + '</span></td>' +
            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span><span style="font-size:11px;color:rgba(255,255,255,0.4)"> Age ' + row.stintAge + '/' + row.compoundLife + '</span></td>' +
            '<td class="pit-window-cell"><span class="age-bar"><span class="age-bar-fill" style="width:' + agePercent + '%;background:' + row.color + '"></span></span></td>' +
            '<td class="status-cell"><span style="color:' + row.color + '">' + row.label + '</span></td>';
        tbody.appendChild(tr);
    }
}

function render(driverListLines, timingDataLines, timingAppLines, currentLap, totalLaps, trackStatus, extrapolatedClock, weatherData) {
    if (!driverListLines) return;

    document.getElementById("lap-counter").textContent = "Lap " + currentLap + "/" + totalLaps;
    document.getElementById("pit-loss").textContent = (!isNaN(avgPitLoss) && avgPitLoss > 0)
        ? "Pit Loss: " + avgPitLoss.toFixed(1) + "s (SC: ~" + (avgPitLoss * 0.55).toFixed(1) + "s)"
        : "Pit Loss: calculating...";
    document.getElementById("race-end").textContent = "Race End: ~Lap " + totalLaps;

    const compoundRefDeg = calcCompoundRefDeg(degRates, compoundCounts);
    let degBarHtml = "Deg: ";
    for (const compound in compoundRefDeg) {
        const data = compoundRefDeg[compound];
        degBarHtml += "[" + compound + "]=" + (data.avg >= 0 ? "+" : "") + data.avg.toFixed(2) + "(" + data.count + ") ";
    }
    document.getElementById("deg-bar").textContent = degBarHtml;

    let trackFlagText = "SC/VSC: NONE";
    if (trackStatus === "4") trackFlagText = "SC DEPLOYED";
    else if (trackStatus === "6") trackFlagText = "VSC DEPLOYED";
    else if (trackStatus === "7") trackFlagText = "VSC ENDING";
    document.getElementById("track-flag").textContent = trackFlagText;

    let rainText = "";
    if (rainTransitionMessage) {
        rainText = rainTransitionMessage;
    }
    document.getElementById("rain-flag").textContent = rainText;

    const scResult = handleSCVSC(trackStatus);
    document.getElementById("sc-banner").classList.add("hidden");

    const vscBanner = document.getElementById("vsc-ending-banner");
    if (vscBanner) vscBanner.remove();

    if (scResult.mode === "sc" || scResult.mode === "vsc") {
        document.getElementById("main-table").querySelector("thead").style.display = "none";
        renderSCVSC(driverListLines, timingDataLines, timingAppLines, currentLap, scResult);
    } else {
        if (scResult.mode === "vsc_ending") {
            document.getElementById("sc-banner").classList.remove("hidden");
            document.getElementById("sc-banner").textContent = scResult.message;
        }
        document.getElementById("main-table").querySelector("thead").style.display = "";
        renderNormal(driverListLines, timingDataLines, timingAppLines, currentLap, totalLaps, scResult, extrapolatedClock);
    }
}

async function run() {
    await getConfigurations();

    setInterval(async function () {
        try {
            const state = await apiRequests();
            if (!state) {
                if (debug) console.log("no state returned");
                return;
            }

            const driverListLines = state.DriverList || null;
            const timingDataLines = state.TimingData ? state.TimingData.Lines : null;
            const timingAppLines = state.TimingAppData ? state.TimingAppData.Lines : null;
            const timingStatsLines = state.TimingStats ? state.TimingStats.Lines : null;
            const lapCount = state.LapCount;
            const sessionInfo = state.SessionInfo;
            const trackStatus = state.TrackStatus ? state.TrackStatus.Status : "1";
            const extrapolatedClock = state.ExtrapolatedClock;
            const weatherData = state.WeatherData;
            const pitLaneTimes = state.PitLaneTimeCollection;
            const carData = state.CarData || null;
            const sessionStatus = state.SessionStatus ? state.SessionStatus.Status : null;

            if (lapCount) {
                lastTrackStatus = trackStatus || "1";
            }

            if (sessionInfo) {
                sessionType = sessionInfo.Type;
            }

            if (sessionType && sessionType !== "Race") {
                document.getElementById("main-table").querySelector("thead").style.display = "none";
                document.getElementById("table-body").innerHTML = "";
                document.getElementById("no-race").classList.remove("hidden");
                document.getElementById("gathering").classList.add("hidden");
                document.getElementById("sc-banner").classList.add("hidden");
                const vscBanner = document.getElementById("vsc-ending-banner");
                if (vscBanner) vscBanner.remove();
                return;
            }

            document.getElementById("no-race").classList.add("hidden");

            const currentLap = lapCount ? parseInt(lapCount.CurrentLap) : 0;
            const totalLaps = lapCount ? parseInt(lapCount.TotalLaps) : 0;

            const minLapsForPrediction = getDriverConfig("minLapsForPrediction", 5);

            if (currentLap < minLapsForPrediction) {
                document.getElementById("gathering").classList.remove("hidden");
                document.getElementById("gathering-laps").textContent = "(need " + (minLapsForPrediction - currentLap) + " more laps)";
                document.getElementById("main-table").querySelector("thead").style.display = "";
                document.getElementById("table-body").innerHTML = "";
                if (driverListLines && timingDataLines) {
                    const tbody = document.getElementById("table-body");
                    for (const driverNum in driverListLines) {
                        const driverTiming = timingDataLines[driverNum];
                        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;
                        const driverInfo = driverListLines[driverNum];
                        const stintData = timingAppLines ? (timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null) : null;
                        const compound = stintData && stintData.length > 0 ? stintData[stintData.length - 1].Compound : "---";
                        const shortCompound = compound ? compound.charAt(0) : "-";
                        const compoundColor = getColorFromStatusCodeOrName(compound.charAt(0)) || "#5b5b5d";
                        const teamHex = driverInfo.TeamColour ? "#" + driverInfo.TeamColour : "#5b5b5d";
                        const position = parseInt(driverTiming.Position);
                        const compoundLife = getCompoundLife(compound);
                        const stintAge = (stintData && stintData.length > 0) ? (stintData[stintData.length - 1].TotalLaps || 0) : 0;
                        const stintStartLap = currentLap - stintAge;
                        const expectedRange = "Lap " + (stintStartLap + compoundLife - 3) + "-" + (stintStartLap + compoundLife + 3);

                        const tr = document.createElement("tr");
                        tr.innerHTML =
                            '<td class="pos-cell">' + (isNaN(position) ? "--" : "P" + position) + '</td>' +
                            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + driverInfo.Tla + '</span></td>' +
                            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span></td>' +
                            '<td class="pit-window-cell"><span class="window-range" style="color:rgba(255,255,255,0.4)">' + expectedRange + '</span></td>' +
                            '<td class="status-cell"><span style="color:rgba(255,255,255,0.3)">BASELINE</span></td>';
                        tbody.appendChild(tr);
                    }
                }
                document.getElementById("lap-counter").textContent = "Lap " + currentLap + "/" + totalLaps;

                logLap({
                    currentLap: currentLap,
                    totalLaps: totalLaps,
                    trackStatus: trackStatus,
                    avgPitLoss: avgPitLoss,
                    weatherData: weatherData || { Rainfall: 0 },
                    driverListLines: driverListLines,
                    timingDataLines: timingDataLines,
                    timingAppLines: timingAppLines,
                    predictedWindows: predictedWindows,
                    driverHistory: driverHistory,
                    justPittedDrivers: justPittedDrivers,
                    degRates: degRates,
                    compoundCounts: compoundCounts,
                    configData: configData,
                    carData: carData,
                    sessionStatus: sessionStatus,
                    sessionType: sessionType,
                    lapCount: lapCount,
                });

                return;
            }

            document.getElementById("gathering").classList.add("hidden");

            if (weatherData) {
                const currentRainfall = weatherData.Rainfall || 0;
                if (prevRainfall === 0 && currentRainfall > 0) {
                    rainTransitionMessage = "☁ RAIN STARTING — Intermediates expected. Pit window shifting.";
                    rainTransitionTimer = 10;
                } else if (prevRainfall > 0 && currentRainfall === 0) {
                    rainTransitionMessage = "☀ DRY LINE EMERGING — Slicks becoming viable. Monitor sector times.";
                    rainTransitionTimer = 10;
                }
                prevRainfall = lastRainfall;
                lastRainfall = currentRainfall;
                if (rainTransitionTimer > 0) rainTransitionTimer--;
                else rainTransitionMessage = "";
            }

            if (pitLaneTimes && pitLaneTimes.PitTimes) {
                const pitTimesArray = Object.values(pitLaneTimes.PitTimes);
                const validTimes = pitTimesArray.filter(function (pt) {
                    var d = Number(pt.Duration);
                    return !isNaN(d) && d > 0;
                });
                if (validTimes.length > 0) {
                    avgPitLoss = validTimes.reduce(function (s, pt) { return s + Number(pt.Duration); }, 0) / validTimes.length;
                }

                detectPitStops(pitLaneTimes.PitTimes, timingAppLines, currentLap);
            }

            computeAll(
                driverListLines,
                timingDataLines,
                timingAppLines,
                timingStatsLines,
                currentLap,
                totalLaps,
                extrapolatedClock,
                trackStatus
            );

            render(
                driverListLines,
                timingDataLines,
                timingAppLines,
                currentLap,
                totalLaps,
                trackStatus,
                extrapolatedClock,
                weatherData
            );

            logLap({
                currentLap: currentLap,
                totalLaps: totalLaps,
                trackStatus: trackStatus,
                avgPitLoss: avgPitLoss,
                weatherData: weatherData || { Rainfall: 0 },
                driverListLines: driverListLines,
                timingDataLines: timingDataLines,
                timingAppLines: timingAppLines,
                predictedWindows: predictedWindows,
                driverHistory: driverHistory,
                justPittedDrivers: justPittedDrivers,
                degRates: degRates,
                compoundCounts: compoundCounts,
                configData: configData,
                pitLaneTimes: pitLaneTimes,
                carData: carData,
                sessionStatus: sessionStatus,
                sessionType: sessionType,
                lapCount: lapCount,
            });

            if (debug) {
                console.log("session:", sessionType);
                console.log("lap:", currentLap + "/" + totalLaps);
                console.log("track status:", lastTrackStatus);
                console.log("predicted windows:", Object.keys(predictedWindows).length);
                console.log("undercut threats:", undercutThreats.length);
                for (const driverNum in predictedWindows) {
                    const w = predictedWindows[driverNum];
                    const d = (driverHistory[driverNum] && driverHistory[driverNum].degRate) || null;
                    console.log("  driver " + driverNum + ": window L" + w.minLap + "-" + w.maxLap + " urgency=" + w.urgency + " deg=" + (d ? d.toFixed(3) : "null"));
                }
            }

        } catch (error) {
            if (debug) console.log("loop error:", error);
        }
    }, loopspeed);
}

run();
