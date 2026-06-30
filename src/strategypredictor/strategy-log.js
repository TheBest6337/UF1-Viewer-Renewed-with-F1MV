const debug = false;

const fs = require("fs");
const path = require("path");

const { parseLapOrSectorTime } = require("../functions/times.js");

let logFilePath = null;
let lastLoggedLap = 0;
let lastDriverPositions = {};
let reportedPitStops = {};

function initLogFile() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const logsDir = path.join(__dirname, "..", "..", "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    logFilePath = path.join(logsDir, "strategy-" + timestamp + ".jsonl");
    if (debug) console.log("[strategy-log] writing to:", logFilePath);
}

function getTrackStatusLabel(status) {
    switch (status) {
        case "1": return "Green";
        case "2": return "Yellow";
        case "4": return "SC";
        case "5": return "Red";
        case "6": return "VSC";
        case "7": return "VSC_Ending";
        default: return "Unknown";
    }
}

function countSegments(driverTiming) {
    var counts = { purple: 0, green: 0, yellow: 0, red: 0, blue: 0, other: 0 };
    if (!driverTiming || !driverTiming.Sectors) return counts;
    for (var i = 0; i < driverTiming.Sectors.length; i++) {
        var sector = driverTiming.Sectors[i];
        if (sector && sector.Segments) {
            for (var j = 0; j < sector.Segments.length; j++) {
                switch (sector.Segments[j].Status) {
                    case 2051: counts.purple++; break;
                    case 2049: counts.green++; break;
                    case 2048: counts.yellow++; break;
                    case 2052: case 2068: counts.red++; break;
                    case 2064: counts.blue++; break;
                    default: counts.other++; break;
                }
            }
        }
    }
    return counts;
}

function getCarChannels(carData, driverNumber) {
    try {
        return carData[0].Cars[driverNumber].Channels;
    } catch (e) {
        return null;
    }
}

function weirdCarBehaviour(channels, racingNumber, timingData, sessionStatus, sessionType, trackStatus) {
    if (!channels) return true;

    var rpm = channels[0];
    var speed = channels[2];
    var gear = channels[3];

    var speedThreshold;
    if (
        sessionType === "Qualifying" ||
        sessionType === "Practice" ||
        trackStatus === "4" ||
        trackStatus === "6" ||
        trackStatus === "7"
    ) {
        speedThreshold = 10;
    } else if (sessionStatus === "Inactive" || sessionStatus === "Aborted") {
        speedThreshold = 0;
    } else {
        speedThreshold = 30;
    }

    return (
        rpm === 0 ||
        speed <= speedThreshold ||
        gear > 8 ||
        gear === 0
    );
}

function overwriteCrashedStatus(racingNumber, timingData, sessionStatus, sessionType, lapCount, carData) {
    var driverTimingData = timingData[racingNumber];
    if (!driverTimingData) return true;

    if (driverTimingData.InPit === true) return true;
    if (driverTimingData.Retired === true) return true;
    if (driverTimingData.Stopped === true) return true;

    if (!driverTimingData.Sectors || driverTimingData.Sectors.length === 0) return true;

    var lastSector = driverTimingData.Sectors[driverTimingData.Sectors.length - 1];
    if (!lastSector || !lastSector.Segments || lastSector.Segments.length === 0) return true;

    var lastSectorSegments = lastSector.Segments;
    var sessionInactive = sessionStatus === "Inactive" || sessionStatus === "Finished" || sessionStatus === "Finalised";

    if (!lastSectorSegments && sessionInactive) return true;
    if (!lastSectorSegments) return false;

    if (lastSectorSegments.length >= 2 &&
        lastSectorSegments[lastSectorSegments.length - 2].Status !== 0 &&
        sessionInactive &&
        !driverTimingData.PitOut) {
        return true;
    }

    if (
        sessionType === "Race" &&
        sessionStatus === "Started" &&
        lastSectorSegments.length >= 3 &&
        (lastSectorSegments[lastSectorSegments.length - 3].Status !== 0 ||
            (driverTimingData.Sectors[0].Segments &&
                driverTimingData.Sectors[0].Segments.length > 1 &&
                driverTimingData.Sectors[0].Segments[1].Status === 0)) &&
        lapCount && parseInt(lapCount.CurrentLap) === 1
    ) {
        return true;
    }

    if (sessionType === "Practice" && driverTimingData.PitOut) {
        return true;
    }

    if (
        sessionType === "Race" &&
        (sessionStatus === "Finished" || sessionStatus === "Finalised") &&
        lastSectorSegments.some(function (seg) { return seg.Status !== 0; })
    ) {
        return true;
    }

    return false;
}

