const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, shell } = require('electron');
const config = require('./config');
const { OsuApi, compareScores, normalizeScore, stableAccuracy } = require('./osuApi');
const { ppByAccuracy } = require('./maniaPp');
const { mapSkillsets } = require('./skillsets');
const { Library } = require('./library');
const { parseOsuFile } = require('./osuFile');
const { buildProfile, ratePlay, rateOfMods, accuracyModel } = require('./profile');
const { recommend, analyseProfile, FOCUS_SKILLSETS, LIMIT } = require('./recommend');
const { Catalogue, starRange } = require('./catalogue');
const { KeyInput } = require('./keyInput');
const { History } = require('./history');
const maniaTracker = require('./maniaTracker');
const { estimateDan } = require('./dan');
const { Overlay } = require('./overlay');

const api = new OsuApi();
const MAX_PARALLEL_REQUESTS = 4;

function applyCredentials() {
  const cfg = config.load();
  api.setCredentials(cfg.clientId, cfg.clientSecret);
}

let captureSources = [];
let captureSourceId = null;
const keyInput = new KeyInput();
const overlay = new Overlay();

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#14141c',
    title: 'osu!mania Tracker',
    // Window/taskbar icon; packaged builds also include it (see "files" in package.json).
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open profile/beatmap links in the system browser instead of new Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://osu.ppy.sh/') || url.startsWith('https://mania-tracker.com/')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Pages loaded from file:// send "Origin: null", which tosu rejects with 403. Present the
  // WebSocket handshake as coming from the server's own origin, which tosu always allows.
  win.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    callback({ requestHeaders: { ...details.requestHeaders, Origin: url.origin } });
  });

  // Game view: getDisplayMedia() captures the window picked through capture:sources/capture:select.
  win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    const source = captureSources.find((s) => s.id === captureSourceId);
    callback(source ? { video: source } : {});
  });

  api.onRateLimit = (rateLimit) => {
    if (!win.isDestroyed()) win.webContents.send('api:rate-limit', rateLimit);
  };
  overlay.onState = (state) => {
    if (!win.isDestroyed()) win.webContents.send('overlay:state', state);
  };

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/** Runs `fn` over `items` with at most `limit` promises in flight, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** HTTP origin of the configured tosu server. */
function tosuOrigin() {
  const wsUrl = new URL(config.load().tosuUrl);
  return `${wsUrl.protocol === 'wss:' ? 'https:' : 'http:'}//${wsUrl.host}`;
}

