const debug = false;

const { state } = require("./state");
const { getDriverConfig } = require("./config");

function detectBattles(driverNum, timingDataLines, currentLap) {
    const driverTiming = timingDataLines[driverNum];
    if (!driverTiming) return { fighting: false, dirtyAir: false, pushing: false, penalty: 0 };

    if (!state.driverHistory[driverNum]) state.driverHistory[driverNum] = {};
    if (!state.driverHistory[driverNum].positions) state.driverHistory[driverNum].positions = [];

    const currentPos = parseInt(driverTiming.Position);
    const positions = state.driverHistory[driverNum].positions;

    if (!isNaN(currentPos)) {
        const alreadyRecorded = positions.some(function (e) { return e.lap === currentLap; });
        if (!alreadyRecorded) {
            positions.push({ lap: currentLap, position: currentPos });
            if (positions.length > 5) positions.shift();
        }
    }

    if (positions.length < 2) return { fighting: false, dirtyAir: false, pushing: false, penalty: 0 };

    var fighting = false;
    var positionChanges = 0;
    for (var i = 1; i < positions.length; i++) {
        if (positions[i].position !== positions[i - 1].position) {
            positionChanges++;
        }
    }
    const swapThreshold = getDriverConfig("swapThreshold", 3);
    if (positionChanges >= swapThreshold) fighting = true;

    var dirtyAir = false;
    const intervalData = driverTiming.IntervalToPositionAhead;
    var dirtyAirCount = 0;
    if (intervalData && intervalData.Value) {
        const gapToAhead = parseFloat(intervalData.Value);
        if (gapToAhead < 1.0) dirtyAirCount = 1;
    }

    if (!state.driverHistory[driverNum].dirtyAirHistory) state.driverHistory[driverNum].dirtyAirHistory = [];
    const daHistory = state.driverHistory[driverNum].dirtyAirHistory;
    daHistory.push(dirtyAirCount > 0);
    if (daHistory.length > 5) daHistory.shift();
    const daInLast5 = daHistory.filter(function (v) { return v; }).length;
    const dirtyAirThreshold = getDriverConfig("dirtyAirThreshold", 3);
    if (daInLast5 >= dirtyAirThreshold) dirtyAir = true;

    var pushing = false;
    const positionsInLast5 = positions;
    const gainedPositions = positionsInLast5.filter(function (entry, idx) {
        if (idx === 0 || !positionsInLast5[idx - 1]) return false;
        const prevPos = positionsInLast5[idx - 1].position;
        return entry.position < prevPos;
    }).length;
    const pushThreshold = getDriverConfig("pushThreshold", 2);
    if (gainedPositions >= pushThreshold) pushing = true;

    var penalty = 0;
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

module.exports = { detectBattles };