function driverHasCrashed(driverNumber, carData, timingData, sessionStatus, sessionType, trackStatus, lapCount) {
    if (!carData) return false;

    var channels = getCarChannels(carData, driverNumber);
    if (!channels) return false;

    if (!weirdCarBehaviour(channels, driverNumber, timingData, sessionStatus, sessionType, trackStatus)) return false;
    if (overwriteCrashedStatus(driverNumber, timingData, sessionStatus, sessionType, lapCount, carData)) return false;

    return true;
}

function getCompoundLife(compound, configData) {
    switch (compound) {
        case "SOFT": return getDriverConfig("softMaxLaps", 16, configData);
        case "MEDIUM": return getDriverConfig("mediumMaxLaps", 30, configData);
        case "HARD": return getDriverConfig("hardMaxLaps", 42, configData);
        case "INTERMEDIATE": return getDriverConfig("intermediateMaxLaps", 20, configData);
        case "WET": return getDriverConfig("wetMaxLaps", 15, configData);
        default: return getDriverConfig("softMaxLaps", 16, configData);
    }
}

function getDriverConfig(key, defaultValue, configData) {
    if (configData && configData[key] !== undefined && configData[key] !== null && configData[key] !== "") {
        if (typeof defaultValue === "number") {
            var parsed = parseFloat(configData[key]);
            if (!isNaN(parsed)) return parsed;
            return defaultValue;
        }
        if (typeof defaultValue === "boolean") {
            if (configData[key] === "true" || configData[key] === true) return true;
            if (configData[key] === "false" || configData[key] === false) return false;
            return defaultValue;
        }
        return configData[key];
    }
    return defaultValue;
}

function computeBattleFromHistory(history, configData) {
    var result = { fighting: false, dirtyAir: false, pushing: false, penalty: 0 };

    if (!history) return result;

    var positions = history.positions;
    if (positions && positions.length >= 2) {
        var positionChanges = 0;
        for (var i = 1; i < positions.length; i++) {
            if (positions[i].position !== positions[i - 1].position) {
                positionChanges++;
            }
        }
        var swapThreshold = getDriverConfig("swapThreshold", 3, configData);
        if (positionChanges >= swapThreshold) result.fighting = true;

        var gainedPositions = 0;
        for (var i = 1; i < positions.length; i++) {
            if (positions[i].position < positions[i - 1].position) {
                gainedPositions++;
            }
        }
        var pushThreshold = getDriverConfig("pushThreshold", 2, configData);
        if (gainedPositions >= pushThreshold) result.pushing = true;
    }

    var dirtyAirHistory = history.dirtyAirHistory;
    if (dirtyAirHistory) {
        var daCount = dirtyAirHistory.filter(function (v) { return v; }).length;
        var dirtyAirThreshold = getDriverConfig("dirtyAirThreshold", 3, configData);
        if (daCount >= dirtyAirThreshold) result.dirtyAir = true;
    }

    var penalties = [];
    if (result.fighting) penalties.push(0.05);
    if (result.dirtyAir) penalties.push(0.03);
    if (result.pushing) penalties.push(0.08);
    if (penalties.length > 0) {
        penalties.sort(function (a, b) { return b - a; });
        result.penalty = penalties[0];
        if (penalties.length > 1) result.penalty += penalties[1] * 0.5;
        result.penalty = Math.round(result.penalty * 1000) / 1000;
    }

    return result;
}

function computeHealthFromHistory(history) {
    if (!history || !history.segmentScores || history.segmentScores.length === 0) return null;

    var totalScore = 0;
    for (var i = 0; i < history.segmentScores.length; i++) {
        totalScore += history.segmentScores[i].score;
    }
    var avgScore = totalScore / history.segmentScores.length;
    var score = Math.round(avgScore * 100) / 100;

    var state;
    if (avgScore > 1.0) state = "FRESH";
    else if (avgScore >= 0.0) state = "OPTIMAL";
    else if (avgScore >= -1.5) state = "DEGRADING";
    else state = "GONE";

    return { score: score, state: state };
}

