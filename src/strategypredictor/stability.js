const debug = false;

const { state } = require("./state");

// Same mapping calcPitWindow's margins produce (safetyMargin/overstayMargin = 3):
// urgency 1 from the lap the window opens, urgency 2 once it's 6+ laps stale.
function urgencyFromWindow(minLap, currentLap) {
    if (currentLap >= minLap + 6) return 2;
    if (currentLap >= minLap) return 1;
    return 0;
}

// The estimate from calcPitWindow is recomputed every 2s poll and jitters with the
// degradation fit. What the user sees (and the log records) is the PUBLISHED window,
// which only moves:
//   - at a lap boundary, and only when the estimate moved decisively (>=2 laps at
//     once, the same +/-1 disagreement for 2 consecutive laps, or confidence rose
//     by >=0.2), snapping fully to the estimate, or
//   - immediately on an event (own pit stop / compound change / track status change),
//     which bypasses the hysteresis.
function publishWindow(driverNum, estimate, currentLap, eventOverride) {
    if (!estimate) {
        delete state.publishMeta[driverNum];
        return null;
    }

    var meta = state.publishMeta[driverNum];

    if (!meta || eventOverride || estimate.justPitted || estimate.noPitNeeded) {
        state.publishMeta[driverNum] = {
            minLap: estimate.minLap,
            maxLap: estimate.maxLap,
            confidence: estimate.confidence || 0,
            lastLap: currentLap,
            pendingDir: 0,
            pendingCount: 0,
        };
        return withPublishedBounds(estimate, estimate.minLap, estimate.maxLap, currentLap);
    }

    if (currentLap > meta.lastLap) {
        meta.lastLap = currentLap;

        var diff = estimate.minLap - meta.minLap;
        var confRose = (estimate.confidence || 0) - meta.confidence >= 0.2;
        var move = false;

        if (diff === 0) {
            meta.pendingDir = 0;
            meta.pendingCount = 0;
        } else {
            // A very large correction (first real pit-age evidence, deg collapse) goes
            // through immediately; everything else must disagree in the SAME direction
            // for 2 consecutive laps — regression noise flips direction, real
            // information doesn't.
            var dir = diff > 0 ? 1 : -1;
            if (meta.pendingDir === dir) meta.pendingCount++;
            else {
                meta.pendingDir = dir;
                meta.pendingCount = 1;
            }

            if (Math.abs(diff) >= 8) move = true;
            else if (meta.pendingCount >= 2) move = true;
            else if (confRose && Math.abs(diff) >= 2) move = true;
        }

        if (move) {
            meta.minLap = estimate.minLap;
            meta.maxLap = estimate.maxLap;
            meta.confidence = estimate.confidence || 0;
            meta.pendingDir = 0;
            meta.pendingCount = 0;
        }
    }

    return withPublishedBounds(estimate, meta.minLap, meta.maxLap, currentLap);
}

// Pass the live estimate's informational fields through, but pin the window bounds
// and derive urgency/lapsLeft from the published bounds so status text, timeline bar
// and log always agree with the window the user is looking at.
function withPublishedBounds(estimate, minLap, maxLap, currentLap) {
    var published = Object.assign({}, estimate);
    published.internalMin = estimate.minLap;
    published.internalMax = estimate.maxLap;
    published.minLap = minLap;
    published.maxLap = maxLap;
    if (!estimate.noPitNeeded) {
        published.urgency = urgencyFromWindow(minLap, currentLap);
        published.lapsLeft = Math.max(0, minLap + 3 - currentLap);
    }
    return published;
}

module.exports = { publishWindow, urgencyFromWindow };
