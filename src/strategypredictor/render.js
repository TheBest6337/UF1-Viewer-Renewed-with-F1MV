const debug = false;

const { state } = require("./state");
const { getDriverConfig, getCompoundLife } = require("./config");
const { getColorFromStatusCodeOrName } = require("../functions/colors.js");
const { calcSectorHealth, classifyPattern } = require("./degradation");
const { detectBattles } = require("./battles");
const { calcTeamDeg, calcCompoundRefDeg } = require("./aggregation");
const { handleSCVSC } = require("./safetycar");

function renderNormal(driverListLines, timingDataLines, timingAppLines, currentLap, totalLaps, scResult, extrapolatedClock) {
    const tbody = document.getElementById("table-body");
    tbody.innerHTML = "";

    const sortedDrivers = [];

    for (const driverNum in driverListLines) {
        const driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        const window = state.predictedWindows[driverNum];
        const urgency = window ? window.urgency : 0;

        sortedDrivers.push({
            num: driverNum,
            urgency: urgency,
            minLap: window ? window.minLap : 999,
        });
    }

    sortedDrivers.sort(function (a, b) {
        if (b.urgency !== a.urgency) return b.urgency - a.urgency;
        return a.minLap - b.minLap;
    });

    const showDrivers = getDriverConfig("showDrivers", "All");
    var maxDrivers = sortedDrivers.length;
    if (showDrivers === "Top5") maxDrivers = 5;
    else if (showDrivers === "Top10") maxDrivers = 10;

    const teamDegData = calcTeamDeg(driverListLines);
    const compoundRefDeg = calcCompoundRefDeg(state.degRates, state.compoundCounts);

    var displayedCount = 0;
    for (const entry of sortedDrivers) {
        if (displayedCount >= maxDrivers) break;
        displayedCount++;

        const driverNum = entry.num;
        const driverInfo = driverListLines[driverNum];
        const driverTiming = timingDataLines[driverNum];
        const stintData = timingAppLines ? (timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null) : null;
        const windowEntry = state.predictedWindows[driverNum];
        const degRate = (state.driverHistory[driverNum] && state.driverHistory[driverNum].degRate) || null;
        const health = calcSectorHealth(driverNum, timingDataLines, currentLap);
        const pattern = classifyPattern(driverNum);
        const battleResult = detectBattles(driverNum, timingDataLines, currentLap);

        const tla = driverInfo.Tla;
        const teamName = driverInfo.TeamName;
        const teamColour = driverInfo.TeamColour;
        const position = parseInt(driverTiming.Position);

        var urgencyClass = "";
        if (windowEntry) {
            if (windowEntry.urgency === 2) urgencyClass = "urgency-2";
            else if (windowEntry.urgency === 1) urgencyClass = "urgency-1";
        }

        const compound = stintData && stintData.length > 0 ? stintData[stintData.length - 1].Compound : "---";
        const shortCompound = compound ? compound.charAt(0) : "-";
        const compoundColor = getColorFromStatusCodeOrName(compound.charAt(0)) || "#5b5b5d";

        const stintAge = windowEntry ? windowEntry.stintAge : 0;
        const compLife = windowEntry ? windowEntry.compoundLife : 16;
        const agePercent = Math.min(100, Math.max(0, (stintAge / compLife) * 100));

        var windowText = "--";
        var statusText = "";
        var statusClass = "";

        if (windowEntry) {
            const minL = windowEntry.minLap;
            const maxL = windowEntry.maxLap;
            windowText = "Lap " + minL + "-" + maxL;

            if (windowEntry.justPitted) {
                statusText = "JUST PITTED";
                statusClass = "ok";
            } else if (windowEntry.urgency === 2) {
                statusText = "PIT NOW";
                statusClass = "urgent";
                if (windowEntry.tireAgeRatio > 0.85) statusText += " (old tires)";
            } else if (windowEntry.urgency === 1) {
                const untilLap = windowEntry.minLap - currentLap;
                statusText = "Imminent (" + untilLap + " lap" + (untilLap !== 1 ? "s" : "") + ")";
                statusClass = "imminent";
                if (windowEntry.tireAgeRatio > 0.85) statusText += " (old tires)";
            } else if (windowEntry.extended) {
                statusText = "EXTENDED";
                statusClass = "extended";
            } else {
                const lapsLeft = windowEntry.minLap - currentLap;
                var okLabel = "OK (" + Math.max(0, lapsLeft) + " laps)";
                if (windowEntry.tireAgeRatio < 0.30) okLabel = "FRESH (" + Math.max(0, lapsLeft) + " laps)";
                statusText = okLabel;
                statusClass = "ok";
            }
        } else {
            statusText = "NO DATA";
        }

        var patternIcon = "\u2192";
        var patternTitle = "consistent";
        if (pattern === "up") { patternIcon = "\u2191"; patternTitle = "warming"; }
        else if (pattern === "down") { patternIcon = "\u2193"; patternTitle = "pushing"; }

        var battleModifier = "";
        if (battleResult.fighting && pattern === "down") battleModifier = "\u2694";
        else if (battleResult.pushing && pattern === "down") battleModifier = "\u21C8";
        else if (battleResult.dirtyAir && pattern === "flat") battleModifier = "\u2550";
        else if (battleResult.fighting && pattern !== "down") battleModifier = "\u2694";

        if (battleModifier) patternIcon += battleModifier;

        const teamHex = teamColour ? "#" + teamColour : "#5b5b5d";

        const posDisplay = isNaN(position) ? "--" : "P" + position;

        const mainRow = document.createElement("tr");
        mainRow.className = urgencyClass;
        mainRow.innerHTML =
            '<td class="pos-cell">' + posDisplay + '</td>' +
            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + tla + '</span></td>' +
            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span><span style="font-size:11px;color:rgba(255,255,255,0.4)">' + '\u25CF'.repeat(Math.min(5, Math.ceil(agePercent / 20))) + '</span><span style="font-size:11px;color:rgba(255,255,255,0.2)">' + ('\u25CF'.repeat(Math.max(0, 5 - Math.min(5, Math.ceil(agePercent / 20))))) + '</span></td>' +
            '<td class="pit-window-cell"><span class="window-range">' + windowText + '</span></td>' +
            '<td class="status-cell"><span class="' + statusClass + '">' + patternIcon + ' ' + statusText + '</span></td>';
        tbody.appendChild(mainRow);

        const detailRow = document.createElement("tr");
        detailRow.className = "detail-row";
        var detailHtml = "";

        if (getDriverConfig("showSectorHealth", true) && health) {
            var healthBarColor = "#4caf50";
            if (health.score > 8) healthBarColor = "#9c27b0";
            else if (health.score >= 3) healthBarColor = "#4caf50";
            else if (health.score >= -3) healthBarColor = "#fdd835";
            else healthBarColor = "#f44336";

            const healthPct = Math.min(100, Math.max(0, ((health.score + 10) / 20) * 100));
            detailHtml += 'Sectors Health ' + health.score.toFixed(0) + ' <span class="health-bar"><span class="health-bar-fill" style="width:' + healthPct + '%;background:' + healthBarColor + '"></span></span>';
        }

        if (getDriverConfig("showDegRates", true) && degRate !== null) {
            var displayDeg = degRate;
            var cappedNote = "";
            if (windowEntry && windowEntry.adjustedDeg !== null && windowEntry.adjustedDeg !== undefined &&
                windowEntry.originalDeg !== null && windowEntry.originalDeg !== undefined &&
                Math.abs(windowEntry.adjustedDeg - windowEntry.originalDeg) > 0.001) {
                displayDeg = windowEntry.adjustedDeg;
                cappedNote = " (capped from " + (degRate >= 0 ? "+" : "") + degRate.toFixed(2) + ")";
            }
            var degStr = (displayDeg >= 0 ? "+" : "") + displayDeg.toFixed(2);
            const compoundKey = shortCompound;
            if (compoundRefDeg[compoundKey] && compoundRefDeg[compoundKey].count > 0) {
                const diff = displayDeg - compoundRefDeg[compoundKey].avg;
                const diffStr = (diff >= 0 ? "+" : "") + diff.toFixed(2);
                degStr += " (" + diffStr + " vs avg " + compoundKey + ")";
            }
            degStr += cappedNote;
            detailHtml += '  |  deg ' + degStr;
        }

        if (battleResult.penalty > 0 && getDriverConfig("battleDegEnabled", true)) {
            detailHtml += '  |  <span style="color:#f44336">battle +' + battleResult.penalty.toFixed(2) + '/lap</span>';
        }

        if (detailHtml.length > 0) {
            detailRow.innerHTML = '<td colspan="5">' + detailHtml + '</td>';
            tbody.appendChild(detailRow);
        }

        if (getDriverConfig("showUndercut", true)) {
            for (const threat of state.undercutThreats) {
                if (threat.behind === driverNum) {
                    const threatRow = document.createElement("tr");
                    threatRow.className = "detail-row";
                    var threatText = "";
                    if (threat.type === "undercut") {
                        threatText = "\u21B3 " + threat.gap.toFixed(1) + "s behind #" +
                            (driverListLines[threat.ahead] ? driverListLines[threat.ahead].Tla : threat.ahead) +
                            " \u2014 Undercut possible (+" + threat.netGain.toFixed(1) + "s net)";
                    } else if (threat.type === "overcut") {
                        threatText = "\u21B3 " + threat.gap.toFixed(1) + "s behind #" +
                            (driverListLines[threat.ahead] ? driverListLines[threat.ahead].Tla : threat.ahead) +
                            " \u2014 Overcut risk (-" + threat.paceLoss.toFixed(1) + "s staying out)";
                    }
                    threatRow.innerHTML = '<td colspan="5" style="color:#fdd835">' + threatText + '</td>';
                    tbody.appendChild(threatRow);
                }
            }
        }

        if (getDriverConfig("showTeamDeg", true) && teamDegData[teamName]) {
            const teamData = teamDegData[teamName];
            const teammateNum = teamData.drivers.find(function (d) { return d !== driverNum; });
            if (teammateNum && state.predictedWindows[teammateNum]) {
                const teammateDeg = (state.driverHistory[teammateNum] && state.driverHistory[teammateNum].degRate) || null;
                if (teammateDeg !== null) {
                    const teamRow = document.createElement("tr");
                    teamRow.className = "detail-row";
                    var teamText = 'Team: ' + (driverListLines[teammateNum] ? driverListLines[teammateNum].Tla : teammateNum) +
                        ' [' + (state.predictedWindows[teammateNum] ? state.predictedWindows[teammateNum].compound.charAt(0) : '-') +
                        '] deg ' + (teammateDeg >= 0 ? "+" : "") + teammateDeg.toFixed(2);
                    if (degRate !== null && Math.abs(degRate - teammateDeg) > 0.10) {
                        teamText += ' \u2192 deg differs';
                    } else {
                        teamText += ' \u2192 on pace';
                    }
                    teamRow.innerHTML = '<td colspan="5" class="team-label">' + teamText + '</td>';
                    tbody.appendChild(teamRow);
                }
            }
        }
    }

}

