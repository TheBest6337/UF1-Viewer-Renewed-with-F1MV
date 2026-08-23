const debug = false;

const { state } = require("./state");

// Historical per-circuit priors generated offline from OpenF1 data by
// src/scripts/build-openf1-priors.js. Everything here degrades gracefully:
// no priors.json, or no entry for the current circuit, means callers get their
// fallback value and the predictor behaves like before.

var priorsData = null;

function loadPriors() {
    if (priorsData === null) {
        try {
            priorsData = require("./priors.json");
        } catch (err) {
            priorsData = {};
        }
    }
    return priorsData;
}

function normalizeCircuitKey(name) {
    if (!name) return null;
    return String(name)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "");
}

// F1MV SessionInfo names that differ from OpenF1's circuit_short_name.
const ALIASES = {
    barcelona: "catalunya",
    circuitdebarcelonacatalunya: "catalunya",
    spa: "spafrancorchamps",
    monaco: "montecarlo",
    redbullring: "spielberg",
    villeneuve: "montreal",
    gillesvilleneuve: "montreal",
    hermanosrodriguez: "mexicocity",
    americas: "austin",
    cota: "austin",
    marinabay: "singapore",
    yasmarina: "yasmarinacircuit",
    abudhabi: "yasmarinacircuit",
    losail: "lusail",
    albertpark: "melbourne",
    saopaulo: "interlagos",
    autodromojosecarlospace: "interlagos",
    monzanationalautodrome: "monza",
    bahrain: "sakhir",
    abudhabi: "yasmarina",
};

function getCircuitPriors() {
    const key = normalizeCircuitKey(state.circuitKey);
    if (!key) return null;
    const data = loadPriors();
    if (data[key]) return data[key];
    const alias = ALIASES[key];
    if (alias && data[alias]) return data[alias];
    for (const k in data) {
        if (k === "_meta") continue;
        if (key.indexOf(k) !== -1 || k.indexOf(key) !== -1) return data[k];
    }
    if (debug) console.log("no priors entry for circuit:", state.circuitKey, "->", key);
    return null;
}

// Median tyre age at which cars actually pitted this compound at this circuit.
function getPriorCompoundLife(compound, fallback) {
    const p = getCircuitPriors();
    if (p && p.compounds && p.compounds[compound] && p.compounds[compound].medianPitAge) {
        return p.compounds[compound].medianPitAge;
    }
    return fallback;
}

// Historical degradation slope (s/lap) for this compound at this circuit.
function getPriorDeg(compound) {
    const p = getCircuitPriors();
    if (p && p.compounds && p.compounds[compound] && p.compounds[compound].degSlope != null) {
        return p.compounds[compound].degSlope;
    }
    return null;
}

// Historical pace offset (s vs driver race median); used for undercut math.
function getPriorPaceOffset(compound) {
    const p = getCircuitPriors();
    if (p && p.compounds && p.compounds[compound] && p.compounds[compound].paceOffset != null) {
        return p.compounds[compound].paceOffset;
    }
    return null;
}

// Median pit lane transit time — same semantics as PitLaneTimeCollection Duration.
function getPriorPitLoss() {
    const p = getCircuitPriors();
    return p && p.laneDurationMedian ? p.laneDurationMedian : null;
}

module.exports = { getCircuitPriors, getPriorCompoundLife, getPriorDeg, getPriorPaceOffset, getPriorPitLoss };
