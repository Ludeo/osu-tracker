// Entry point: the app, or the in-game overlay, which the app starts as a process of its own
// (see overlay.js).
const path = require('node:path');
const { app } = require('electron');
const { OVERLAY_FLAG } = require('./overlay');

// Packaged builds are named after productName ("osu!mania Tracker"), which would move the settings
// folder; keep it at ~/.config/osu-mania-tracker so dev and packaged runs share one config.
app.setPath('userData', path.join(app.getPath('appData'), 'osu-mania-tracker'));

require(process.argv.includes(OVERLAY_FLAG) ? './overlayProcess' : './main');
