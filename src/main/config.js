const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = Object.freeze({
  clientId: '',
  clientSecret: '',
  // Your own osu! username. If empty, the name of the player logged into the game is used.
  username: '',
  tosuUrl: 'ws://127.0.0.1:24050/websocket/v2',
  // osu!'s Songs folder, scanned for recommendations. If empty, the folder reported by tosu is used.
  songsFolder: '',
  // Switch to the Game view once a clicked map is in osu! (imported, or its search copied).
  switchToGame: true,
  // Use mania-tracker.com's data (tracked plays, ratings, rating history) for your osu! user ID.
  maniaTracker: true,
  // Estimate dan levels (4K regular) from the plays in the skill profile.
  danLevels: true,
  // Live pp, and the keys with keys per second, in small windows kept above osu! (overlay.js), and
  // where each was dragged to and how big: { pp: { position: [x, y], scale }, keys: ... }.
  overlay: false,
  overlayLayout: {},
  // [{ id, username, avatarUrl, countryCode }]
  friends: [],
});

let cache = null;

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Contains the OAuth client secret, so keep it readable by the current user only.
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  return cache;
}

module.exports = { load, save, DEFAULTS };