const PP_ACCURACIES = [90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
// Mods that change mania pp: NF, EZ, DT, HT (legacy bitflags, as tosu's calculator expects).
const PP_MOD_BITS = 1 | 2 | 64 | 256;

/**
 * pp per accuracy for the map currently selected in osu!, with the given mods. tosu provides the
 * star rating and note count; the pp itself is estimated in maniaPp.js, because tosu assumes an
 * unrealistic hit spread for a target accuracy. Runs here rather than in the renderer because
 * tosu rejects HTTP requests from a file:// origin.
 */
async function calculatePp(mods, od) {
  const res = await fetch(`${tosuOrigin()}/api/calculate/pp?mode=3&mods=${mods}&acc=100`, { signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  const stars = body.difficulty?.stars;
  const hits = body.difficulty?.nObjects;
  if (!res.ok || body.error || typeof stars !== 'number' || !hits) {
    throw new Error(`tosu could not calculate pp${body.error ? `: ${body.error}` : ` (HTTP ${res.status})`}`);
  }
  return { ppByAcc: ppByAccuracy({ stars, hits, od, mods, accuracies: PP_ACCURACIES }), stars };
}

// Mods that change difficulty or pp in mania. Other mods (HD, FI, MR, key mods, ...) are visual
// or don't count, so a HD+DT score is grouped with the DT scores.
const BOARD_MODS = ['EZ', 'NF', 'HT', 'DT', 'HR'];
const MOD_ALIASES = { NC: 'DT', DC: 'HT' };

function modKey(mods) {
  const set = new Set(mods.map((m) => MOD_ALIASES[m] ?? m));
  return BOARD_MODS.filter((m) => set.has(m)).join('') || 'NM';
}

/** Players with a score first, ordered by `compare`, then everyone without one. */
function sortEntries(entries, compare) {
  return entries.sort((a, b) => {
    if (!a.score || !b.score) return (b.score ? 1 : 0) - (a.score ? 1 : 0);
    return compare(a.score, b.score);
  });
}

const comparePp = (a, b) => (b.pp ?? -1) - (a.pp ?? -1) || compareScores(a, b);

/**
 * Leaderboards over the same players: best score, highest pp, and one per mod combination that
 * anyone has a score with (NM first, then the most played). Mod boards only list players who
 * have a score with those mods.
 */
function buildBoards(entries) {
  const pick = (entry, score) => ({ user: entry.user, isMe: entry.isMe, error: entry.error, score });
  const boards = [
    { key: 'score', label: 'Top score', entries: sortEntries(entries.map((e) => pick(e, e.scores[0] ?? null)), compareScores) },
    { key: 'pp', label: 'Top pp', entries: sortEntries(entries.map((e) => pick(e, [...e.scores].sort(comparePp)[0] ?? null)), comparePp) },
  ];

  const byMods = new Map(); // mod key -> entries, each with that player's best score for the mods
  for (const entry of entries) {
    for (const score of entry.scores) {
      const key = modKey(score.mods);
      if (!byMods.has(key)) byMods.set(key, []);
      const list = byMods.get(key);
      // Scores are sorted best first, so the first one per player and mod key is their best.
      if (!list.some((e) => e.user.id === entry.user.id)) list.push(pick(entry, score));
    }
  }
  const modBoards = [...byMods.entries()]
    .sort(([a, x], [b, y]) => (b === 'NM') - (a === 'NM') || y.length - x.length || a.localeCompare(b))
    .map(([key, list]) => ({ key: `mods:${key}`, label: key, entries: sortEntries(list, compareScores) }));

  return [...boards, ...modBoards];
}

function publicConfig() {
  const { clientId, clientSecret, username, tosuUrl, songsFolder, switchToGame, maniaTracker: useManiaTracker, danLevels, overlay: showOverlay, friends } = config.load();
  return {
    clientId, clientSecret, username, tosuUrl, songsFolder, switchToGame, maniaTracker: useManiaTracker, danLevels, overlay: showOverlay, friends,
    hasCredentials: Boolean(clientId && clientSecret),
  };
}

/** Starts or stops the in-game overlays to match the setting; `restart` picks up a new tosu URL. */
function applyOverlay(restart = false) {
  const { overlay: enabled, overlayLayout, overlayPosition } = config.load();
  const layout = overlayLayout && typeof overlayLayout === 'object' ? overlayLayout : {};
  // The single overlay of earlier versions became the pp one.
  if (!layout.pp && Array.isArray(overlayPosition)) layout.pp = { position: overlayPosition, scale: 1 };
  if (!enabled || restart) overlay.stop();
  if (enabled) overlay.start(layout);
}

// ---------- recommendations ----------

let library = null; // created once the app is ready, since it needs the userData path
let history = null; // same
// { user, builtAt, inputs, loadChart, ratings, plays, passes, sources, maniaTracker, dan } for the
// last player a profile was built for. `inputs` are the plays it was built from, `dan` the dan
// estimate once worked out.
let profile = null;
let catalogue = null; // ranked maps from osu.ppy.sh that aren't in the Songs folder
const beatmapInfo = new Map(); // beatmap ID -> { status, checksum, stars, od, hits } from the API
const RANKED = new Set(['ranked', 'approved']);
const REC_PP_ACCURACIES = [95, 97, 98, 99, 100];
const PP_CANDIDATES = 800; // maps around the player's level checked for pp
const TOP_PLAYS = 100; // plays that count towards total pp
const SOURCES = ['all', 'local', 'online'];

/** The configured Songs folder, or the one tosu reports. */
async function resolveSongsFolder(tosuFolder) {
  let folder = config.load().songsFolder || tosuFolder || '';
  // tosu running inside Wine reports Windows paths; Wine's Z: drive is the Linux root.
  if (process.platform !== 'win32' && /^z:[\\/]/i.test(folder)) folder = `/${folder.slice(3).replace(/\\/g, '/')}`;
  if (/^~(?=$|[\\/])/.test(folder)) folder = path.join(app.getPath('home'), folder.slice(1));
  if (!folder) throw new Error('Set your osu! Songs folder in ⚙ Settings, or start tosu so it can be detected.');
  const stat = await fs.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`The Songs folder "${folder}" was not found. Check it in ⚙ Settings.`);
  return folder;
}

const md5 = (bytes) => crypto.createHash('md5').update(bytes).digest('hex');

/**
 * .osu file of a play: from the Songs folder if it's there (by checksum, or by beatmap ID for
 * plays that come without one), else from the maps/ cache, else the one tosu has loaded if it's
 * the same map (for unsubmitted maps), else downloaded from osu.ppy.sh and kept.
 */
async function loadPlayFile(folder, localCharts, play) {
  const { id, checksum } = play.beatmap;
  const local = checksum ? localCharts.byChecksum.get(checksum) : localCharts.byId.get(id);
  if (local) {
    const text = await fs.readFile(path.join(folder, local.path), 'utf8').catch(() => null);
    if (text) return text;
  }

  const file = path.join(app.getPath('userData'), 'maps', `${id}.osu`);
  if (id > 0) {
    const cached = await fs.readFile(file, 'utf8').catch(() => null);
    if (cached) return cached;
  }
  if (checksum) {
    try {
      const res = await fetch(`${tosuOrigin()}/files/beatmap/file`, { signal: AbortSignal.timeout(5000) });
      const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      if (bytes && md5(bytes) === checksum) return bytes.toString('utf8');
    } catch {
      // tosu isn't running.
    }
  }
  if (!(id > 0)) throw new Error('The map file was not found.');
  const res = await fetch(`https://osu.ppy.sh/osu/${id}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Could not download beatmap ${id} (HTTP ${res.status})`);
  const text = await res.text();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

/** Loads plays' charts for rating them (see loadPlayFile), parsed and with their checksum. */
function chartLoader(folder, charts) {
  const localCharts = {
    byChecksum: new Map(charts.map((c) => [c.checksum, c])),
    byId: new Map(charts.filter((c) => c.beatmapId > 0).map((c) => [c.beatmapId, c])),
  };
  return async (play) => {
    const text = await loadPlayFile(folder, localCharts, play);
    return { ...parseOsuFile(text), checksum: md5(Buffer.from(text, 'utf8')) };
  };
}

/** chartLoader for the Songs folder, if it's known and has been scanned. */
async function songsChartLoader(songsFolder) {
  const folder = await resolveSongsFolder(songsFolder).catch(() => null);
  const charts = folder ? await library.charts(folder) : null;
  return chartLoader(folder, charts ?? []);
}

// Beatmap mirrors, tried in order. osu.ppy.sh only serves downloads to logged-in website sessions.
const BEATMAP_MIRRORS = [(id) => `https://osu.direct/api/d/${id}?noVideo=1`, (id) => `https://catboy.best/d/${id}n`];
const MAX_OSZ_BYTES = 200 * 1024 * 1024;

/** A beatmap set's .osz (without video) from the first mirror that has it. */
async function downloadBeatmapSet(setId) {
  let lastError = null;
  for (const mirror of BEATMAP_MIRRORS) {
    const url = mirror(setId);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': `osu-mania-tracker/${app.getVersion()}` }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > MAX_OSZ_BYTES) throw new Error('file too large');
      const data = Buffer.from(await res.arrayBuffer());
      // .osz files are zip archives.
      if (data.length > MAX_OSZ_BYTES || data.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('not a beatmap archive');
      return data;
    } catch (err) {
      lastError = `${new URL(url).host}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`;
    }
  }
  throw new Error(`Couldn't download beatmap set ${setId} (${lastError}).`);
}

const IMPORT_POLL_MS = 2000;
// osu! may have to start first, and imports queue behind each other.
const IMPORT_TIMEOUT_MS = 5 * 60 * 1000;

/** Number of .osu files osu! has extracted for a set: it names the folder "<set ID> Artist - Title". */
async function importedOsuFiles(folder, setId) {
  const prefix = new RegExp(`^${setId}(\\s|$)`);
  let count = 0;
  for (const dir of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory() || !prefix.test(dir.name)) continue;
    const names = await fs.readdir(path.join(folder, dir.name)).catch(() => []);
    count += names.filter((n) => n.toLowerCase().endsWith('.osu')).length;
  }
  return count;
}

/**
 * Waits until osu! has imported a set into the Songs folder, then rescans the library so the set
 * counts as downloaded. Returns whether the import was seen.
 */
async function waitForImport(folder, setId) {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  let last = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS));
    const count = await importedOsuFiles(folder, setId);
    // Done once the files stop appearing.
    if (count > 0 && count === last) {
      await library.scan(folder);
      return true;
    }
    last = count;
  }
  return false;
}

