// Index of the 4K osu!mania maps in the local Songs folder, with their MSD at 1.0x. Cached on
// disk by path, size and modification time, so rescans only rate new or changed files.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseOsuFile, toRows, MANIA_MODE } = require('./osuFile');
const { rateChart, calcVersion } = require('./minacalc');

const CACHE_FORMAT = 1;
const PROGRESS_EVERY = 250;

class Library {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.folder = null;
    // relative path -> { size, mtimeMs, ... }; only 4K mania maps have `msd`
    this.files = new Map();
    this.scannedAt = null;
    this.loading = null; // promise of the cache read
    this.scanning = null; // promise of the running scan
  }

  /** Reads the cache once; concurrent callers wait for the same read. */
  loadCache() {
    this.loading ??= this.readCache();
    return this.loading;
  }

  async readCache() {
    try {
      const cache = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      // Ratings from another calc version would not be comparable.
      if (cache.format !== CACHE_FORMAT || cache.calcVersion !== (await calcVersion())) return;
      this.folder = cache.folder;
      this.scannedAt = cache.scannedAt;
      this.files = new Map(Object.entries(cache.files));
    } catch {
      // No cache yet.
    }
  }

  async saveCache() {
    const cache = {
      format: CACHE_FORMAT,
      calcVersion: await calcVersion(),
      folder: this.folder,
      scannedAt: this.scannedAt,
      files: Object.fromEntries(this.files),
    };
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fs.writeFile(this.cacheFile, JSON.stringify(cache));
  }

  /** 4K maps from the last scan of `folder`, or null if it hasn't been scanned. */
  async charts(folder) {
    await this.loadCache();
    if (!this.scannedAt || this.folder !== folder) return null;
    return [...this.files.entries()].filter(([, e]) => e.msd).map(([relative, e]) => ({ path: relative, ...e }));
  }

  /** Scans `folder`, reusing ratings of unchanged files. Concurrent calls share one scan. */
  scan(folder, onProgress = () => {}) {
    this.scanning ??= this.runScan(folder, onProgress).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async runScan(folder, onProgress) {
    await this.loadCache();
    const files = await listOsuFiles(folder);
    const previous = this.folder === folder ? this.files : new Map();

    const next = new Map();
    let done = 0;
    for (const relative of files) {
      if (++done % PROGRESS_EVERY === 0) onProgress({ done, total: files.length });
      try {
        const full = path.join(folder, relative);
        const stat = await fs.stat(full);
        const cached = previous.get(relative);
        next.set(relative, cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
          ? cached
          : await rateFile(full, stat));
      } catch {
        // Unreadable file; skip it.
      }
    }

    this.folder = folder;
    this.files = next;
    this.scannedAt = Date.now();
    await this.saveCache();
    onProgress({ done: files.length, total: files.length });
    return this.charts(folder);
  }
}

/** Paths of the .osu files in the map folders directly inside `folder`, relative to it. */
async function listOsuFiles(folder) {
  const result = [];
  for (const dir of await fs.readdir(folder, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const names = await fs.readdir(path.join(folder, dir.name)).catch(() => []);
    for (const name of names) if (name.toLowerCase().endsWith('.osu')) result.push(path.join(dir.name, name));
  }
  return result;
}

async function rateFile(full, stat) {
  const entry = { size: stat.size, mtimeMs: stat.mtimeMs };
  const bytes = await fs.readFile(full);
  const chart = parseOsuFile(bytes.toString('utf8'));
  if (chart.mode !== MANIA_MODE || chart.keys !== 4 || chart.notes.length < 2) return entry;
  return {
    ...entry,
    checksum: crypto.createHash('md5').update(bytes).digest('hex'),
    ...chart.meta,
    lnShare: chart.notes.filter((n) => n.isHold).length / chart.notes.length,
    msd: roundValues(await rateChart(toRows(chart.notes))),
  };
}

function roundValues(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value * 100) / 100]));
}

module.exports = { Library };
