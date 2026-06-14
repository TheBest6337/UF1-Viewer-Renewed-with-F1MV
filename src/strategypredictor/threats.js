const debug = false;

const { state } = require("./state");

function detectUndercutOvercut(driverBehindNum, driverAheadNum, gapBetween, timingDataLines, currentLap) {
    if (gapBetween > 4.0) return null;

    const behindJustPitted = state.justPittedDrivers[driverBehindNum] !== undefined;
    const aheadJustPitted = state.justPittedDrivers[driverAheadNum] !== undefined;

    // Active undercut: behind driver just pitted, ahead driver hasn't yet
    if (behindJustPitted && !aheadJustPitted) {
        return { type: "undercut_active", gap: gapBetween };
    }

    const behindWindow = state.predictedWindows[driverBehindNum];
    const aheadWindow = state.predictedWindows[driverAheadNum];
    if (!behindWindow || !aheadWindow) return null;

    const behindMinLap = behindWindow.minLap;
    const aheadMinLap = aheadWindow.minLap;

    if (behindMinLap < aheadMinLap) {
        const lapsUndercut = aheadMinLap - behindMinLap;
        const projectedGain = 0.5 * lapsUndercut;
        return { type: "undercut", netGain: projectedGain, lapsUndercut: lapsUndercut, gap: gapBetween };
    }

    if (aheadMinLap < behindMinLap) {
        const lapsOvercut = behindMinLap - aheadMinLap;
        const behindDeg = (state.driverHistory[driverBehindNum] && state.driverHistory[driverBehindNum].degRate) || 0;
        const oldTirePaceLoss = behindDeg * lapsOvercut;
        if (gapBetween < oldTirePaceLoss) {
            return { type: "overcut", paceLoss: oldTirePaceLoss, lapsOvercut: lapsOvercut, gap: gapBetween };
        }
    }

    return null;
}

module.exports = { detectUndercutOvercut };