function renderSCVSC(driverListLines, timingDataLines, timingAppLines, currentLap, scResult) {
    const tbody = document.getElementById("table-body");
    tbody.innerHTML = "";

    document.getElementById("sc-banner").classList.remove("hidden");
    document.getElementById("sc-banner").textContent = scResult.message;

    if (scResult.mode === "vsc_ending") {
        if (!document.getElementById("vsc-ending-banner")) {
            const banner = document.createElement("div");
            banner.id = "vsc-ending-banner";
            banner.style.cssText = "padding:4px 12px;font-size:11px;text-align:center;color:#f44336;background:rgba(244,67,54,0.1);";
            banner.textContent = "WINDOW CLOSING — Pit now or commit to staying out";
            document.getElementById("sc-banner").after(banner);
        }
    }

    if (scResult.mode !== "sc" && scResult.mode !== "vsc") return;

    const expiryRows = [];
    for (const driverNum in driverListLines) {
        const driverTiming = timingDataLines[driverNum];
        if (!driverTiming || driverTiming.Retired || driverTiming.Stopped) continue;

        const stintData = timingAppLines ? (timingAppLines[driverNum] ? timingAppLines[driverNum].Stints : null) : null;
        if (!stintData || stintData.length === 0) continue;

        const currentStint = stintData[stintData.length - 1];
        const compound = currentStint.Compound || "SOFT";
        const compoundLife = getCompoundLife(compound);
        const stintAge = currentStint.TotalLaps != null ? currentStint.TotalLaps : 0;
        const tireUsage = compoundLife > 0 ? stintAge / compoundLife : 0;

        var expectedLabel = "";
        var expectedClass = "";

        if (stintAge <= 4) {
            expectedLabel = "FRESH (just pitted)";
            expectedClass = "#4caf50";
        } else if (tireUsage > 0.85) {
            expectedLabel = "EXPECTED TO PIT";
            expectedClass = "#f44336";
        } else if (tireUsage > 0.60) {
            expectedLabel = "LIKELY TO PIT";
            expectedClass = "#fdd835";
        } else {
            expectedLabel = "COULD PIT (strategic)";
            expectedClass = "#ffffff";
        }

        if (stintAge > compoundLife) {
            expectedLabel = "EXPECTED (overdue!)";
            expectedClass = "#f44336";
        }

        expiryRows.push({
            num: driverNum,
            stintAge: stintAge,
            compoundLife: compoundLife,
            tireUsage: tireUsage,
            label: expectedLabel,
            color: expectedClass,
            compound: compound,
        });
    }

    expiryRows.sort(function (a, b) { return b.tireUsage - a.tireUsage; });

    for (const row of expiryRows) {
        const driverInfo = driverListLines[row.num];
        const driverTiming = timingDataLines[row.num];
        const tla = driverInfo.Tla;
        const teamHex = driverInfo.TeamColour ? "#" + driverInfo.TeamColour : "#5b5b5d";
        const position = parseInt(driverTiming.Position);
        const posDisplay = isNaN(position) ? "--" : "P" + position;
        const compound = row.compound;
        const shortCompound = compound.charAt(0);
        const compoundColor = getColorFromStatusCodeOrName(compound.charAt(0)) || "#5b5b5d";
        const agePercent = Math.min(100, Math.max(0, (row.stintAge / row.compoundLife) * 100));

        const tr = document.createElement("tr");
        tr.className = "sc-row";
        tr.innerHTML =
            '<td class="pos-cell">' + posDisplay + '</td>' +
            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + tla + '</span></td>' +
            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span><span style="font-size:11px;color:rgba(255,255,255,0.4)"> Age ' + row.stintAge + '/' + row.compoundLife + '</span></td>' +
            '<td class="pit-window-cell"><span class="age-bar"><span class="age-bar-fill" style="width:' + agePercent + '%;background:' + row.color + '"></span></span></td>' +
            '<td class="status-cell"><span style="color:' + row.color + '">' + row.label + '</span></td>';
        tbody.appendChild(tr);
    }
}