/**
 * Adds the ranked status to local maps (online ones come from a ranked search) and the info pp
 * needs to all maps. `outdated` means the file in the Songs folder differs from the version on
 * osu.ppy.sh.
 */
async function addBeatmapInfo(maps) {
  const missing = [...new Set(maps.filter((m) => m.beatmapId > 0 && !beatmapInfo.has(m.beatmapId)).map((m) => m.beatmapId))];
  if (missing.length) {
    try {
      const found = await api.getBeatmapInfo(missing);
      for (const id of missing) beatmapInfo.set(id, found.get(id) ?? { status: 'unsubmitted', checksum: null });
    } catch {
      // Statuses and pp stay unknown; the maps are still shown.
    }
  }
  for (const map of maps) {
    const info = map.beatmapId > 0 ? beatmapInfo.get(map.beatmapId) : { status: 'unsubmitted', checksum: null };
    if (map.source === 'local') {
      map.status = info?.status ?? null;
      map.outdated = Boolean(info?.checksum && info.checksum !== map.checksum);
    }
  }
}

/** Nomod pp at a few accuracies for a ranked map, or null if it gives none or isn't known. */
function recommendationPp(map) {
  const info = beatmapInfo.get(map.beatmapId);
  if (!RANKED.has(map.status) || map.outdated || !(info?.stars > 0) || !info.hits) return null;
  return ppByAccuracy({ stars: info.stars, hits: info.hits, od: info.od ?? 8, mods: 0, accuracies: REC_PP_ACCURACIES });
}

/** Weighted pp total of plays sorted best first, as on osu! profiles (without bonus pp). */
const weightedPp = (pps) => pps.slice(0, TOP_PLAYS).reduce((sum, pp, i) => sum + pp * 0.95 ** i, 0);

/**
 * Keeps the ranked maps where a good play would raise the player's total pp, best gain first: as a
 * new top play, or by beating their score on the map. `expected` is the accuracy of such a play
 * (from the player's top plays on maps of similar difficulty), its pp, how much it would add to
 * the player's total and their current score on the map, if it's in their top plays.
 */
async function rankByPpGain(maps) {
  await addBeatmapInfo(maps);
  const { topScores, plays, ratings } = profile;
  const accuracyFor = accuracyModel(plays, ratings.overall);
  const topPp = [...topScores.values()].map((s) => s.pp).sort((a, b) => b - a);
  const total = weightedPp(topPp);
  const ranked = [];
  for (const map of maps) {
    const info = beatmapInfo.get(map.beatmapId);
    const accuracy = accuracyFor(map.msd.overall - ratings.overall);
    if (!RANKED.has(map.status) || map.outdated || !(info?.stars > 0) || !info.hits || accuracy == null) continue;
    const percent = Math.round(accuracy * 1000) / 10;
    const pp = ppByAccuracy({ stars: info.stars, hits: info.hits, od: info.od ?? 8, mods: 0, accuracies: [percent] })[percent];
    // Only the best score on a map counts, so a better one replaces it.
    const current = topScores.get(map.beatmapId) ?? null;
    if (current && pp <= current.pp) continue;
    const others = current ? topPp.toSpliced(topPp.indexOf(current.pp), 1) : topPp;
    const gain = weightedPp([...others, pp].sort((a, b) => b - a)) - total;
    if (gain < 0.05) continue;
    ranked.push({ ...map, expected: { accuracy: percent, pp, gain, current } });
  }
  return ranked.sort((a, b) => b.expected.gain - a.expected.gain);
}

