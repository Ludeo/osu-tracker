// Ranked 4K maps from osu.ppy.sh that aren't in the Songs folder, rated with MinaCalc.
//
// Candidates come from the beatmap search (most played first, in a star range around the
// player's level). Each one needs its .osu file, and osu.ppy.sh serves those at about two per
// second, so the catalogue fills in the background and only the ratings are kept on disk.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseOsuFile, toRows, MANIA_MODE } = require('./osuFile');
const { rateChart, calcVersion } = require('./minacalc');

const CACHE_FORMAT = 1;
const MAX_PAGES = 50; // 50 sets per page, so the 2,500 most played sets in the star range
const SEARCH_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // search again weekly for newly ranked maps
const WORKERS = 2;
const SAVE_EVERY = 25;
const UPDATE_EVERY = 100; // ask the UI to refresh after this many new maps
const MAX_FAILURES = 5; // consecutive download errors before giving up until the next start
const MAX_LN_SHARE = 0.3;

class Catalogue {
  constructor(api, cacheFile) {
    this.api = api;
    this.cacheFile = cacheFile;
    this.maps = new Map(); // beatmap ID -> rated entry, or { apiChecksum, skip: true }
    this.search = null; // { low, high, completedAt } of the last full search
    this.loading = null; // promise of the cache read
    this.filling = null; // promise of the running fill
    this.status = { running: false, rated: 0, found: 0, error: null };
  }

  /** Reads the cache once; concurrent callers wait for the same read. */
  loadCache() {
    this.loading ??= this.readCache();
    return this.loading;
  }

  async readCache() {
    try {
      const cache = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      if (cache.format !== CACHE_FORMAT || cache.calcVersion !== (await calcVersion())) return;
      this.maps = new Map(Object.entries(cache.maps).map(([id, e]) =>
        [Number(id), e.version ? { ...e, version: difficultyName(e.version) } : e]));
      this.search = cache.search;
    } catch {
      // No cache yet.
    }
  }

  async saveCache() {
    const cache = { format: CACHE_FORMAT, calcVersion: await calcVersion(), search: this.search, maps: Object.fromEntries(this.maps) };
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fs.writeFile(this.cacheFile, JSON.stringify(cache));
  }

  /** Rated maps so far. */
  async charts() {
    await this.loadCache();
    return [...this.maps.values()].filter((e) => e.msd).map((e) => ({ ...e, source: 'online' }));
  }

  /**
   * Starts filling the catalogue for a star range unless it's already running or was searched
   * recently. Returns at once; `onProgress` gets the status, with `update` set when enough new
   * maps were rated to be worth refreshing the list.
   */
  fill({ low, high }, onProgress = () => {}) {
    this.onProgress = onProgress;
    this.filling ??= this.runFill(low, high).finally(() => { this.filling = null; });
    return this.status;
  }

  report(update = false) {
    this.onProgress({ ...this.status, update });
  }

  async runFill(low, high) {
    await this.loadCache();
    const s = this.search;
    if (s && s.low <= low && s.high >= high && Date.now() - s.completedAt < SEARCH_MAX_AGE_MS) return;

    this.status = { running: true, rated: 0, found: 0, error: null };
    this.report();
    let sinceUpdate = 0;
    let failures = 0;
    try {
      const query = encodeURIComponent(`keys=4 stars>${low.toFixed(2)} stars<${high.toFixed(2)}`);
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.api.request(`/beatmapsets/search?m=3&s=ranked&sort=plays_desc&q=${query}${cursor ? `&cursor_string=${encodeURIComponent(cursor)}` : ''}`);
        const queue = [];
        for (const set of result.beatmapsets ?? []) {
          for (const b of set.beatmaps ?? []) {
            if (!isCandidate(b, low, high)) continue;
            this.status.found++;
            if (this.maps.get(b.id)?.apiChecksum !== b.checksum) queue.push({ set, beatmap: b });
          }
        }
        // A few workers share the page's queue; downloads are slow, so the rest is cheap.
        await Promise.all(Array.from({ length: WORKERS }, async () => {
          while (queue.length && failures < MAX_FAILURES) {
            const { set, beatmap } = queue.shift();
            try {
              this.maps.set(beatmap.id, await rateBeatmap(set, beatmap));
              failures = 0;
            } catch {
              failures++;
              continue;
            }
            if (!this.maps.get(beatmap.id).msd) continue;
            this.status.rated++;
            if (this.status.rated % SAVE_EVERY === 0) await this.saveCache();
            const update = ++sinceUpdate >= UPDATE_EVERY;
            if (update) sinceUpdate = 0;
            this.report(update);
          }
        }));
        if (failures >= MAX_FAILURES) throw new Error('osu.ppy.sh stopped serving beatmap files');
        this.report();
        cursor = result.cursor_string;
        if (!cursor) break;
      }
      this.search = { low, high, completedAt: Date.now() };
    } catch (err) {
      this.status.error = err.message;
    } finally {
      this.status.running = false;
      await this.saveCache();
      this.report(true);
    }
  }
}

/**
 * Star range to search, from the star ratings of the profile's top plays at 1.0x (the API only
 * has nomod star ratings). Wide enough for maps to train a skillset, which can sit away from
 * the player's overall level.
 */
function starRange(plays) {
  const stars = plays.filter((p) => p.rate === 1 && p.stars > 0).map((p) => p.stars).sort((a, b) => a - b);
  if (stars.length < 5) return null;
  const at = (q) => stars[Math.floor(q * (stars.length - 1))];
  return { low: Math.max(0, Math.floor((at(0.1) - 0.5) * 10) / 10), high: Math.ceil((at(0.9) + 0.5) * 10) / 10 };
}

/**
 * The difficulty name as in the .osu file and osu!'s song select: the API puts the key count in
 * front of mania ones ("[4K] Insane").
 */
function difficultyName(version) {
  return String(version ?? '').replace(/^\[\d+K\]\s*/, '');
}

/** 4K ranked map in the star range that MinaCalc can rate fairly (not LN-heavy). */
function isCandidate(b, low, high) {
  const objects = (b.count_circles ?? 0) + (b.count_sliders ?? 0);
  return b.mode === 'mania' && b.cs === 4 && !b.convert && b.difficulty_rating >= low && b.difficulty_rating <= high
    && objects > 0 && b.count_sliders / objects <= MAX_LN_SHARE && /^[0-9a-f]{32}$/.test(String(b.checksum));
}

async function rateBeatmap(set, b) {
  const res = await fetch(`https://osu.ppy.sh/osu/${b.id}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const chart = parseOsuFile(bytes.toString('utf8'));
  if (chart.mode !== MANIA_MODE || chart.keys !== 4 || chart.notes.length < 2) return { apiChecksum: b.checksum, skip: true };
  return {
    apiChecksum: b.checksum,
    checksum: crypto.createHash('md5').update(bytes).digest('hex'),
    title: set.title,
    artist: set.artist,
    version: difficultyName(b.version),
    creator: set.creator,
    beatmapId: b.id,
    setId: set.id,
    status: b.status,
    stars: Math.round(b.difficulty_rating * 100) / 100,
    lnShare: chart.notes.filter((n) => n.isHold).length / chart.notes.length,
    msd: Object.fromEntries(Object.entries(await rateChart(toRows(chart.notes))).map(([k, v]) => [k, Math.round(v * 100) / 100])),
  };
}

module.exports = { Catalogue, starRange };
