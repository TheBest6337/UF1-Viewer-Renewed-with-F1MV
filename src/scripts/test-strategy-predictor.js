#!/usr/bin/env node
/*
 * Replays a recorded strategy-log .jsonl race through the CURRENT
 * src/strategypredictor/* code and reports how well pit detection, sector-health
 * scoring, and pit-window predictions track against what actually happened in
 * that race.
 *
 * The race's own per-lap log entries are the ground truth: compound changes in
 * the log tell us when drivers really pitted, and the log's recorded segment
 * counts / lap times let us rebuild a synthetic TimingData/TimingAppData feed
 * to drive the real computeAll()/logLap() functions exactly as the live app
 * would. This lets you change something in src/strategypredictor/, re-run this
 * script against old races, and see the effect on concrete accuracy numbers
 * instead of guessing.
 *
 * Usage:
 *   node src/scripts/test-strategy-predictor.js logs/*.jsonl
 *   node src/scripts/test-strategy-predictor.js logs/austria-strategy-strategy-2026-06-28T12-50-55.jsonl --json
 *
 * Known approximation: the log only stores segment *counts* per color bucket,
 * not the exact per-segment sequence, and only the final lap time, not which
 * lap was an out-lap. Sector-health scoring is unaffected (it only needs the
 * counts). Degradation-rate regression may occasionally include an out-lap it
 * would have excluded live; this is a minor noise source, not a correctness
 * issue, and applies equally before/after any change you're comparing.
 */

const fs = require("fs");
const path = require("path");

const STRAT_DIR = path.join(__dirname, "..", "strategypredictor");
const { formatMsToF1 } = require("../functions/times.js");

const SEGMENT_CODE_BY_BUCKET = {
    purple: 2051,
    green: 2049,
    yellow: 2048,
    red: 2052,
    blue: 2064,
    other: 9999,
};

function freshModules() {
    // Each race needs an isolated state singleton. compute.js/degradation.js/etc. all
    // share one `state` object via require caching, so clear and re-require everything
    // under strategypredictor/ between races instead of trying to hand-reset every field.
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(STRAT_DIR)) delete require.cache[key];
    }
    return {
        state: require("../strategypredictor/state.js").state,
        computeAll: require("../strategypredictor/compute.js").computeAll,
        logLap: require("../strategypredictor/strategy-log.js").logLap,
    };
}

function loadRace(filePath) {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line));
}

function segmentsFromCounts(counts) {
    if (!counts) return [{ Segments: [] }];
    const segments = [];
    for (const bucket in SEGMENT_CODE_BY_BUCKET) {
        const n = counts[bucket] || 0;
        for (let i = 0; i < n; i++) segments.push({ Status: SEGMENT_CODE_BY_BUCKET[bucket] });
    }
    return [{ Segments: segments }];
}

function lapTimeToTimingValue(seconds) {
    if (seconds === null || seconds === undefined) return "";
    return formatMsToF1(Math.round(seconds * 1000), 3);
}

// Ground truth: compound changes between consecutive laps for the same driver,
// ignoring the race-start "---" -> first compound assignment and one-lap "UNKNOWN"
// feed glitches (the same class of glitch the production fix in compute.js now
// smooths over for the live predictor).
function extractGroundTruthStops(laps, driverNums) {
    const stops = [];
    for (const num of driverNums) {
        let prevCompound = null;
        for (const lap of laps) {
            const d = lap.drivers[num];
            if (!d) continue;
            if (
                prevCompound !== null &&
                prevCompound !== "---" &&
                prevCompound !== "UNKNOWN" &&
                d.compound !== "UNKNOWN" &&
                d.compound !== prevCompound
            ) {
                stops.push({ driverNum: num, lap: lap.lap, tla: d.tla, from: prevCompound, to: d.compound });
            }
            if (d.compound !== "UNKNOWN") prevCompound = d.compound;
        }
    }
    return stops;
}