/** The player the app is for: the username in Settings, else the one logged into osu!. */
async function currentUser(playerName) {
  const name = config.load().username || playerName || '';
  if (!name) throw new Error('Set your username in ⚙ Settings (or log into osu!) to build your profile.');
  const user = await api.getUser(name);
  if (!user) throw new Error(`No osu! user named "${name}" was found.`);
  return user;
}

const isRateable = (play) => play.mode === 3 && play.keys === 4 && !play.convert;

/** A play from the history, shaped like OsuApi.getBestScores' plays for the profile. */
const historyInput = (play) => ({
  id: play.scoreId ?? play.id,
  accuracy: play.accuracy,
  pp: play.pp,
  mods: play.mods,
  stats: play.stats,
  date: play.at,
  source: 'history',
  beatmap: { id: play.beatmapId, checksum: play.checksum, keys: play.keys, convert: Boolean(play.convert), version: play.version, stars: play.stars },
  beatmapset: { title: play.title, artist: play.artist },
});

/** Records the profile's ratings in the history, for the skill progress chart. */
async function snapshotProfile(sender) {
  const added = await history.addSkillSnapshot(profile.user.id, {
    ratings: profile.ratings,
    playCount: profile.plays.length,
    sources: profile.sources,
  });
  if (added && sender && !sender.isDestroyed()) sender.send('history:updated');
}

/**
 * The skill profile, built from the player's top plays, their plays on mania-tracker.com (if
 * enabled) and the passed plays in the history. Built on first use and kept; `refresh` rescans the
 * Songs folder and rebuilds the profile from the current plays.
 */
async function ensureProfile(sender, { playerName, songsFolder, refresh }) {
  const progress = (stage) => (p) => {
    if (!sender.isDestroyed()) sender.send('recommendations:progress', { stage, ...p });
  };
  const folder = await resolveSongsFolder(songsFolder);
  let charts = refresh ? null : await library.charts(folder);
  charts ??= await library.scan(folder, progress('library'));
  if (charts.length === 0) throw new Error(`No 4K osu!mania maps were found in "${folder}".`);

  const user = await currentUser(playerName);
  if (refresh || profile?.user.id !== user.id) {
    const best = await api.getBestScores(user.id);
    const top = best.filter((p) => p.beatmap.keys === 4 && !p.beatmap.convert).map((p) => ({ ...p, source: 'top' }));
    let tracked = [];
    let trackerSkills = null;
    if (config.load().maniaTracker) {
      [tracked, trackerSkills] = await Promise.all([
        maniaTracker.getSkillPlays(user.id, normalizeScore).catch(() => []),
        maniaTracker.getSkills(user.id, user.username).catch(() => null),
      ]);
    }
    await importRecentPlays(user).catch(() => {});
    const played = (await history.plays()).filter((p) => p.passed && isRateable(p)).map(historyInput);
    const inputs = [...top, ...tracked.map((p) => ({ ...p, source: 'mania-tracker' })), ...played];
    const loadChart = chartLoader(folder, charts);
    const built = await buildProfile(inputs, loadChart, progress('profile'));
    if (built.plays.length === 0) throw new Error(`${user.username} has no 4K plays to build a profile from.`);
    // Best score per map among the top plays (other key counts too), for pp gain.
    const topScores = new Map();
    for (const p of best) {
      const pp = p.pp ?? 0;
      if (!(topScores.get(p.beatmap.id)?.pp >= pp)) topScores.set(p.beatmap.id, { pp, accuracy: p.accuracy, mods: p.mods });
    }
    profile = { user, builtAt: Date.now(), topScores, inputs, loadChart, maniaTracker: trackerSkills, ...built };
    await snapshotProfile(sender);
  }
  return { folder, charts };
}

/** Adds a new passed play to the profile, if one has been built for its player, and re-rates it. */
async function addToProfile(sender, play, userId) {
  if (profile?.user.id !== userId || !play.passed || !isRateable(play)) return;
  profile.inputs.push(historyInput(play));
  // Only the new play needs rating; the others come from the cache.
  Object.assign(profile, await buildProfile(profile.inputs, profile.loadChart), { dan: undefined });
  await snapshotProfile(sender);
}

/** The profile's dan estimate, if dan levels are turned on. */
function profileDan() {
  if (!profile || !config.load().danLevels) return null;
  if (profile.dan === undefined) profile.dan = estimateDan(profile.passes);
  return profile.dan;
}

/**
 * Skill profile and recommended maps. The library and profile are built on first use and kept;
 * `refresh` rescans the Songs folder and rebuilds the profile from the current plays.
 */
