const debug = false;

const { parseLapOrSectorTime } = require("../functions/times.js");
const { state } = require("./state");

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

    if (!state.driverHistory[driverNum] || !state.driverHistory[driverNum].segmentScores) {
        if (!state.driverHistory[driverNum]) state.driverHistory[driverNum] = {};
        state.driverHistory[driverNum].segmentScores = [];
    }

    var currentScore = 0;
    var segmentCount = 0;
    for (const sector of driverTiming.Sectors) {
        if (sector && sector.Segments) {
            for (const segment of sector.Segments) {
                currentScore += parseSegmentStatus(segment.Status);
                segmentCount++;
            }
        }
    }

    if (segmentCount === 0) return null;

    const scores = state.driverHistory[driverNum].segmentScores;
    scores.push({ lap: currentLap, score: currentScore });

    if (scores.length > 5) {
        scores.shift();
    }

    const lapsWithData = scores.length;
    if (lapsWithData === 0) return null;

    var totalScore = 0;
    for (const entry of scores) {
        totalScore += entry.score;
    }

    const healthScore = totalScore / lapsWithData;

    var healthState;
    if (healthScore > 8) healthState = "FRESH";
    else if (healthScore >= 3) healthState = "OPTIMAL";
    else if (healthScore >= -3) healthState = "DEGRADING";
    else healthState = "GONE";

    return { score: healthScore, state: healthState, segmentCount: segmentCount };
}

function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;

    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

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

    if (!state.driverHistory[driverNum]) state.driverHistory[driverNum] = {};
    if (!state.driverHistory[driverNum].laps) state.driverHistory[driverNum].laps = [];

    const lapTimeValue = driverTiming.LastLapTime?.Value;
    if (!lapTimeValue || lapTimeValue === "") return null;

    const lapTimeSec = parseLapOrSectorTime(lapTimeValue);
    if (isNaN(lapTimeSec)) return null;

    const isInPit = driverTiming.InPit;
    const isOutLap = driverTiming.Sectors && driverTiming.Sectors[0] && driverTiming.Sectors[0].Segments && driverTiming.Sectors[0].Segments[0] && driverTiming.Sectors[0].Segments[0].Status === 2064;
    const isSCLap = state.lastTrackStatus === "4" || state.lastTrackStatus === "6" || currentLap <= state.lastSCExitLap + 1;

    const history = state.driverHistory[driverNum].laps;
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
    if (!state.driverHistory[driverNum] || !state.driverHistory[driverNum].laps) return "---";

    const laps = state.driverHistory[driverNum].laps;
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

module.exports = { parseSegmentStatus, calcSectorHealth, linearRegression, calcDegRate, classifyPattern };