function render(driverListLines, timingDataLines, timingAppLines, currentLap, totalLaps, trackStatus, extrapolatedClock, weatherData) {
    if (!driverListLines) return;

    document.getElementById("lap-counter").textContent = "Lap " + currentLap + "/" + totalLaps;
    document.getElementById("pit-loss").textContent = (!isNaN(state.avgPitLoss) && state.avgPitLoss > 0)
        ? "Pit Loss: " + state.avgPitLoss.toFixed(1) + "s (SC: ~" + (state.avgPitLoss * 0.55).toFixed(1) + "s)"
        : "Pit Loss: calculating...";
    document.getElementById("race-end").textContent = "Race End: ~Lap " + totalLaps;

    const compoundRefDeg = calcCompoundRefDeg(state.degRates, state.compoundCounts);
    var degBarHtml = "Deg: ";
    for (const compound in compoundRefDeg) {
        const data = compoundRefDeg[compound];
        degBarHtml += "[" + compound + "]=" + (data.avg >= 0 ? "+" : "") + data.avg.toFixed(2) + "(" + data.count + ") ";
    }
    document.getElementById("deg-bar").textContent = degBarHtml;

    var trackFlagText = "SC/VSC: NONE";
    if (trackStatus === "4") trackFlagText = "SC DEPLOYED";
    else if (trackStatus === "6") trackFlagText = "VSC DEPLOYED";
    else if (trackStatus === "7") trackFlagText = "VSC ENDING";
    document.getElementById("track-flag").textContent = trackFlagText;

    var rainText = "";
    if (state.rainTransitionMessage) {
        rainText = state.rainTransitionMessage;
    }
    document.getElementById("rain-flag").textContent = rainText;

    const scResult = handleSCVSC(trackStatus);
    document.getElementById("sc-banner").classList.add("hidden");

    const vscBanner = document.getElementById("vsc-ending-banner");
    if (vscBanner) vscBanner.remove();

    if (scResult.mode === "sc" || scResult.mode === "vsc") {
        document.getElementById("main-table").querySelector("thead").style.display = "none";
        renderSCVSC(driverListLines, timingDataLines, timingAppLines, currentLap, scResult);
    } else {
        if (scResult.mode === "vsc_ending") {
            document.getElementById("sc-banner").classList.remove("hidden");
            document.getElementById("sc-banner").textContent = scResult.message;
        }
        document.getElementById("main-table").querySelector("thead").style.display = "";
        renderNormal(driverListLines, timingDataLines, timingAppLines, currentLap, totalLaps, scResult, extrapolatedClock);
    }
}

module.exports = { render };