async function getRecommendations(sender, { playerName, songsFolder, focus, source, refresh }) {
  const { folder, charts } = await ensureProfile(sender, { playerName, songsFolder, refresh });
  const progress = (stage) => (p) => {
    if (!sender.isDestroyed()) sender.send('recommendations:progress', { stage, ...p });
  };

  // Online maps are rated in the background; whatever is rated so far is used.
  const range = starRange(profile.plays);
  if (range) catalogue.fill(range, progress('online'));
  focus = ['fit', 'warmup', 'pp'].includes(focus) || FOCUS_SKILLSETS.includes(focus) ? focus : 'fit';
  const localIds = new Set(charts.map((c) => c.beatmapId).filter(Boolean));
  const localChecksums = new Set(charts.map((c) => c.checksum));
  // Maps you've already played well are left out, except for pp gain, where a better score on
  // them can still add pp.
  const played = focus === 'pp'
    ? new Set()
    : new Set(profile.plays.flatMap((p) => [p.beatmapId, p.checksum]));
  const rated = await catalogue.charts();
  const online = rated
    .filter((c) => !localIds.has(c.beatmapId) && !localChecksums.has(c.checksum) && !played.has(c.beatmapId));
  const pool = [...charts.map((c) => ({ ...c, source: 'local' })), ...online];

  const { ratings } = profile;
  const analysis = analyseProfile(ratings);
  source = SOURCES.includes(source) ? source : 'all';
  // Extra picks, since Best fit drops maps that give no pp once their status is known, and pp
  // ranks every map in its band by expected pp.
  let maps = recommend({
    charts: source === 'all' ? pool : pool.filter((c) => c.source === source),
    ratings,
    focus,
    exclude: played,
    limit: focus === 'pp' ? PP_CANDIDATES : LIMIT * 3,
  });
  if (focus === 'fit') {
    await addBeatmapInfo(maps);
    maps = maps.filter((m) => m.status == null || RANKED.has(m.status));
  }
  if (focus === 'pp') maps = await rankByPpGain(maps);
  maps = maps.slice(0, LIMIT);
  await addBeatmapInfo(maps);
  for (const map of maps) map.pp = recommendationPp(map);
  return {
    user: profile.user,
    builtAt: profile.builtAt,
    playCount: profile.plays.length,
    sources: profile.sources,
    maniaTracker: profile.maniaTracker,
    dan: profileDan(),
    ratings,
    analysis,
    library: { folder, count: charts.length },
    online: { count: rated.length, range, ...catalogue.status },
    focus,
    source,
    maps,
  };
}

// ---------- play history ----------

const SCORE_CHECK_DELAY_MS = 6000; // osu! submits the score a few seconds after the results screen
const STATS_MAX_AGE_MS = 10 * 60 * 1000; // pp and rank are checked when a play starts, if older than this
const IMPORT_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_PLAYS = 500; // latest plays sent to the renderer
const JUDGEMENT_KEYS = ['max', '300', '200', '100', '50', 'miss'];

const notifyHistory = (sender) => {
  if (sender && !sender.isDestroyed()) sender.send('history:updated');
};

const round2 = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.round(v * 100) / 100]));

/** Adds the play's MinaCalc ratings (its chart's MSD and the play's SSR per skillset) to the history. */
async function ratePlayInHistory(play, loadChart) {
  if (!play.passed || !isRateable(play) || play.ssr) return play;
  const rated = await ratePlay(historyInput(play), loadChart).catch(() => null);
  if (!rated) return play;
  return (await history.updatePlay(play.id, { msd: Math.round(rated.msd * 100) / 100, ssr: round2(rated.ssr) })) ?? play;
}

/** A play from tosu, checked field by field since it comes from the renderer. */
function playFromTosu(raw) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const str = (v) => String(v ?? '').slice(0, 300);
  const stats = Object.fromEntries(JUDGEMENT_KEYS.map((k) => [k, Math.max(0, Math.round(num(raw?.stats?.[k]) ?? 0))]));
  const at = new Date(raw?.at);
  if (Number.isNaN(at.getTime()) || JUDGEMENT_KEYS.every((k) => stats[k] === 0)) return null;
  const startedAt = new Date(raw.startedAt);
  const mods = (Array.isArray(raw.mods) ? raw.mods : []).map(str).filter((m) => /^[A-Z0-9]{2}$/.test(m));
  const holds = num(raw.holds);
  const objects = num(raw.objects);
  const t = raw.timing;
  const timing = t && num(t.count) > 0 && num(t.mean) != null && num(t.ur) != null
    ? { count: Math.round(num(t.count)), mean: num(t.mean), ur: num(t.ur), early: Math.round(num(t.early) ?? 0), late: Math.round(num(t.late) ?? 0) }
    : null;
  return {
    id: crypto.randomUUID(),
    at: at.toISOString(),
    startedAt: Number.isNaN(startedAt.getTime()) ? null : startedAt.toISOString(),
    passed: Boolean(raw.passed),
    source: 'tosu',
    beatmapId: Math.max(0, Math.round(num(raw.beatmapId) ?? 0)),
    setId: Math.max(0, Math.round(num(raw.setId) ?? 0)),
    checksum: /^[0-9a-f]{32}$/.test(raw.checksum) ? raw.checksum : '',
    title: str(raw.title),
    artist: str(raw.artist),
    version: str(raw.version),
    mapper: str(raw.mapper),
    stars: num(raw.stars),
    keys: num(raw.keys),
    mode: num(raw.mode),
    convert: false,
    od: num(raw.od),
    lnShare: objects > 0 && holds >= 0 ? Math.round((holds / objects) * 1000) / 1000 : null,
    mods,
    rate: rateOfMods(mods),
    stats,
    timing,
    accuracy: stableAccuracy(stats) ?? 0,
    // tosu's pp of the play so far; replaced by the submitted score's. Failed plays give none.
    pp: raw.passed ? num(raw.pp) : null,
    maxCombo: num(raw.maxCombo),
  };
}

