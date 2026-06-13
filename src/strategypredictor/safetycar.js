const debug = false;

const { state } = require("./state");

function handleSCVSC(trackStatus) {
    const statusNum = trackStatus ? parseInt(trackStatus) : 1;
    var mode = "normal";
    var message = "";

    const validPitLoss = !isNaN(state.avgPitLoss) && state.avgPitLoss > 0;
    switch (statusNum) {
        case 4:
            mode = "sc";
            message = validPitLoss
                ? "SAFETY CAR DEPLOYED — Pit loss ~" + (state.avgPitLoss * 0.55).toFixed(1) + "s (save ~" + (state.avgPitLoss - state.avgPitLoss * 0.55).toFixed(1) + "s)"
                : "SAFETY CAR DEPLOYED — Pit loss: calculating...";
            break;
        case 6:
            mode = "vsc";
            message = validPitLoss
                ? "VIRTUAL SAFETY CAR DEPLOYED — Pit loss ~" + (state.avgPitLoss * 0.55).toFixed(1) + "s (save ~" + (state.avgPitLoss - state.avgPitLoss * 0.55).toFixed(1) + "s)"
                : "VIRTUAL SAFETY CAR DEPLOYED — Pit loss: calculating...";
            break;
        case 7:
            mode = "vsc_ending";
            message = "VSC ENDING — Pit window closing";
            break;
        default:
            mode = "normal";
            message = "";
    }

    return { mode: mode, message: message };
}

module.exports = { handleSCVSC };
