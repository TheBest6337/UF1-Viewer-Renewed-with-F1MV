const debug = false;

const f1mvApi = require("npm_f1mv_api");
const { ipcRenderer } = require("electron");

const config = {
    configData: {},
    host: "localhost",
    port: 10101,
};

async function getConfigurations() {
    const configFile = (await ipcRenderer.invoke("get_store")).config;
    config.host = configFile.network.host;
    config.port = (await f1mvApi.discoverF1MVInstances(config.host)).port;
    config.configData = configFile.strategypredictor || {};
    if (debug) {
        console.log("strategy config:", config.configData);
    }
}

function getDriverConfig(key, defaultValue) {
    const cfg = config.configData;
    if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== "") {
        if (typeof defaultValue === "number") {
            const parsed = parseFloat(cfg[key]);
            if (!isNaN(parsed)) return parsed;
            return defaultValue;
        }
        if (typeof defaultValue === "boolean") {
            if (cfg[key] === "true" || cfg[key] === true) return true;
            if (cfg[key] === "false" || cfg[key] === false) return false;
            return defaultValue;
        }
        return cfg[key];
    }
    return defaultValue;
}

function getCompoundLife(compound) {
    // A user-configured value always wins; otherwise the circuit prior (median tyre
    // age at which cars really pitted this compound at this track, from OpenF1
    // history), else the static default. The old static defaults (M=30, H=42) ran
    // 12-24 laps longer than real stint lengths, which is why predictions skewed late.
    const { getPriorCompoundLife } = require("./priors");
    switch (compound) {
        case "SOFT": return getDriverConfig("softMaxLaps", getPriorCompoundLife("SOFT", 16));
        case "MEDIUM": return getDriverConfig("mediumMaxLaps", getPriorCompoundLife("MEDIUM", 30));
        case "HARD": return getDriverConfig("hardMaxLaps", getPriorCompoundLife("HARD", 42));
        case "INTERMEDIATE": return getDriverConfig("intermediateMaxLaps", getPriorCompoundLife("INTERMEDIATE", 20));
        case "WET": return getDriverConfig("wetMaxLaps", getPriorCompoundLife("WET", 15));
        default: return getDriverConfig("softMaxLaps", 16);
    }
}

module.exports = { config, getConfigurations, getDriverConfig, getCompoundLife };