/** A play from a raw osu! API score with its beatmap and set (osu! API or mania-tracker.com). */
function playFromScore(raw, source) {
  const score = normalizeScore(raw);
  const beatmap = raw.beatmap ?? {};
  const set = raw.beatmapset ?? {};
  return {
    id: crypto.randomUUID(),
    at: score.date,
    startedAt: raw.started_at ?? null,
    passed: raw.passed !== false,
    source,
    beatmapId: beatmap.id ?? raw.beatmap_id ?? 0,
    setId: beatmap.beatmapset_id ?? set.id ?? 0,
    checksum: beatmap.checksum ?? '',
    title: set.title ?? '',
    artist: set.artist ?? '',
    version: beatmap.version ?? '',
    mapper: set.creator ?? '',
    stars: beatmap.difficulty_rating ?? null,
    length: beatmap.hit_length ?? null, // seconds of drain time at 1.0x
    keys: beatmap.cs ?? null,
    mode: 3,
    convert: Boolean(beatmap.convert),
    od: beatmap.accuracy ?? null,
    mods: score.mods,
    rate: rateOfMods(score.mods),
    stats: Object.fromEntries(JUDGEMENT_KEYS.map((k) => [k, score.stats[k] ?? 0])),
    accuracy: score.accuracy,
    pp: score.pp,
    maxCombo: score.maxCombo,
    score: score.score,
    scoreId: raw.id ?? null,
  };
}

/** Records the player's current pp and ranks. */
async function checkUserStats(userId) {
  const stats = await api.getUserStats(userId);
  if (stats) await history.addUserStats(userId, stats);
}

/**
 * After a passed play on a submitted map: once osu! has submitted it, finds the score (same
 * judgements) for its pp and whether it's a new personal best, and checks the player's pp and rank.
 */
async function checkSubmittedScore(sender, play, user) {
  await new Promise((resolve) => setTimeout(resolve, SCORE_CHECK_DELAY_MS));
  const scores = await api.getUserScores(play.beatmapId, user.id).catch(() => []);
  const sameStats = (s) => JUDGEMENT_KEYS.every((k) => (s.stats[k] ?? 0) === play.stats[k]);
  const match = scores.find(sameStats);
  if (match) {
    // Scores are sorted best first, so the play is a personal best if it's the first.
    await history.updatePlay(play.id, { scoreId: match.id, pp: match.pp, score: match.score, pb: scores[0] === match });
  }
  await checkUserStats(user.id).catch(() => {});
  notifyHistory(sender);
}

/** Rates a recorded play, adds it to the profile, and checks its score once it's submitted. */
async function processRecordedPlay(sender, play, { playerName, songsFolder }) {
  let user = null;
  if (api.hasCredentials) user = await currentUser(playerName).catch(() => null);
  if (play.passed && isRateable(play)) {
    play = await ratePlayInHistory(play, await songsChartLoader(songsFolder));
    notifyHistory(sender);
    if (user) await addToProfile(sender, play, user.id).catch(() => {});
  }
  if (user && play.passed && play.beatmapId > 0) await checkSubmittedScore(sender, play, user);
}

const lastImport = new Map(); // user ID -> time of the last import of recent plays

/**
 * Imports the player's recent plays from the osu! API (last 24 hours, failed ones too) and from
 * mania-tracker.com (if enabled), so plays made while the app was closed are in the history.
 * Returns how many were new.
 */
async function importRecentPlays(user) {
  if (Date.now() - (lastImport.get(user.id) ?? 0) < IMPORT_INTERVAL_MS) return 0;
  lastImport.set(user.id, Date.now());
  const [fromOsu, fromTracker] = await Promise.all([
    api.getRecentScores(user.id).catch(() => []),
    config.load().maniaTracker ? maniaTracker.getRecentScores(user.id).catch(() => []) : [],
  ]);
  let added = 0;
  for (const [scores, source] of [[fromOsu, 'osu-api'], [fromTracker, 'mania-tracker']]) {
    for (const raw of scores) {
      if (raw.ruleset_id != null && raw.ruleset_id !== 3) continue;
      if ((await history.addPlay(playFromScore(raw, source))).added) added++;
    }
  }
  return added;
}

let ratingHistory = null; // promise of the running background rating

/** Rates the passed 4K plays in the history that don't have ratings yet, one at a time. */
function rateHistoryPlays(sender, songsFolder) {
  ratingHistory ??= (async () => {
    const loadChart = await songsChartLoader(songsFolder);
    let rated = 0;
    for (const play of await history.plays()) {
      if (!play.passed || !isRateable(play) || play.ssr) continue;
      if ((await ratePlayInHistory(play, loadChart)).ssr) rated++;
    }
    if (rated) notifyHistory(sender);
  })().finally(() => { ratingHistory = null; });
  return ratingHistory;
}

/**
 * Everything the Progress tab shows: sessions, the latest plays, skill rating snapshots, and the
 * player's ratings and rating history on mania-tracker.com.
 */
