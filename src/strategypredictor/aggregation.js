const debug = false;

const { state } = require("./state");

function calcTeamDeg(driverListLines) {
    if (!driverListLines) return {};

    const teamDrivers = {};
    for (const driverNum in driverListLines) {
        const driver = driverListLines[driverNum];
        const teamName = driver.TeamName;
        if (!teamDrivers[teamName]) teamDrivers[teamName] = [];
        teamDrivers[teamName].push(driverNum);
    }

    const teamResults = {};
    for (const teamName in teamDrivers) {
        const drivers = teamDrivers[teamName];
        if (drivers.length < 2) continue;

        const teamDegRates = drivers.map(function (d) {
            return state.predictedWindows[d] ? (state.driverHistory[d] ? state.driverHistory[d].degRate : null) : null;
        });

        const validRates = teamDegRates.filter(function (r) { return r !== null && r !== undefined; });
        if (validRates.length === 0) continue;

        const teamAvgDeg = validRates.reduce(function (s, r) { return s + r; }, 0) / validRates.length;

        var flaggedPair = null;
        if (validRates.length === 2 && Math.abs(validRates[0] - validRates[1]) > 0.10) {
            flaggedPair = {
                driver1: drivers[0],
                driver2: drivers[1],
                rate1: validRates[0],
                rate2: validRates[1],
            };
        }

        teamResults[teamName] = {
            avgDeg: teamAvgDeg,
            drivers: drivers,
            flaggedPair: flaggedPair,
        };
    }

    return teamResults;
}

function calcCompoundRefDeg(currentDegRates, currentCounts) {
    const compoundDegAvg = {};
    for (const compound in currentCounts) {
        if (currentDegRates[compound] !== undefined) {
            compoundDegAvg[compound] = {
                avg: currentCounts[compound] > 0 ? currentDegRates[compound] / currentCounts[compound] : 0,
                count: currentCounts[compound],
            };
        }
    }
    return compoundDegAvg;
}

module.exports = { calcTeamDeg, calcCompoundRefDeg };
