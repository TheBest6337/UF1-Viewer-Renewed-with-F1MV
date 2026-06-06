const debug = false;

// Poll interval in milliseconds (80ms is standard)
const loopspeed = 80;

const f1mvApi = require("npm_f1mv_api");
const { ipcRenderer } = require("electron");

// Import shared utilities as needed:
// const { isDriverOnPushLap, getDriverPosition } = require("../functions/driver.js");
// const { getCarData, weirdCarBehaviour } = require("../functions/car.js");
// const { getColorFromStatusCodeOrName, rgbToHex } = require("../functions/colors.js");
// const { parseLapOrSectorTime, formatMsToF1 } = require("../functions/times.js");

let host, port;

// Step 1: Load config and discover the F1MV instance
async function getConfigurations() {
    const config = await ipcRenderer.invoke("get_store");

    // Network config
    host = config.config.network.host;
    port = (await f1mvApi.discoverF1MVInstances(host)).port;

    // Feature-specific config (if any):
    // const featureConfig = config.config.{{FEATURE_NAME}};

    if (debug) {
        console.log("Host:", host);
        console.log("Port:", port);
    }
}

// Step 2: Fetch data from the F1MV API
async function apiRequests() {
    const apiConfig = { host, port };

    const liveTimingState = await f1mvApi.LiveTimingAPIGraphQL(apiConfig, [
        "DriverList",
        "TimingData",
        "SessionInfo",
        "TrackStatus",
        // Add only the fields this feature needs
    ]);

    // Store results in module-level variables for the render function
    // e.g., driverList = liveTimingState.DriverList;
}

// Step 3: Render data into the DOM
function render() {
    // DOM updates go here — called every `loopspeed` ms
}

// Step 4: Entry point
async function run() {
    await getConfigurations();
    await apiRequests();
    render();

    setInterval(async () => {
        await apiRequests();
        render();
    }, loopspeed);
}

run();