async function getHistory(sender, { playerName, songsFolder }) {
  let user = null;
  let error = null;
  if (api.hasCredentials) {
    try {
      user = await currentUser(playerName);
    } catch (err) {
      error = err.message;
    }
  } else {
    error = 'Add your osu! API client ID and secret in ⚙ Settings to import plays and track pp and rank.';
  }
  if (user) await importRecentPlays(user).catch(() => {});
  rateHistoryPlays(sender, songsFolder).catch(() => {});

  let tracker = null;
  if (user && config.load().maniaTracker) {
    const [skills, points] = await Promise.all([
      maniaTracker.getSkills(user.id, user.username).catch((err) => ({ error: err.message })),
      maniaTracker.getSkillHistory(user.id).catch(() => []),
    ]);
    tracker = skills?.error ? { error: skills.error } : { skills, history: points };
  }
  const plays = await history.plays();
  return {
    user,
    error,
    sessions: user ? await history.sessions(user.id) : await history.sessions(null),
    plays: plays.slice(-HISTORY_PLAYS).reverse(),
    totalPlays: plays.length,
    skills: user ? await history.skillSnapshots(user.id) : [],
    timing: await history.recentTiming(),
    profile: profile && user && profile.user.id === user.id ? { ratings: profile.ratings, builtAt: profile.builtAt, dan: profileDan() } : null,
    maniaTracker: tracker,
  };
}

