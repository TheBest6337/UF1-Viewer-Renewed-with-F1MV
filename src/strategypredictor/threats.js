const debug = false;

const { state } = require("./state");

function detectUndercutOvercut(driverBehindNum, driverAheadNum, gapBetween, timingDataLines, currentLap) {
    const behindWindow = state.predictedWindows[driverBehindNum];
    const aheadWindow = state.predictedWindows[driverAheadNum];
    if (!behindWindow || !aheadWindow) return null;
    if (gapBetween > 3.0) return null;

    const behindMinLap = behindWindow.minLap;
    const aheadMinLap = aheadWindow.minLap;

    if (behindMinLap < aheadMinLap) {
        const lapsUndercut = aheadMinLap - behindMinLap;
        const freshPaceAdvantage = 0.5;
        const netGain = freshPaceAdvantage * lapsUndercut - state.avgPitLoss;
        if (netGain > gapBetween) {
            return { type: "undercut", netGain: netGain, lapsUndercut: lapsUndercut };
        }
    }

    if (aheadMinLap < behindMinLap) {
        const lapsOvercut = behindMinLap - aheadMinLap;
        const behindDeg = (state.driverHistory[driverBehindNum] && state.driverHistory[driverBehindNum].degRate) || 0;
        const oldTirePaceLoss = behindDeg * lapsOvercut;
        if (gapBetween < oldTirePaceLoss) {
            return { type: "overcut", paceLoss: oldTirePaceLoss, lapsOvercut: lapsOvercut };
        }
    }

    return null;
}

module.exports = { detectUndercutOvercut };
