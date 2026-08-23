const debug = false;

const { state } = require("./state");
const { getPriorPaceOffset } = require("./priors");

// Undercut: the driver behind pits first and gains fresh-tyre pace every lap the
// driver ahead stays out. The gain per lap is roughly the ahead car's degradation
// rate times how old their tyres are (fresh tyre = age 0), plus any compound pace
// difference; when both cars use the same pit lane the pit losses cancel. A threat
// exists when the projected gain covers the current gap with a safety margin.
function detectUndercutOvercut(driverBehindNum, driverAheadNum, gapBetween, timingDataLines, currentLap) {
    if (gapBetween === null || isNaN(gapBetween)) return null;
    if (gapBetween > state.avgPitLoss + 3) return null;

    const behindWindow = state.predictedWindows[driverBehindNum];
    const aheadWindow = state.predictedWindows[driverAheadNum];
    if (!behindWindow || !aheadWindow) return null;
    if (behindWindow.justPitted || aheadWindow.justPitted) return null;

    const behindMinLap = behindWindow.minLap;
    const aheadMinLap = aheadWindow.minLap;

    if (behindMinLap < aheadMinLap) {
        // Laps the ahead driver would stay out after the behind driver's stop; the
        // projection degrades quickly past a handful of laps, so cap it.
        const lapsUndercut = Math.min(aheadMinLap - behindMinLap, 5);

        const aheadDeg = Math.min(0.5, Math.max(0, aheadWindow.adjustedDeg != null ? aheadWindow.adjustedDeg : 0.05));
        const aheadAge = aheadWindow.stintAge || 0;
        var freshPaceAdv = Math.min(3.0, aheadDeg * aheadAge);

        const behindOffset = getPriorPaceOffset(behindWindow.compound);
        const aheadOffset = getPriorPaceOffset(aheadWindow.compound);
        if (behindOffset !== null && aheadOffset !== null) {
            freshPaceAdv += Math.max(-0.5, Math.min(0.5, aheadOffset - behindOffset));
        }

        const netGain = freshPaceAdv * lapsUndercut;
        if (gapBetween < netGain - 1.0) {
            return { type: "undercut", netGain: netGain, lapsUndercut: lapsUndercut, gap: gapBetween };
        }
        return null;
    }

    if (aheadMinLap < behindMinLap) {
        const lapsOvercut = Math.min(behindMinLap - aheadMinLap, 5);
        const behindDeg = Math.min(0.5, Math.max(0, behindWindow.adjustedDeg != null ? behindWindow.adjustedDeg : 0.05));
        const behindAge = behindWindow.stintAge || 0;
        // Staying out only works if the behind car's old tyres aren't bleeding more
        // time than the gap they need to close.
        const oldTirePaceLoss = Math.min(3.0, behindDeg * behindAge) * lapsOvercut;
        if (gapBetween < oldTirePaceLoss) {
            return { type: "overcut", paceLoss: oldTirePaceLoss, lapsOvercut: lapsOvercut, gap: gapBetween };
        }
    }

    return null;
}

module.exports = { detectUndercutOvercut };
