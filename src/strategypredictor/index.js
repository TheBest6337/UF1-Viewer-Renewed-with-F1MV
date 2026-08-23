const debug = false;

const loopspeed = 2000;

const { logLap } = require("./strategy-log.js");
const { state } = require("./state");
const { config, getConfigurations, getDriverConfig, getCompoundLife } = require("./config");
const { getPriorPitLoss } = require("./priors");
const { apiRequests } = require("./api");
const { computeAll, detectPitStops } = require("./compute");
const { render } = require("./render");
const { getColorFromStatusCodeOrName } = require("../functions/colors.js");

async function run() {
    await getConfigurations();

    setInterval(async function () {
        try {
            const liveState = await apiRequests();
            if (!liveState) {
                if (debug) console.log("no state returned");
                return;
            }

            const driverListLines = liveState.DriverList || null;
            const timingDataLines = liveState.TimingData ? liveState.TimingData.Lines : null;
            const timingAppLines = liveState.TimingAppData ? liveState.TimingAppData.Lines : null;
            const timingStatsLines = liveState.TimingStats ? liveState.TimingStats.Lines : null;
            const lapCount = liveState.LapCount;
            const sessionInfo = liveState.SessionInfo;
            const trackStatus = liveState.TrackStatus ? liveState.TrackStatus.Status : "1";
            const extrapolatedClock = liveState.ExtrapolatedClock;
            const weatherData = liveState.WeatherData;
            const pitLaneTimes = liveState.PitLaneTimeCollection;
            const carData = liveState.CarData || null;
            const sessionStatus = liveState.SessionStatus ? liveState.SessionStatus.Status : null;
            const rcmRaw = liveState.RaceControlMessages ? liveState.RaceControlMessages.Messages : null;

            // Race control: track pit entry open/closed so the predictor never tells
            // anyone to pit into a closed pit lane. Messages accumulate over the
            // session; only parse the new ones.
            const rcmList = Array.isArray(rcmRaw) ? rcmRaw : rcmRaw ? Object.values(rcmRaw) : null;
            if (rcmList && rcmList.length > state.rcmProcessedCount) {
                for (let m = state.rcmProcessedCount; m < rcmList.length; m++) {
                    const msg = rcmList[m];
                    if (!msg) continue;
                    const sub = msg.SubCategory || msg.Category;
                    if (sub === "PitEntry") {
                        state.pitLaneClosed = msg.Flag === "CLOSED";
                    }
                }
                state.rcmProcessedCount = rcmList.length;
            }

            if (lapCount) {
                const wasSCVSC = state.lastTrackStatus === "4" || state.lastTrackStatus === "6";
                const nowGreen = !trackStatus || trackStatus === "1" || trackStatus === "2" || trackStatus === "7";
                if (wasSCVSC && nowGreen) {
                    state.lastSCExitLap = parseInt(lapCount.CurrentLap);
                    for (var _d in state.driverHistory) {
                        if (state.driverHistory[_d]) state.driverHistory[_d].laps = [];
                    }
                }
                state.lastTrackStatus = trackStatus || "1";
            }

            if (sessionInfo) {
                state.sessionType = sessionInfo.Type;
                const circuit = sessionInfo.Meeting && sessionInfo.Meeting.Circuit ? sessionInfo.Meeting.Circuit.ShortName : null;
                if (circuit && state.circuitKey !== circuit) {
                    state.circuitKey = circuit;
                    // Seed pit loss from this circuit's historical median lane time;
                    // live PitLaneTimeCollection observations blend over it below.
                    const priorLoss = getPriorPitLoss();
                    if (priorLoss) {
                        state.priorPitLoss = priorLoss;
                        state.avgPitLoss = priorLoss;
                    }
                    if (debug) console.log("circuit:", circuit, "prior pit loss:", priorLoss);
                }
            }

            if (state.sessionType && state.sessionType !== "Race") {
                document.getElementById("main-table").querySelector("thead").style.display = "none";
                document.getElementById("table-body").innerHTML = "";
                document.getElementById("no-race").classList.remove("hidden");
                document.getElementById("gathering").classList.add("hidden");
                document.getElementById("sc-banner").classList.add("hidden");
                const vscBanner = document.getElementById("vsc-ending-banner");
                if (vscBanner) vscBanner.remove();
                return;
            }

            document.getElementById("no-race").classList.add("hidden");

            const currentLap = lapCount ? parseInt(lapCount.CurrentLap) : 0;
            const totalLaps = lapCount ? parseInt(lapCount.TotalLaps) : 0;

            const minLapsForPrediction = getDriverConfig("minLapsForPrediction", 5);

            if (currentLap < minLapsForPrediction) {
                document.getElementById("gathering").classList.remove("hidden");
                document.getElementById("gathering-laps").textContent = "(need " + (minLapsForPrediction - currentLap) + " more laps)";
                document.getElementById("main-table").querySelector("thead").style.display = "";
                document.getElementById("table-body").innerHTML = "";
                if (driverListLines && timingDataLines) {
                    const tbody = document.getElementById("table-body");
                    for (const driverNum in driverListLines) {
                        const driverTiming = timingDataLines[driverNum];
                        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;
                        const driverInfo = driverListLines[driverNum];
                        const stintData = timingAppLines ? (timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null) : null;
                        const compound = stintData && stintData.length > 0 ? stintData[stintData.length - 1].Compound : "---";
                        const shortCompound = compound ? compound.charAt(0) : "-";
                        const compoundColor = getColorFromStatusCodeOrName(compound.charAt(0)) || "#5b5b5d";
                        const teamHex = driverInfo.TeamColour ? "#" + driverInfo.TeamColour : "#5b5b5d";
                        const position = parseInt(driverTiming.Position);
                        const compoundLife = getCompoundLife(compound);
                        const stintAge = (stintData && stintData.length > 0) ? (stintData[stintData.length - 1].TotalLaps || 0) : 0;
                        const stintStartLap = currentLap - stintAge;
                        const expectedRange = "Lap " + (stintStartLap + compoundLife - 3) + "-" + (stintStartLap + compoundLife + 3);

                        const tr = document.createElement("tr");
                        tr.innerHTML =
                            '<td class="pos-cell">' + (isNaN(position) ? "--" : "P" + position) + '</td>' +
                            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + driverInfo.Tla + '</span></td>' +
                            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span></td>' +
                            '<td class="pit-window-cell"><span class="window-range" style="color:rgba(255,255,255,0.4)">' + expectedRange + '</span></td>' +
                            '<td class="status-cell"><span style="color:rgba(255,255,255,0.3)">BASELINE</span></td>';
                        tbody.appendChild(tr);
                    }
                }
                document.getElementById("lap-counter").textContent = "Lap " + currentLap + "/" + totalLaps;

                logLap({
                    currentLap: currentLap,
                    totalLaps: totalLaps,
                    trackStatus: trackStatus,
                    avgPitLoss: state.avgPitLoss,
                    weatherData: weatherData || { Rainfall: 0 },
                    driverListLines: driverListLines,
                    timingDataLines: timingDataLines,
                    timingAppLines: timingAppLines,
                    predictedWindows: state.predictedWindows,
                    driverHistory: state.driverHistory,
                    justPittedDrivers: state.justPittedDrivers,
                    degRates: state.degRates,
                    compoundCounts: state.compoundCounts,
                    configData: config.configData,
                    carData: carData,
                    sessionStatus: sessionStatus,
                    sessionType: state.sessionType,
                    lapCount: lapCount,
                });

                return;
            }

            document.getElementById("gathering").classList.add("hidden");

            if (weatherData) {
                const currentRainfall = weatherData.Rainfall || 0;
                if (state.prevRainfall === 0 && currentRainfall > 0) {
                    state.rainTransitionMessage = "\u2601 RAIN STARTING \u2014 Intermediates expected. Pit window shifting.";
                    state.rainTransitionTimer = 10;
                } else if (state.prevRainfall > 0 && currentRainfall === 0) {
                    state.rainTransitionMessage = "\u2600 DRY LINE EMERGING \u2014 Slicks becoming viable. Monitor sector times.";
                    state.rainTransitionTimer = 10;
                }
                state.prevRainfall = state.lastRainfall;
                state.lastRainfall = currentRainfall;
                if (state.rainTransitionTimer > 0) state.rainTransitionTimer--;
                else state.rainTransitionMessage = "";
            }

            if (pitLaneTimes && pitLaneTimes.PitTimes) {
                const pitTimesArray = Object.values(pitLaneTimes.PitTimes);
                const validTimes = pitTimesArray.filter(function (pt) {
                    var d = Number(pt.Duration);
                    return !isNaN(d) && d > 0;
                });
                if (validTimes.length > 0) {
                    // Blend the historical prior (weight of 4 observations) with what the
                    // pit lane is actually doing today; live data dominates as stops accrue.
                    const liveMean = validTimes.reduce(function (s, pt) { return s + Number(pt.Duration); }, 0) / validTimes.length;
                    const prior = state.priorPitLoss;
                    state.avgPitLoss = prior != null
                        ? (4 * prior + validTimes.length * liveMean) / (4 + validTimes.length)
                        : liveMean;
                }

                detectPitStops(pitLaneTimes.PitTimes, timingAppLines, currentLap);
            }

            computeAll(
                driverListLines,
                timingDataLines,
                timingAppLines,
                timingStatsLines,
                currentLap,
                totalLaps,
                extrapolatedClock,
                trackStatus
            );

            render(
                driverListLines,
                timingDataLines,
                timingAppLines,
                currentLap,
                totalLaps,
                trackStatus,
                extrapolatedClock,
                weatherData
            );

            logLap({
                currentLap: currentLap,
                totalLaps: totalLaps,
                trackStatus: trackStatus,
                avgPitLoss: state.avgPitLoss,
                weatherData: weatherData || { Rainfall: 0 },
                driverListLines: driverListLines,
                timingDataLines: timingDataLines,
                timingAppLines: timingAppLines,
                predictedWindows: state.predictedWindows,
                driverHistory: state.driverHistory,
                justPittedDrivers: state.justPittedDrivers,
                degRates: state.degRates,
                compoundCounts: state.compoundCounts,
                configData: config.configData,
                pitLaneTimes: pitLaneTimes,
                carData: carData,
                sessionStatus: sessionStatus,
                sessionType: state.sessionType,
                lapCount: lapCount,
            });

            if (debug) {
                console.log("session:", state.sessionType);
                console.log("lap:", currentLap + "/" + totalLaps);
                console.log("track status:", state.lastTrackStatus);
                console.log("predicted windows:", Object.keys(state.predictedWindows).length);
                console.log("undercut threats:", state.undercutThreats.length);
                for (const driverNum in state.predictedWindows) {
                    const w = state.predictedWindows[driverNum];
                    const d = (state.driverHistory[driverNum] && state.driverHistory[driverNum].degRate) || null;
                    console.log("  driver " + driverNum + ": window L" + w.minLap + "-" + w.maxLap + " urgency=" + w.urgency + " deg=" + (d ? d.toFixed(3) : "null"));
                }
            }

        } catch (error) {
            if (debug) console.log("loop error:", error);
        }
    }, loopspeed);
}

run();