function registerIpc() {
  ipcMain.handle('config:get', () => publicConfig());
  ipcMain.handle('api:rate-limit', () => api.rateLimit);

  ipcMain.handle('config:save', (_event, patch) => {
    const allowed = ['clientId', 'clientSecret', 'username', 'tosuUrl', 'songsFolder', 'switchToGame', 'maniaTracker', 'danLevels', 'overlay'];
    const flags = ['switchToGame', 'maniaTracker', 'danLevels', 'overlay'];
    const clean = Object.fromEntries(
      Object.entries(patch || {})
        .filter(([key]) => allowed.includes(key))
        .map(([key, value]) => [key, flags.includes(key) ? Boolean(value) : String(value ?? '').trim()]),
    );
    // The profile's plays depend on this, so it's rebuilt on next use.
    if ('maniaTracker' in clean && clean.maniaTracker !== config.load().maniaTracker) profile = null;
    // The overlay reads tosu and the Songs folder (for the key bindings) when it starts.
    const overlayRestart = ['tosuUrl', 'songsFolder'].some((key) => key in clean && clean[key] !== config.load()[key]);
    config.save(clean);
    applyCredentials();
    applyOverlay(overlayRestart);
    return publicConfig();
  });

  ipcMain.handle('friends:add', async (_event, username) => {
    const name = String(username || '').trim();
    if (!name) throw new Error('Enter a username.');
    const user = await api.getUser(name);
    if (!user) throw new Error(`No osu! user named "${name}" was found.`);

    const { friends } = config.load();
    if (friends.some((f) => f.id === user.id)) throw new Error(`${user.username} is already in your list.`);
    config.save({ friends: [...friends, user] });
    return publicConfig();
  });

  ipcMain.handle('friends:remove', (_event, userId) => {
    const { friends } = config.load();
    config.save({ friends: friends.filter((f) => f.id !== userId) });
    return publicConfig();
  });

  ipcMain.handle('pp:calculate', (_event, mods, od) => {
    od = Number(od);
    return calculatePp((Number(mods) || 0) & PP_MOD_BITS, Number.isFinite(od) ? Math.min(Math.max(od, 0), 10) : 8);
  });

  // osu! (stable and lazer) registers the osu:// scheme; osu://b/<id> selects the difficulty in
  // song select if the map is installed.
  ipcMain.handle('osu:open-beatmap', async (_event, beatmapId) => {
    const id = Number(beatmapId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('This map has no beatmap ID.');
    try {
      await shell.openExternal(`osu://b/${id}`);
    } catch {
      throw new Error("Couldn't open osu!. Make sure it's installed and handles osu:// links.");
    }
  });

  // Without osu!supporter there's no osu!direct, so maps that aren't downloaded are fetched as .osz
  // from a mirror and opened; osu! imports the set and selects it. Once the set shows up in the
  // Songs folder, the library is rescanned and the renderer told, so it's no longer "Not downloaded".
  ipcMain.handle('osu:download-beatmap', async (event, setId, songsFolder) => {
    const id = Number(setId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('This map has no beatmap set ID.');
    const file = path.join(app.getPath('temp'), 'osu-mania-tracker', `${id}.osz`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await downloadBeatmapSet(id));
    const error = await shell.openPath(file);
    if (error) throw new Error(`Downloaded the map but couldn't open it in osu! (${error}). Make sure .osz files open with osu!.`);
    const folder = await resolveSongsFolder(songsFolder).catch(() => null);
    if (!folder) return;
    waitForImport(folder, id)
      .then((imported) => {
        if (imported && !event.sender.isDestroyed()) event.sender.send('library:imported', id);
      })
      .catch(() => {
        // The set shows up after the next rebuild instead.
      });
  });

  // Without osu!supporter, stable can't be told to select a map, so a song select search for it is
  // copied instead.
  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text ?? '').slice(0, 500));
  });

  // Windows that the game view can capture. On Wayland the desktop portal shows its own picker
  // and only the chosen window comes back; on X11 every window is listed for the renderer's picker.
  ipcMain.handle('capture:sources', async () => {
    captureSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 } });
    return captureSources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL() }));
  });

  ipcMain.handle('capture:select', (_event, id) => {
    captureSourceId = captureSources.some((s) => s.id === id) ? id : null;
    return captureSourceId !== null;
  });

  // Key overlay in the game view: keyboards are only read while the renderer asks for it.
  ipcMain.handle('keys:watch', (event, { gameFolder, songsFolder } = {}) => {
    const sender = event.sender;
    keyInput.onKey = (column, pressed) => {
      if (!sender.isDestroyed()) sender.send('keys:input', column, pressed);
    };
    // The Songs folder setting is a real path; tosu's folders can be Windows paths under Wine.
    const folder = songsFolder ? path.dirname(path.resolve(String(songsFolder))) : String(gameFolder || '');
    return keyInput.start(folder);
  });

  ipcMain.handle('keys:unwatch', () => keyInput.stop());

  ipcMain.handle('overlay:state', () => ({ running: overlay.running, locked: overlay.locked }));
  ipcMain.handle('overlay:lock', (_event, locked) => overlay.setLocked(locked));
  // Your scores on the current map, for the pp overlay to compare the play in progress with your PB.
  ipcMain.handle('overlay:pb', (_event, pb) => {
    const checksum = /^[0-9a-f]{32}$/.test(pb?.checksum) ? pb.checksum : '';
    const scores = (Array.isArray(pb?.scores) ? pb.scores : []).slice(0, 100)
      .filter((s) => Number.isFinite(s?.accuracy))
      .map((s) => ({ accuracy: s.accuracy, mods: (Array.isArray(s.mods) ? s.mods : []).map(String).filter((m) => /^[A-Z0-9]{2}$/.test(m)) }));
    overlay.setPb({ checksum, scores });
  });

  ipcMain.handle('skillsets:calculate', (_event, { checksum, beatmapId, modBits }) => {
    if (!/^[0-9a-f]{32}$/.test(String(checksum))) throw new Error('No map selected.');
    let origin = null;
    try {
      origin = tosuOrigin();
    } catch {
      // Invalid tosu URL; fall back to downloading the map.
    }
    return mapSkillsets({ tosuOrigin: origin, checksum, beatmapId: Number(beatmapId) || 0, modBits: Number(modBits) || 0 });
  });

  ipcMain.handle('recommendations:get', (event, query) => getRecommendations(event.sender, query || {}));

  ipcMain.handle('history:get', (event, query) => getHistory(event.sender, query || {}));

  // Builds (or rebuilds) the skill profile from the Progress tab, which adds a rating snapshot.
  ipcMain.handle('history:update-profile', async (event, query) => {
    await ensureProfile(event.sender, { ...query, refresh: true });
  });

  // The renderer reports every play it sees in tosu: when it starts (to note pp and rank before a
  // session) and when it ends, passed or not.
  ipcMain.handle('history:play-started', async (_event, { playerName } = {}) => {
    if (!api.hasCredentials) return;
    const user = await currentUser(playerName).catch(() => null);
    if (user && Date.now() - (await history.lastUserStatsAt(user.id)) > STATS_MAX_AGE_MS) await checkUserStats(user.id).catch(() => {});
  });

  ipcMain.handle('history:record', async (event, raw) => {
    const play = playFromTosu(raw);
    if (!play) return;
    const { play: stored, added } = await history.addPlay(play);
    notifyHistory(event.sender);
    if (!added) return;
    processRecordedPlay(event.sender, stored, { playerName: String(raw.playerName ?? ''), songsFolder: String(raw.songsFolder ?? '') })
      .catch(() => {
        // The play is recorded; its ratings or score check are missing.
      });
  });

  ipcMain.handle('scores:fetch', async (_event, { beatmapId, checksum, playerName }) => {
    const cfg = config.load();

    let id = Number(beatmapId) || 0;
    if (id <= 0 && checksum) {
      const beatmap = await api.lookupBeatmapByChecksum(checksum);
      id = beatmap?.id ?? 0;
    }
    if (id <= 0) return { beatmapId: null, boards: [], me: null, reason: 'unsubmitted' };

    const myName = cfg.username || playerName || '';
    const me = myName ? await api.getUser(myName) : null;

    const players = [];
    if (me) players.push({ user: me, isMe: true });
    for (const friend of cfg.friends) {
      if (!me || friend.id !== me.id) players.push({ user: friend, isMe: false });
    }

    const entries = await mapLimit(players, MAX_PARALLEL_REQUESTS, async ({ user, isMe }) => {
      try {
        const scores = await api.getUserScores(id, user.id);
        return { user, isMe, score: scores[0] ?? null, scores, error: null };
      } catch (err) {
        return { user, isMe, score: null, scores: [], error: err.message };
      }
    });

    return {
      beatmapId: id,
      boards: buildBoards(entries),
      me: me ? entries.find((e) => e.isMe) : null,
      reason: me ? null : 'no-username',
    };
  });
}

app.whenReady().then(() => {
  library = new Library(path.join(app.getPath('userData'), 'library-cache.json'));
  history = new History(path.join(app.getPath('userData'), 'history.json'));
  catalogue = new Catalogue(api, path.join(app.getPath('userData'), 'online-cache.json'));
  applyCredentials();
  registerIpc();
  createWindow();
  overlay.onLayout = (layout) => config.save({ overlayLayout: layout });
  applyOverlay();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  keyInput.stop();
  overlay.stop();
  if (process.platform !== 'darwin') app.quit();
});