function replayRace(laps) {
    const { state, computeAll, logLap } = freshModules();

    const driverNums = Object.keys(laps[0].drivers);
    const groundTruthStops = extractGroundTruthStops(laps, driverNums);

    // Intercept the logger's file writes so the test never touches the real logs/ dir.
    const capturedEntries = [];
    const realAppend = fs.appendFileSync;
    const realMkdir = fs.mkdirSync;
    const realExists = fs.existsSync;
    fs.appendFileSync = function (p, data) {
        if (typeof p === "string" && p.includes(path.join("logs", "strategy-"))) {
            capturedEntries.push(JSON.parse(data));
            return;
        }
        return realAppend.apply(fs, arguments);
    };
    fs.mkdirSync = function (p) {
        if (typeof p === "string" && p.endsWith("logs")) return;
        return realMkdir.apply(fs, arguments);
    };
    fs.existsSync = function (p) {
        if (typeof p === "string" && p.endsWith("logs")) return true;
        return realExists.apply(fs, arguments);
    };

    const stintHistory = {};
    for (const num of driverNums) stintHistory[num] = [];

    try {
        for (const lap of laps) {
            const currentLap = lap.lap;
            const driverListLines = {};
            const timingDataLines = {};
            const timingAppLines = {};

            const trackStatus = lap.trackStatus || "1";
            const wasSCVSC = state.lastTrackStatus === "4" || state.lastTrackStatus === "6";
            const nowGreen = !trackStatus || trackStatus === "1" || trackStatus === "2" || trackStatus === "7";
            if (wasSCVSC && nowGreen) {
                state.lastSCExitLap = currentLap;
                for (const dn in state.driverHistory) {
                    if (state.driverHistory[dn]) state.driverHistory[dn].laps = [];
                }
            }
            state.lastTrackStatus = trackStatus;
            state.sessionType = "Race";

            for (const num of driverNums) {
                const d = lap.drivers[num];
                if (!d) continue;

                driverListLines[num] = { Tla: d.tla };
                timingDataLines[num] = {
                    Position: String(d.position != null ? d.position : 99),
                    Retired: !!d.retired,
                    Stopped: !!d.stopped,
                    InPit: !!d.inPit,
                    LastLapTime: { Value: lapTimeToTimingValue(d.lastLapTime) },
                    Sectors: segmentsFromCounts(d.segmentCounts),
                };

                const hist = stintHistory[num];
                const compound = d.compound;
                const tyreAge = d.tyreAge || 0;
                if (hist.length === 0 || hist[hist.length - 1].Compound !== compound) {
                    hist.push({ Compound: compound, StartLaps: tyreAge, TotalLaps: tyreAge });
                } else {
                    hist[hist.length - 1].TotalLaps = tyreAge;
                }
                timingAppLines[num] = { Stints: hist.map((s) => Object.assign({}, s)) };
            }

            computeAll(driverListLines, timingDataLines, timingAppLines, {}, currentLap, lap.totalLaps, null, trackStatus);

            logLap({
                currentLap: currentLap,
                totalLaps: lap.totalLaps,
                trackStatus: trackStatus,
                avgPitLoss: lap.avgPitLoss,
                weatherData: { Rainfall: lap.rainfall || 0 },
                driverListLines: driverListLines,
                timingDataLines: timingDataLines,
                timingAppLines: timingAppLines,
                predictedWindows: state.predictedWindows,
                driverHistory: state.driverHistory,
                justPittedDrivers: state.justPittedDrivers,
                degRates: state.degRates,
                compoundCounts: state.compoundCounts,
                configData: {},
                carData: null,
                sessionStatus: "Started",
                sessionType: "Race",
                lapCount: { CurrentLap: currentLap },
            });
        }
    } finally {
        fs.appendFileSync = realAppend;
        fs.mkdirSync = realMkdir;
        fs.existsSync = realExists;
    }

    return { capturedEntries, groundTruthStops, driverNums };
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function evaluateRace(filePath) {
    const laps = loadRace(filePath);
    if (laps.length === 0) return null;

    const { capturedEntries, groundTruthStops, driverNums } = replayRace(laps);
    const entryByLap = {};
    for (const e of capturedEntries) entryByLap[e.lap] = e;

    // --- Pit-stop detection accuracy ---
    const detected = new Set();
    for (const e of capturedEntries) {
        for (const p of e.pitStopsThisLap || []) {
            detected.add(p.driverNum + ":" + e.lap);
        }
    }
    let capturedCount = 0;
    const missed = [];
    for (const s of groundTruthStops) {
        let found = false;
        for (let dl = -1; dl <= 1; dl++) {
            if (detected.has(s.driverNum + ":" + (s.lap + dl))) {
                found = true;
                break;
            }
        }
        if (found) capturedCount++;
        else missed.push(s);
    }
    const totalDetectedEvents = capturedEntries.reduce((sum, e) => sum + (e.pitStopsThisLap || []).length, 0);
    const falsePositives = Math.max(0, totalDetectedEvents - capturedCount);

    // --- Health-state distribution ---
    const healthDist = { FRESH: 0, OPTIMAL: 0, DEGRADING: 0, GONE: 0, null: 0 };
    for (const e of capturedEntries) {
        for (const num in e.drivers) {
            const state = e.drivers[num].sectorHealthState;
            healthDist[state === null ? "null" : state]++;
        }
    }

    // --- Pit-window accuracy: look at the prediction 1 lap before each real stop ---
    let windowChecked = 0,
        windowInRange = 0,
        urgentFlagged = 0;
    const lapErrors = [];
    for (const s of groundTruthStops) {
        const prevEntry = entryByLap[s.lap - 1];
        if (!prevEntry) continue;
        const d = prevEntry.drivers[s.driverNum];
        if (!d || d.predictedWindowMin == null) continue;
        windowChecked++;
        if (s.lap >= d.predictedWindowMin && s.lap <= d.predictedWindowMax) windowInRange++;
        if (d.predictedUrgency >= 1) urgentFlagged++;
        lapErrors.push(Math.abs(s.lap - d.predictedWindowMin));
    }

    // --- Window volatility ---
    const minLapChanges = [];
    for (const num of driverNums) {
        let prev = null;
        for (const e of capturedEntries) {
            const d = e.drivers[num];
            if (!d || d.predictedWindowMin == null) {
                prev = null;
                continue;
            }
            if (prev !== null) minLapChanges.push(Math.abs(d.predictedWindowMin - prev));
            prev = d.predictedWindowMin;
        }
    }
    const bigJumps = minLapChanges.filter((c) => c >= 10).length;

    // --- degRate sign-flip rate ---
    let flips = 0,
        flipTotal = 0;
    for (const num of driverNums) {
        let prevSign = null;
        for (const e of capturedEntries) {
            const d = e.drivers[num];
            if (!d || d.degRate === null || d.degRate === undefined) {
                prevSign = null;
                continue;
            }
            const sign = d.degRate > 0 ? 1 : d.degRate < 0 ? -1 : 0;
            if (prevSign !== null) {
                flipTotal++;
                if (sign !== prevSign) flips++;
            }
            prevSign = sign;
        }
    }

    let extendedCount = 0,
        extendedTotal = 0;
    for (const e of capturedEntries) {
        for (const num in e.drivers) {
            if (e.drivers[num].predictedExtended === undefined) continue;
            extendedTotal++;
            if (e.drivers[num].predictedExtended) extendedCount++;
        }
    }

    return {
        file: path.basename(filePath),
        laps: laps.length,
        drivers: driverNums.length,
        pitDetection: {
            groundTruthStops: groundTruthStops.length,
            captured: capturedCount,
            missed: missed.length,
            falsePositives: falsePositives,
            missedList: missed.map((m) => m.tla + "@L" + m.lap),
        },
        health: healthDist,
        windowAccuracy: {
            checked: windowChecked,
            inRangeOneLapPrior: windowInRange,
            urgentFlaggedOneLapPrior: urgentFlagged,
            medianAbsLapError: median(lapErrors),
        },
        volatility: {
            avgAbsLapToLapChange: minLapChanges.length
                ? minLapChanges.reduce((a, b) => a + b, 0) / minLapChanges.length
                : null,
            samples: minLapChanges.length,
            jumpsOf10PlusLaps: bigJumps,
        },
        degRateSignFlipRate: flipTotal ? flips / flipTotal : null,
        extendedBonusRate: extendedTotal ? extendedCount / extendedTotal : null,
    };
}

function pct(n, d) {
    if (!d) return "n/a";
    return ((100 * n) / d).toFixed(0) + "%";
}

function printReport(r) {
    console.log("\n=== " + r.file + " (" + r.laps + " laps, " + r.drivers + " drivers) ===");
    console.log(
        "Pit detection: " +
            r.pitDetection.captured +
            "/" +
            r.pitDetection.groundTruthStops +
            " real stops captured (" +
            pct(r.pitDetection.captured, r.pitDetection.groundTruthStops) +
            "), " +
            r.pitDetection.falsePositives +
            " false positives"
    );
    if (r.pitDetection.missedList.length) {
        console.log("  missed: " + r.pitDetection.missedList.join(", "));
    }
    console.log(
        "Sector health distribution: GONE " +
            pct(r.health.GONE, sumDist(r.health)) +
            ", DEGRADING " +
            pct(r.health.DEGRADING, sumDist(r.health)) +
            ", OPTIMAL " +
            pct(r.health.OPTIMAL, sumDist(r.health)) +
            ", FRESH " +
            pct(r.health.FRESH, sumDist(r.health))
    );
    console.log(
        "Window accuracy (1 lap before each real stop): " +
            pct(r.windowAccuracy.inRangeOneLapPrior, r.windowAccuracy.checked) +
            " landed in predicted window, " +
            pct(r.windowAccuracy.urgentFlaggedOneLapPrior, r.windowAccuracy.checked) +
            " had urgency>=1, median |actual-predictedMin| = " +
            (r.windowAccuracy.medianAbsLapError != null ? r.windowAccuracy.medianAbsLapError.toFixed(1) : "n/a") +
            " laps"
    );
    console.log(
        "Window volatility: avg lap-to-lap windowMin change = " +
            (r.volatility.avgAbsLapToLapChange != null ? r.volatility.avgAbsLapToLapChange.toFixed(2) : "n/a") +
            " laps (" +
            r.volatility.jumpsOf10PlusLaps +
            "/" +
            r.volatility.samples +
            " jumps >=10 laps)"
    );
    console.log(
        "degRate sign-flip rate: " +
            (r.degRateSignFlipRate != null ? (r.degRateSignFlipRate * 100).toFixed(0) + "%" : "n/a") +
            " | extended-life bonus rate: " +
            (r.extendedBonusRate != null ? (r.extendedBonusRate * 100).toFixed(1) + "%" : "n/a")
    );
}

function sumDist(dist) {
    return dist.FRESH + dist.OPTIMAL + dist.DEGRADING + dist.GONE + dist.null;
}

function main() {
    const args = process.argv.slice(2);
    const jsonOut = args.includes("--json");
    const files = args.filter((a) => a !== "--json");

    if (files.length === 0) {
        console.error("Usage: node src/scripts/test-strategy-predictor.js logs/*.jsonl [--json]");
        process.exit(1);
    }

    const results = [];
    for (const f of files) {
        const r = evaluateRace(f);
        if (r) results.push(r);
    }

    if (jsonOut) {
        console.log(JSON.stringify(results, null, 2));
        return;
    }

    for (const r of results) printReport(r);

    if (results.length > 1) {
        const totalGT = results.reduce((s, r) => s + r.pitDetection.groundTruthStops, 0);
        const totalCaptured = results.reduce((s, r) => s + r.pitDetection.captured, 0);
        const totalFP = results.reduce((s, r) => s + r.pitDetection.falsePositives, 0);
        const avgInRange =
            results.reduce((s, r) => s + r.windowAccuracy.inRangeOneLapPrior / Math.max(1, r.windowAccuracy.checked), 0) /
            results.length;
        console.log("\n=== AGGREGATE across " + results.length + " races ===");
        console.log("Pit detection: " + totalCaptured + "/" + totalGT + " (" + pct(totalCaptured, totalGT) + "), " + totalFP + " false positives");
        console.log("Avg window-in-range rate (1 lap prior): " + (avgInRange * 100).toFixed(0) + "%");
    }
}

main();