function buildEntry(data) {
    var driverListLines = data.driverListLines;
    var timingDataLines = data.timingDataLines;
    var timingAppLines = data.timingAppLines;
    var currentLap = data.currentLap;
    var totalLaps = data.totalLaps;
    var trackStatus = data.trackStatus;
    var avgPitLoss = data.avgPitLoss;
    var weatherData = data.weatherData;
    var predictedWindows = data.predictedWindows || {};
    var driverHistory = data.driverHistory || {};
    var justPittedDrivers = data.justPittedDrivers || {};
    var degRates = data.degRates || {};
    var compoundCounts = data.compoundCounts || {};
    var configData = data.configData;
    var pitLaneTimes = data.pitLaneTimes;
    var carData = data.carData;
    var sessionStatus = data.sessionStatus;
    var sessionType = data.sessionType;
    var lapCountObj = data.lapCount;

    var entry = {};

    entry.lap = currentLap;
    entry.totalLaps = totalLaps;
    entry.trackStatus = trackStatus;
    entry.trackStatusLabel = getTrackStatusLabel(trackStatus);
    entry.yellowFlag = trackStatus === "2";
    entry.scActive = trackStatus === "4";
    entry.vscActive = trackStatus === "6";
    entry.vscEnding = trackStatus === "7";
    entry.redFlag = trackStatus === "5";
    entry.avgPitLoss = avgPitLoss;
    entry.rainfall = weatherData ? (weatherData.Rainfall || 0) : 0;

    entry.compoundAvgDeg = {};
    if (degRates && compoundCounts) {
        for (var compound in compoundCounts) {
            if (compoundCounts[compound] > 0) {
                entry.compoundAvgDeg[compound] = {
                    avg: Math.round((degRates[compound] / compoundCounts[compound]) * 1000) / 1000,
                    count: compoundCounts[compound],
                };
            }
        }
    }

    var newPositions = {};
    entry.drivers = {};

    if (!driverListLines || !timingDataLines) {
        entry.drivers = {};
        entry.pitStopsThisLap = [];
        return entry;
    }

    for (var driverNum in driverListLines) {
        var driverInfo = driverListLines[driverNum];
        var driverTiming = timingDataLines[driverNum];
        if (!driverTiming) continue;

        var stintData = timingAppLines && timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null;
        var currentStint = stintData && stintData.length > 0 ? stintData[stintData.length - 1] : null;

        var currentPos = parseInt(driverTiming.Position);
        var prevPos = lastDriverPositions[driverNum];

        var overtakes = 0;
        var lostPositions = 0;
        if (!isNaN(currentPos) && prevPos !== undefined && !isNaN(prevPos)) {
            if (currentPos < prevPos) overtakes = prevPos - currentPos;
            else if (currentPos > prevPos) lostPositions = currentPos - prevPos;
        }
        newPositions[driverNum] = currentPos;

        var window = predictedWindows[driverNum];
        var history = driverHistory[driverNum];
        var battle = computeBattleFromHistory(history, configData);
        var health = computeHealthFromHistory(history);

        var compound = currentStint ? currentStint.Compound : "---";
        var compoundLife = currentStint ? getCompoundLife(compound, configData) : 16;
        var tyreAge = currentStint ? (currentStint.TotalLaps != null ? currentStint.TotalLaps : 0) : 0;
        var tyreAgePercent = compoundLife > 0 ? Math.round((tyreAge / compoundLife) * 100) : 0;

        var driverEntry = {
            tla: driverInfo.Tla,
            position: isNaN(currentPos) ? null : currentPos,
            overtakes: overtakes,
            lostPositions: lostPositions,
            compound: compound,
            tyreAge: tyreAge,
            tyreAgePercent: tyreAgePercent,
            compoundLife: compoundLife,
            tyreNew: currentStint ? currentStint.New === "true" : false,
            lastLapTime: null,
            sector1: null,
            sector2: null,
            sector3: null,
            segmentCounts: countSegments(driverTiming),
            degRate: history && history.degRate !== undefined && history.degRate !== null
                ? Math.round(history.degRate * 1000) / 1000
                : null,
            sectorHealthScore: health ? health.score : null,
            sectorHealthState: health ? health.state : null,
            battleFighting: battle.fighting,
            battleDirtyAir: battle.dirtyAir,
            battlePushing: battle.pushing,
            battlePenalty: battle.penalty,
            predictedWindowMin: window ? window.minLap : null,
            predictedWindowMax: window ? window.maxLap : null,
            predictedUrgency: window ? window.urgency : null,
            predictedLapsLeft: window ? window.lapsLeft : null,
            predictedEffectiveLife: window ? window.effectiveLife : null,
            predictedAdjustedDeg: window && window.adjustedDeg !== undefined && window.adjustedDeg !== null
                ? Math.round(window.adjustedDeg * 1000) / 1000
                : null,
            predictedExtended: window ? window.extended : null,
            inPit: driverTiming.InPit || false,
            retired: driverTiming.Retired || false,
            stopped: driverTiming.Stopped || false,
            crashed: driverHasCrashed(driverNum, carData, timingDataLines, sessionStatus, sessionType, trackStatus, lapCountObj),
        };

        if (driverTiming.LastLapTime && driverTiming.LastLapTime.Value) {
            driverEntry.lastLapTime = parseLapOrSectorTime(driverTiming.LastLapTime.Value);
        }
        if (driverTiming.Sectors) {
            for (var i = 0; i < driverTiming.Sectors.length; i++) {
                var sector = driverTiming.Sectors[i];
                if (sector && sector.Value) {
                    var secKey = "sector" + (i + 1);
                    driverEntry[secKey] = parseLapOrSectorTime(sector.Value);
                }
            }
        }

        entry.drivers[driverNum] = driverEntry;
    }

    entry.pitStopsThisLap = [];
    if (justPittedDrivers) {
        for (var dn in justPittedDrivers) {
            var pittedLap = typeof justPittedDrivers[dn] === "object"
                ? justPittedDrivers[dn].lap
                : justPittedDrivers[dn];

            // The pit flag can be set a tick or two before the lap counter actually
            // advances to that lap, so an exact-lap match would miss most real stops.
            // Report each (driver, pittedLap) pair exactly once, the first time we see
            // it on or shortly after the lap it happened.
            var reportKey = dn + ":" + pittedLap;
            if (pittedLap <= currentLap && currentLap - pittedLap <= 3 && !reportedPitStops[reportKey]) {
                reportedPitStops[reportKey] = true;
                var pittedDriverInfo = driverListLines[dn];
                var pittedStintData = timingAppLines && timingAppLines[dn] ? timingAppLines[dn].Stints : null;
                var compoundOut = "---";
                var compoundIn = "---";
                var tyreAgeAtPit = 0;

                if (pittedStintData && pittedStintData.length >= 2) {
                    var prevStint = pittedStintData[pittedStintData.length - 2];
                    var newStint = pittedStintData[pittedStintData.length - 1];
                    compoundOut = prevStint.Compound || "---";
                    compoundIn = newStint.Compound || "---";
                    tyreAgeAtPit = prevStint.TotalLaps || 0;
                } else if (pittedStintData && pittedStintData.length === 1) {
                    compoundIn = pittedStintData[0].Compound || "---";
                    tyreAgeAtPit = pittedStintData[0].TotalLaps || 0;
                }

                var pitDuration = null;
                if (pitLaneTimes && pitLaneTimes.PitTimes && pitLaneTimes.PitTimes[dn]) {
                    pitDuration = pitLaneTimes.PitTimes[dn].Duration || null;
                }

                entry.pitStopsThisLap.push({
                    driverNum: dn,
                    tla: pittedDriverInfo ? pittedDriverInfo.Tla : dn,
                    compoundOut: compoundOut,
                    compoundIn: compoundIn,
                    tyreAge: tyreAgeAtPit,
                    pitDuration: pitDuration,
                });
            }
        }
    }

    entry.crashesThisLap = [];
    if (entry.drivers) {
        for (var crashDn in entry.drivers) {
            if (entry.drivers[crashDn].crashed) {
                entry.crashesThisLap.push({
                    driverNum: crashDn,
                    tla: entry.drivers[crashDn].tla,
                });
            }
        }
    }

    entry._np = newPositions;
    return entry;
}

function logLap(data) {
    var currentLap = data.currentLap;
    if (!currentLap || currentLap <= 0) return;
    if (currentLap <= lastLoggedLap) return;
    if (!logFilePath) initLogFile();

    try {
        var entry = buildEntry(data);
        var newPositions = entry._np;
        delete entry._np;
        var line = JSON.stringify(entry);
        fs.appendFileSync(logFilePath, line + "\n");
        if (debug) console.log("[strategy-log] LAP " + currentLap + ":", line);
        lastLoggedLap = currentLap;
        lastDriverPositions = newPositions || {};
    } catch (err) {
        console.error("[strategy-log] error:", err);
    }
}

module.exports = { logLap };
