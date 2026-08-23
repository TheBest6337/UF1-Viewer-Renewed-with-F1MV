const debug = false;

const f1mvApi = require("npm_f1mv_api");
const { config } = require("./config");

async function apiRequests() {
    const apiConfig = {
        host: config.host,
        port: config.port,
    };

    try {
        const liveTimingState = await f1mvApi.LiveTimingAPIGraphQL(apiConfig, [
            "DriverList",
            "TimingAppData",
            "TimingData",
            "TimingStats",
            "LapCount",
            "SessionInfo",
            "TrackStatus",
            "ExtrapolatedClock",
            "WeatherData",
            "PitLaneTimeCollection",
            "CarData",
            "SessionStatus",
            "RaceControlMessages",
        ]);

        return liveTimingState;
    } catch (error) {
        if (debug) console.log("api error:", error);
        return null;
    }
}

module.exports = { apiRequests };
