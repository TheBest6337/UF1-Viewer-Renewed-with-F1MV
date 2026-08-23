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

    // Normalize to a per-segment average before storing. The raw sum scales with how
    // many segments a lap has (~20), which swamped the FRESH/OPTIMAL/DEGRADING/GONE
    // thresholds below and made GONE the de-facto default regardless of actual pace.
    const perSegmentScore = currentScore / segmentCount;

    // One entry per LAP, updated in place as later polls of the same lap see more
    // segments. Pushing per poll (the live loop hits each lap ~45 times) made this
    // "8-lap" buffer hold about 6 seconds of data.
    const scores = state.driverHistory[driverNum].segmentScores;
    const existingScore = scores.find(function (entry) { return entry.lap === currentLap; });
    if (existingScore) {
        existingScore.score = perSegmentScore;
    } else {
        scores.push({ lap: currentLap, score: perSegmentScore });
        if (scores.length > 8) {
            scores.shift();
        }
    }

    const lapsWithData = scores.length;
    if (lapsWithData === 0) return null;

    var totalScore = 0;
    for (const entry of scores) {
        totalScore += entry.score;
    }

    const healthScore = totalScore / lapsWithData;

    var healthState;
    if (healthScore > 1.0) healthState = "FRESH";
    else if (healthScore >= 0.0) healthState = "OPTIMAL";
    else if (healthScore >= -1.5) healthState = "DEGRADING";
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

    var newCleanLap = false;
    if (!alreadyRecorded && currentLap > 1 && !isInPit && !isOutLap && !isSCLap && lapTimeSec > 0) {
        history.push({ lap: currentLap, time: lapTimeSec, clean: true });
        newCleanLap = true;
        if (history.length > 8) {
            history.shift();
        }
    }

    // Require more than the bare minimum of clean laps before trusting the regression -
    // a 3-point fit on noisy lap times is what made degRate (and the windows derived
    // from it) flip sign from one lap to the next. While the buffer is thin (start of
    // stint, or wiped on SC exit), fall back to the surviving EMA instead of null so
    // an SC doesn't blank the whole field's deg at once and sawtooth every window.
    // Confidence ramps slowly: a 4-point fit is barely better than a guess (0.17),
    // full trust only after ~9 clean laps.
    const cleanLaps = history.filter(function (entry) { return entry.clean; });
    state.driverHistory[driverNum].degConfidence = Math.min(1, Math.max(0, (cleanLaps.length - 3) / 6));
    if (cleanLaps.length < 4) {
        return state.driverHistory[driverNum].degEma != null ? state.driverHistory[driverNum].degEma : null;
    }

    const points = cleanLaps.map(function (entry) {
        return { x: entry.lap, y: entry.time };
    });

    const rawSlope = linearRegression(points);
    if (rawSlope === null) return state.driverHistory[driverNum].degEma != null ? state.driverHistory[driverNum].degEma : null;

    // The 8-point OLS slope is noisy: a traffic-recovery sequence can fit to several
    // seconds per lap of "improvement". Clamp to the physically plausible range and
    // smooth with an EMA that advances once per new clean lap — never per 2s poll —
    // so one bad fit cannot yank the pit window around.
    const clamped = Math.min(0.5, Math.max(-0.3, rawSlope));
    if (newCleanLap || state.driverHistory[driverNum].degEma == null) {
        if (state.driverHistory[driverNum].degEma == null) {
            state.driverHistory[driverNum].degEma = clamped;
        } else {
            state.driverHistory[driverNum].degEma = 0.3 * clamped + 0.7 * state.driverHistory[driverNum].degEma;
        }
    }

    return state.driverHistory[driverNum].degEma;
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
