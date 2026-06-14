const debug = false;

const { state } = require("./state");
const { getDriverConfig, getCompoundLife } = require("./config");
const { getColorFromStatusCodeOrName } = require("../functions/colors.js");
const { calcSectorHealth, classifyPattern } = require("./degradation");
const { detectBattles } = require("./battles");
const { calcTeamDeg, calcCompoundRefDeg } = require("./aggregation");
const { handleSCVSC } = require("./safetycar");

function buildUndercutCard(threat, driverListLines) {
    const histKey = threat.behind + "_" + threat.ahead;
    const history = state.undercutHistory[histKey] || [];

    const behindInfo = driverListLines[threat.behind];
    const aheadInfo  = driverListLines[threat.ahead];
    const behindTla  = behindInfo ? behindInfo.Tla : threat.behind;
    const aheadTla   = aheadInfo  ? aheadInfo.Tla  : threat.ahead;
    const behindColor = behindInfo && behindInfo.TeamColour ? "#" + behindInfo.TeamColour : "#fdd835";
    const aheadColor  = aheadInfo  && aheadInfo.TeamColour  ? "#" + aheadInfo.TeamColour  : "#ffffff";

    const currentGap = threat.gap;
    const prevGap    = history.length >= 2 ? history[history.length - 2] : null;
    const delta      = prevGap !== null ? currentGap - prevGap : 0;

    var statusLabel, statusClass;
    if (currentGap <= 0) {
        statusLabel = "EMERGED AHEAD";
        statusClass = "uc-status uc-status--ahead";
    } else if (currentGap < 2.0) {
        statusLabel = "VERY CLOSE";
        statusClass = "uc-status uc-status--close";
    } else if (delta < -0.05) {
        statusLabel = "CLOSING";
        statusClass = "uc-status uc-status--closing";
    } else if (delta > 0.05) {
        statusLabel = "FALLING BACK";
        statusClass = "uc-status uc-status--falling";
    } else {
        statusLabel = "CLOSING";
        statusClass = "uc-status uc-status--closing";
    }

    var deltaHtml = "";
    if (prevGap !== null) {
        if (delta < -0.05)     deltaHtml = '<span class="uc-delta uc-delta--closing">↓' + Math.abs(delta).toFixed(1) + 's</span>';
        else if (delta > 0.05) deltaHtml = '<span class="uc-delta uc-delta--falling">↑' + delta.toFixed(1) + 's</span>';
        else                   deltaHtml = '<span class="uc-delta uc-delta--stable">→</span>';
    }

    const METER_MAX = 8.0;
    const clampedGap = Math.min(Math.max(currentGap, 0), METER_MAX);
    const markerPct  = (clampedGap / METER_MAX * 100).toFixed(1);
    const meterHtml =
        '<div class="uc-position-meter">' +
            '<div class="uc-meter-track">' +
                '<div class="uc-meter-zone-close"></div>' +
                '<div class="uc-meter-marker" style="left:' + markerPct + '%"></div>' +
            '</div>' +
            '<div class="uc-meter-labels"><span>0s</span><span>8s+</span></div>' +
        '</div>';

    const sparkReadings = history.slice(-5);
    var sparkHtml = '<div class="uc-gap-spark">';
    for (var si = 0; si < sparkReadings.length; si++) {
        const g = sparkReadings[si];
        var dotClass = "uc-spark-dot";
        if (g < 2.0)      dotClass += " uc-spark-dot--close";
        else if (g < 4.0) dotClass += " uc-spark-dot--mid";
        else              dotClass += " uc-spark-dot--far";
        sparkHtml += '<span class="' + dotClass + '"></span>';
    }
    sparkHtml += '</div>';

    return (
        '<div class="undercut-card">' +
            '<div class="uc-header">' +
                '<span class="uc-label">⚡ UNDERCUT IN PROGRESS</span>' +
                '<span class="uc-drivers">' +
                    '<span style="color:' + behindColor + '">' + behindTla + '</span>' +
                    '<span class="uc-vs"> vs </span>' +
                    '<span style="color:' + aheadColor + '">' + aheadTla + '</span>' +
                '</span>' +
            '</div>' +
            meterHtml +
            '<div class="uc-bottom-row">' +
                sparkHtml +
                '<span class="uc-gap-value">' + currentGap.toFixed(2) + 's</span>' +
                deltaHtml +
                '<span class="' + statusClass + '">' + statusLabel + '</span>' +
            '</div>' +
        '</div>'
    );
}

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
            position: parseInt(driverTiming.Position) || 999,
        });
    }

    sortedDrivers.sort(function (a, b) {
        return a.position - b.position;
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
        const tireBarColor = agePercent > 75 ? '#f44336' : agePercent > 45 ? '#fdd835' : '#4caf50';

        var windowText = "--";
        var statusText = "";
        var statusClass = "";

        if (windowEntry) {
            const minL = windowEntry.minLap;
            const maxL = windowEntry.maxLap;
            windowText = "Lap " + minL + "-" + maxL;

            if (windowEntry.noPitNeeded) {
                statusText = "FINISH ON TIRES";
                statusClass = "ok";
                windowText = "No stop needed";
            } else if (windowEntry.justPitted) {
                statusText = "JUST PITTED";
                statusClass = "ok";
            } else if (windowEntry.isRaceStart) {
                statusText = "NEW TIRES";
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

        const teamHex = teamColour ? "#" + teamColour : "#5b5b5d";

        const posDisplay = isNaN(position) ? "--" : "P" + position;

        var currentPct = totalLaps > 0 ? Math.min(100, (currentLap / totalLaps) * 100) : 0;
        var pitTimelineHtml = '<div class="pit-timeline"><div class="pit-elapsed" style="width:' + currentPct.toFixed(1) + '%"></div>';
        if (windowEntry) {
            const pitStartPct = Math.min(100, (windowEntry.minLap / totalLaps) * 100);
            const pitEndPct = Math.min(100, (windowEntry.maxLap / totalLaps) * 100);
            const pitWidthPct = Math.max(0, pitEndPct - pitStartPct);
            const windowColor = windowEntry.urgency === 2 ? '#f44336' : windowEntry.urgency === 1 ? '#fdd835' : '#4caf50';
            pitTimelineHtml += '<div class="pit-window-bar" style="left:' + pitStartPct.toFixed(1) + '%;width:' + pitWidthPct.toFixed(1) + '%;background:' + windowColor + '"></div>';
            pitTimelineHtml += '<span class="pit-lap-label" style="left:' + pitStartPct.toFixed(1) + '%">' + windowEntry.minLap + '</span>';
            pitTimelineHtml += '<span class="pit-lap-label" style="left:' + pitEndPct.toFixed(1) + '%">' + windowEntry.maxLap + '</span>';
        }
        pitTimelineHtml += '<div class="pit-tick" style="left:' + currentPct.toFixed(1) + '%"></div></div>';

        const mainRow = document.createElement("tr");
        mainRow.className = urgencyClass;
        mainRow.innerHTML =
            '<td class="pos-cell">' + posDisplay + '</td>' +
            '<td class="driver-cell"><span style="color:' + teamHex + '" class="tla">' + tla + '</span></td>' +
            '<td class="comp-cell"><span class="compound-badge" style="background:' + compoundColor + ';color:#000">' + shortCompound + '</span><span class="tire-bar"><span class="tire-bar-fill" style="width:' + agePercent.toFixed(1) + '%;background:' + tireBarColor + '"></span></span></td>' +
            '<td class="pit-window-cell"><span class="window-range">' + windowText + '</span></td>' +
            '<td class="status-cell"><span class="' + statusClass + '">' + statusText + '</span>' + pitTimelineHtml + '</td>';
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
            detailHtml += '<span style="color:rgba(255,255,255,0.45)">SH</span> <span style="color:' + healthBarColor + '">' + health.score.toFixed(0) + '</span><span class="health-bar"><span class="health-bar-fill" style="width:' + healthPct + '%;background:' + healthBarColor + '"></span></span>';
        }

        if (getDriverConfig("showDegRates", true) && degRate !== null) {
            var displayDeg = degRate;
            if (windowEntry && windowEntry.adjustedDeg !== null && windowEntry.adjustedDeg !== undefined &&
                windowEntry.originalDeg !== null && windowEntry.originalDeg !== undefined &&
                Math.abs(windowEntry.adjustedDeg - windowEntry.originalDeg) > 0.001) {
                displayDeg = windowEntry.adjustedDeg;
            }
            var degClass = 'deg-noref';
            if (compoundRefDeg[shortCompound] && compoundRefDeg[shortCompound].count > 0) {
                const diff = displayDeg - compoundRefDeg[shortCompound].avg;
                if (diff < -0.05) degClass = 'deg-good';
                else if (diff <= 0.10) degClass = 'deg-mid';
                else degClass = 'deg-bad';
            }
            const degValStr = (displayDeg >= 0 ? "+" : "") + displayDeg.toFixed(2);
            detailHtml += '  |  deg <span class="' + degClass + '">' + degValStr + '</span>';

            if (getDriverConfig("showTeamDeg", true) && teamDegData[teamName]) {
                const teammateNum = teamDegData[teamName].drivers.find(function (d) { return d !== driverNum; });
                if (teammateNum) {
                    const teammateDeg = (state.driverHistory[teammateNum] && state.driverHistory[teammateNum].degRate) || null;
                    if (teammateDeg !== null && Math.abs(degRate - teammateDeg) > 0.10) {
                        const tmTla = driverListLines[teammateNum] ? driverListLines[teammateNum].Tla : teammateNum;
                        const tmDiff = degRate - teammateDeg;
                        detailHtml += ' <span style="color:rgba(255,255,255,0.45)">vs ' + tmTla + ' ' + (tmDiff >= 0 ? '+' : '') + tmDiff.toFixed(2) + (tmDiff > 0 ? '↑' : '↓') + '</span>';
                    }
                }
            }
        }

        if (battleResult.penalty > 0 && getDriverConfig("battleDegEnabled", true)) {
            detailHtml += '  |  <span style="color:#f44336">battle +' + battleResult.penalty.toFixed(2) + '/lap</span>';
        }

        if (getDriverConfig("showUndercut", true)) {
            for (const threat of state.undercutThreats) {
                if (threat.behind === driverNum) {
                    const aheadTla = driverListLines[threat.ahead] ? driverListLines[threat.ahead].Tla : threat.ahead;
                    if (threat.type === "undercut_active") {
                        detailHtml += buildUndercutCard(threat, driverListLines);
                    } else if (threat.type === "undercut") {
                        detailHtml += '  <span class="threat-badge">⚡ UC vs ' + aheadTla + ': ' + threat.gap.toFixed(1) + 's gap (+' + threat.netGain.toFixed(1) + 's)</span>';
                    } else if (threat.type === "overcut") {
                        detailHtml += '  <span class="threat-badge oc">⚡ OC vs ' + aheadTla + ': -' + threat.paceLoss.toFixed(1) + 's</span>';
                    }
                    break;
                }
            }
        }

        if (detailHtml.length > 0) {
            detailRow.innerHTML = '<td colspan="5">' + detailHtml + '</td>';
            tbody.appendChild(detailRow);
        }

    }

    const happeningPanel = document.getElementById("happening-panel");
    const happeningDrivers = sortedDrivers.filter(function(e) { return e.urgency >= 1; });
    if (happeningDrivers.length > 0) {
        var itemsHtml = "";
        for (const entry of happeningDrivers) {
            const driverInfo = driverListLines[entry.num];
            const driverTiming2 = timingDataLines[entry.num];
            if (!driverInfo || !driverTiming2) continue;
            const tla = driverInfo.Tla;
            const teamHex = driverInfo.TeamColour ? "#" + driverInfo.TeamColour : "#5b5b5d";
            const posDisplay = isNaN(entry.position) ? "--" : "P" + entry.position;
            const stintData2 = timingAppLines ? (timingAppLines[entry.num] ? timingAppLines[entry.num].Stints : null) : null;
            const compound2 = stintData2 && stintData2.length > 0 ? stintData2[stintData2.length - 1].Compound : "?";
            const shortCompound2 = compound2 ? compound2.charAt(0) : "?";
            const compoundColor2 = getColorFromStatusCodeOrName(compound2.charAt(0)) || "#5b5b5d";
            const windowEntry2 = state.predictedWindows[entry.num];
            var hapStatus = "";
            if (entry.urgency === 2) {
                hapStatus = "PIT NOW";
            } else if (windowEntry2) {
                const untilLap = windowEntry2.minLap - currentLap;
                hapStatus = "in " + Math.max(0, untilLap) + " lap" + (untilLap !== 1 ? "s" : "");
            }
            const itemClass = entry.urgency === 2 ? "happening-item happening-urgent" : "happening-item happening-imminent";
            itemsHtml +=
                '<div class="' + itemClass + '">' +
                    '<span class="happening-pos">' + posDisplay + '</span>' +
                    '<span class="happening-tla" style="color:' + teamHex + '">' + tla + '</span>' +
                    '<span class="happening-compound" style="background:' + compoundColor2 + '">' + shortCompound2 + '</span>' +
                    '<span class="happening-status">' + hapStatus + '</span>' +
                '</div>';
        }
        happeningPanel.innerHTML =
            '<div class="happening-header"><span class="happening-pulse"></span>HAPPENING</div>' +
            '<div class="happening-items">' + itemsHtml + '</div>';
        happeningPanel.classList.remove("hidden");
    } else {
        happeningPanel.classList.add("hidden");
        happeningPanel.innerHTML = "";
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
            expectedLabel = stintData.length <= 1 ? "FRESH (new tires)" : "FRESH (just pitted)";
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
