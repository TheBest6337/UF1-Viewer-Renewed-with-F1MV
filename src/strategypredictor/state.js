const debug = false;

const state = {
    driverHistory: {},
    predictedWindows: {},
    undercutThreats: [],
    undercutHistory: {},
    pitEntryTargets: {},
    prevInPit: {},
    oldPitstops: [],
    justPittedDrivers: {},
    previousCompounds: {},
    avgPitLoss: 22.5,
    degRates: {},
    compoundCounts: {},
    compoundExtensionData: {},
    fleetMaxCompoundAge: {},
    lastTrackStatus: "1",
    lastSCExitLap: -99,
    lastRainfall: 0,
    prevRainfall: 0,
    rainTransitionMessage: "",
    rainTransitionTimer: 0,
    sessionType: null,
    currentPositionOrder: [],
};

function driverJustPitted(driverNum) {
    return state.justPittedDrivers[driverNum] !== undefined;
}

module.exports = { state, driverJustPitted };
