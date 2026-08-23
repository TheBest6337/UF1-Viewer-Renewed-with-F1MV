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
    compoundConfAvg: {},
    // Tyre ages (wear laps) at which cars actually pitted this race, per compound —
    // the live evidence that replaces the old oldest-survivor ratchet.
    observedPitAges: {},
    lastPitAgeStintCount: {},
    // Longest CURRENT low-deg run per compound, rebuilt each poll from cars still on
    // track (non-monotonic: drops back when the long-runner pits).
    fleetCurrentLongRun: {},
    // Raw per-poll window estimates and the hysteresis bookkeeping for the published
    // windows (state.predictedWindows holds only published entries).
    driverEstimates: {},
    publishMeta: {},
    // Per-driver pit lane entry/exit events (from TimingData.InPit edges — the
    // earliest live pit signal, ~2s latency vs 1-3 laps for stint-data confirmation).
    pitEvents: {},
    // driver -> { rival, setLap, expiresLap }: a rival in undercut range just pitted,
    // this driver's window is forced OPEN to respond.
    respondTo: {},
    pitLaneClosed: false,
    rcmProcessedCount: 0,
    // Undercut cards the user closed manually (key: behind_ahead); pruned when the
    // underlying duel tracking expires.
    dismissedUndercuts: {},
    lastTrackStatus: "1",
    lastSCExitLap: -99,
    lastRainfall: 0,
    prevRainfall: 0,
    rainTransitionMessage: "",
    rainTransitionTimer: 0,
    sessionType: null,
    currentPositionOrder: [],
    circuitKey: null,
    priorPitLoss: null,
};

function driverJustPitted(driverNum) {
    return state.justPittedDrivers[driverNum] !== undefined;
}

module.exports = { state, driverJustPitted };
