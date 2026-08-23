#!/usr/bin/env node
/*
 * Builds src/strategypredictor/priors.json from historical OpenF1 data
 * (https://openf1.org — free for past seasons, no auth).
 *
 * For every Grand Prix circuit it computes, from the last completed seasons:
 *   - per compound: median tyre age at which cars actually pitted (medianPitAge),
 *     a degradation slope in s/lap (degSlope), and a pace offset vs the driver's
 *     race median (paceOffset, seconds). Dry races feed the slick-compound stats;
 *     wet races feed INTERMEDIATE/WET (their slick stints end because of rain, not
 *     tyre life, so those are excluded — but the wet-compound stints are the only
 *     wet evidence we have and are analyzed in every season)
 *   - median pit lane transit time (laneDurationMedian, same semantics as the
 *     PitLaneTimeCollection Duration the app averages live)
 *
 * The strategy predictor loads the entry matching SessionInfo's circuit name at
 * runtime (src/strategypredictor/priors.js) and falls back to the static compound
 * lives when no entry matches.
 *
 * Usage:
 *   node src/scripts/build-openf1-priors.js                       # all circuits, 2024+2025
 *   node src/scripts/build-openf1-priors.js --circuits=catalunya,silverstone,spa
 *   node src/scripts/build-openf1-priors.js --years=2025
 *
 * Responses are cached on disk (--cache-dir, default: OS tempdir/openf1-cache) so
 * re-runs don't hammer the API. Requests are sequential with a delay — the free
 * tier rate-limits aggressively.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const API = "https://api.openf1.org/v1";
const OUT_FILE = path.join(__dirname, "..", "strategypredictor", "priors.json");
const REQUEST_DELAY_MS = 400;

function parseArgs() {
    const args = { years: [2024, 2025], circuits: null, cacheDir: path.join(os.tmpdir(), "openf1-cache") };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith("--years=")) args.years = a.split("=")[1].split(",").map(Number);
        else if (a.startsWith("--circuits=")) args.circuits = a.split("=")[1].split(",").map(normalizeKey);
        else if (a.startsWith("--cache-dir=")) args.cacheDir = a.split("=")[1];
    }
    return args;
}

function normalizeKey(name) {
    return String(name || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "");
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

let cacheDir;
async function apiGet(pathAndQuery) {
    const cacheFile = path.join(cacheDir, pathAndQuery.replace(/[^a-z0-9]/gi, "_") + ".json");
    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }
    await sleep(REQUEST_DELAY_MS);
    for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await fetch(API + pathAndQuery);
        if (res.status === 429) {
            const wait = 2000 * attempt;
            console.log("  rate limited, waiting " + wait + "ms ...");
            await sleep(wait);
            continue;
        }
        // Some endpoints have no data for older sessions (e.g. /pit before mid-2023
        // 404s permanently). Cache that as empty so re-runs don't re-fetch it.
        if (res.status === 404) {
            fs.writeFileSync(cacheFile, "[]");
            return [];
        }
        if (!res.ok) throw new Error("OpenF1 " + res.status + " for " + pathAndQuery);
        const data = await res.json();
        fs.writeFileSync(cacheFile, JSON.stringify(data));
        return data;
    }
    throw new Error("OpenF1 rate limit persisted for " + pathAndQuery);
}

function median(values) {
    if (!values || values.length === 0) return null;
    const s = values.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function olsSlope(points) {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (const p of points) {
        sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x;
    }
    const den = n * sx2 - sx * sx;
    if (den === 0) return null;
    return (n * sxy - sx * sy) / den;
}

// One race's contribution: pit ages / deg slopes / pace offsets per compound + pit lane times.
async function analyzeSession(sessionKey, fetchLaps) {
    const out = { pitAges: {}, degSlopes: {}, paceOffsets: {}, laneDurations: [], wet: false };

    const weather = await apiGet("/weather?session_key=" + sessionKey);
    const rainy = weather.filter(function (w) { return w.rainfall && Number(w.rainfall) > 0; }).length;
    if (weather.length > 0 && rainy / weather.length > 0.15) out.wet = true;

    const stints = await apiGet("/stints?session_key=" + sessionKey);
    const pits = await apiGet("/pit?session_key=" + sessionKey);

    for (const p of pits) {
        const d = Number(p.lane_duration != null ? p.lane_duration : p.pit_duration);
        if (!isNaN(d) && d > 12 && d < 60) out.laneDurations.push(d);
    }

    // Group stints per driver, ordered; a stint followed by another stint ended in a
    // pit stop, so its final tyre age is a real "pitted at age X" observation.
    const byDriver = {};
    for (const s of stints) {
        if (!byDriver[s.driver_number]) byDriver[s.driver_number] = [];
        byDriver[s.driver_number].push(s);
    }
    for (const num in byDriver) {
        const list = byDriver[num].sort(function (a, b) { return a.stint_number - b.stint_number; });
        for (let i = 0; i < list.length - 1; i++) {
            const s = list[i];
            if (!s.compound || s.lap_end == null || s.lap_start == null) continue;
            const ageAtPit = (s.tyre_age_at_start || 0) + (s.lap_end - s.lap_start + 1);
            if (ageAtPit < 3 || ageAtPit > 60) continue;
            if (!out.pitAges[s.compound]) out.pitAges[s.compound] = [];
            out.pitAges[s.compound].push(ageAtPit);
        }
    }

    // Wet sessions always get lap analysis (INT/WET evidence is too scarce to skip);
    // dry lap analysis only for the most recent season to limit heavy queries.
    if (!fetchLaps && !out.wet) return out;

    const laps = await apiGet("/laps?session_key=" + sessionKey);
    if (laps.length === 0) return out;
    const lapsByDriver = {};
    for (const l of laps) {
        if (!lapsByDriver[l.driver_number]) lapsByDriver[l.driver_number] = [];
        lapsByDriver[l.driver_number].push(l);
    }

    for (const num in byDriver) {
        const driverLaps = lapsByDriver[num];
        if (!driverLaps) continue;
        const byLapNum = {};
        for (const l of driverLaps) byLapNum[l.lap_number] = l;

        const allDurations = driverLaps
            .filter(function (l) { return l.lap_duration && !l.is_pit_out_lap; })
            .map(function (l) { return l.lap_duration; });
        const driverMedian = median(allDurations);
        if (!driverMedian) continue;

        for (const s of byDriver[num]) {
            if (!s.compound || s.lap_end == null || s.lap_start == null) continue;
            // In a wet session only the wet-weather compounds carry usable information:
            // a slick stint there was ended by rain, not by tyre life, and its lap
            // times track the conditions, not degradation. The INT/WET stints ARE the
            // information — they're the only source of wet priors we have.
            const isWetCompound = s.compound === "INTERMEDIATE" || s.compound === "WET";
            if (out.wet && !isWetCompound) continue;
            const points = [];
            for (let lapNum = s.lap_start; lapNum <= s.lap_end; lapNum++) {
                const l = byLapNum[lapNum];
                if (!l || !l.lap_duration || l.is_pit_out_lap) continue;
                if (lapNum === s.lap_end) continue; // usually the in-lap
                if (l.lap_duration > driverMedian * 1.15) continue; // SC/traffic proxy
                const tyreAge = (s.tyre_age_at_start || 0) + (lapNum - s.lap_start);
                points.push({ x: tyreAge, y: l.lap_duration, offset: l.lap_duration - driverMedian });
            }
            if (points.length >= 5) {
                const slope = olsSlope(points);
                if (slope !== null && slope > -0.5 && slope < 1.0) {
                    if (!out.degSlopes[s.compound]) out.degSlopes[s.compound] = [];
                    out.degSlopes[s.compound].push(slope);
                }
                // Pace offsets compare against the driver's race median, which mixed
                // conditions contaminate — dry sessions only.
                if (!out.wet) {
                    if (!out.paceOffsets[s.compound]) out.paceOffsets[s.compound] = [];
                    out.paceOffsets[s.compound].push(median(points.map(function (p) { return p.offset; })));
                }
            }
        }
    }

    return out;
}

async function main() {
    const args = parseArgs();
    cacheDir = args.cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });

    // circuit key -> accumulated observations across seasons
    const circuits = {};

    for (const year of args.years) {
        const sessions = await apiGet("/sessions?year=" + year + "&session_name=Race&session_type=Race");
        console.log(year + ": " + sessions.length + " races");
        for (const session of sessions) {
            const key = normalizeKey(session.circuit_short_name);
            if (args.circuits && args.circuits.indexOf(key) === -1) continue;

            console.log("  " + session.circuit_short_name + " (" + session.session_key + ") ...");
            let result;
            try {
                result = await analyzeSession(session.session_key, true);
            } catch (err) {
                console.log("    skipped: " + err.message);
                continue;
            }

            if (!circuits[key]) {
                circuits[key] = {
                    displayName: session.circuit_short_name,
                    pitAges: {}, degSlopes: {}, paceOffsets: {}, laneDurations: [], seasons: [],
                };
            }
            const c = circuits[key];
            c.seasons.push(year + (result.wet ? " (wet: INT/WET data only)" : ""));
            c.laneDurations = c.laneDurations.concat(result.laneDurations);
            for (const comp in result.pitAges) {
                if (result.wet && comp !== "INTERMEDIATE" && comp !== "WET") continue;
                if (!c.pitAges[comp]) c.pitAges[comp] = [];
                c.pitAges[comp] = c.pitAges[comp].concat(result.pitAges[comp]);
            }
            for (const comp in result.degSlopes) {
                if (!c.degSlopes[comp]) c.degSlopes[comp] = [];
                c.degSlopes[comp] = c.degSlopes[comp].concat(result.degSlopes[comp]);
            }
            for (const comp in result.paceOffsets) {
                if (!c.paceOffsets[comp]) c.paceOffsets[comp] = [];
                c.paceOffsets[comp] = c.paceOffsets[comp].concat(result.paceOffsets[comp]);
            }
        }
    }

    const output = {};
    for (const key in circuits) {
        const c = circuits[key];
        const compounds = {};
        const allComps = new Set(Object.keys(c.pitAges).concat(Object.keys(c.degSlopes)));
        for (const comp of allComps) {
            const entry = {};
            if (c.pitAges[comp] && c.pitAges[comp].length >= 4) {
                entry.medianPitAge = median(c.pitAges[comp]);
                entry.pitAgeSamples = c.pitAges[comp].length;
            }
            if (c.degSlopes[comp] && c.degSlopes[comp].length >= 3) {
                entry.degSlope = Math.round(median(c.degSlopes[comp]) * 1000) / 1000;
                entry.degSamples = c.degSlopes[comp].length;
            }
            if (c.paceOffsets[comp] && c.paceOffsets[comp].length >= 3) {
                entry.paceOffset = Math.round(median(c.paceOffsets[comp]) * 100) / 100;
            }
            if (Object.keys(entry).length > 0) compounds[comp] = entry;
        }
        var totalSamples = 0;
        for (const comp in c.pitAges) totalSamples += c.pitAges[comp].length;
        output[key] = {
            displayName: c.displayName,
            compounds: compounds,
            laneDurationMedian: c.laneDurations.length >= 5 ? Math.round(median(c.laneDurations) * 10) / 10 : null,
            seasons: c.seasons,
            totalSamples: totalSamples,
        };
    }

    const existing = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : {};
    delete existing._meta;
    // Never let a run degraded by network failures overwrite a richer entry from an
    // earlier build: per circuit, the version built from more pit-age samples wins.
    const merged = Object.assign({}, existing);
    for (const key in output) {
        const prev = existing[key];
        if (prev && prev.totalSamples != null && output[key].totalSamples < prev.totalSamples) {
            console.log("  keeping previous " + key + " entry (" + prev.totalSamples + " samples vs " + output[key].totalSamples + ")");
            continue;
        }
        merged[key] = output[key];
    }
    merged._meta = { generatedAt: new Date().toISOString(), source: "openf1.org", years: args.years };
    fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2) + "\n");
    console.log("\nWrote " + Object.keys(output).length + " circuit(s) to " + OUT_FILE);
    for (const key in output) {
        const comps = Object.keys(output[key].compounds).map(function (comp) {
            const e = output[key].compounds[comp];
            return comp + (e.medianPitAge ? "=" + e.medianPitAge : "");
        });
        console.log("  " + key + ": " + comps.join(", ") + " | pitLane " + output[key].laneDurationMedian + "s");
    }
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
