// Saves replays of new PBs the way F2 on the results screen does. osu! stable keeps the replay of
// every local score in Data/r/<map MD5>-<timestamp>.osr; F2 copies it to Replays/ with a readable name.
// Format: https://osu.ppy.sh/wiki/en/Client/File_formats/osr_(file_format)

const fs = require('node:fs/promises');
const path = require('node:path');

const MANIA_MODE = 3;
const HEADER_BYTES = 4096; // the header up to the mods is a few hundred bytes at most
const FIND_TIMEOUT_MS = 30 * 60 * 1000; // osu! writes the replay once you leave the results screen
const FIND_INTERVAL_MS = 2000;

/** The fields of an .osr header that come before the life bar graph, or null if it isn't one. */
function parseReplayHeader(bytes) {
  let offset = 0;
  const need = (n) => {
    if (offset + n > bytes.length) throw new RangeError('truncated');
  };
  const byte = () => (need(1), bytes.readUInt8(offset++));
  const short = () => (need(2), bytes.readUInt16LE((offset += 2) - 2));
  const int = () => (need(4), bytes.readInt32LE((offset += 4) - 4));
  const string = () => {
    const marker = byte();
    if (marker === 0) return '';
    if (marker !== 0x0b) throw new RangeError('bad string');
    let length = 0;
    for (let shift = 0; ; shift += 7) {
      const b = byte();
      length |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    need(length);
    return bytes.toString('utf8', offset, (offset += length));
  };
  try {
    const mode = byte();
    const version = int();
    const beatmapHash = string();
    const player = string();
    string(); // replay MD5
    const [c300, c100, c50, geki, katu, miss] = [short(), short(), short(), short(), short(), short()];
    const score = int();
    return {
      mode, version, beatmapHash, player, score,
      stats: { max: geki, 300: c300, 200: katu, 100: c100, 50: c50, miss },
    };
  } catch {
    return null;
  }
}

async function readHeader(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    return parseReplayHeader(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** osu!'s local replay files of a map: [{ file, mtime }]. */
async function localReplayFiles(gameFolder, checksum) {
  const dir = path.join(gameFolder, 'Data', 'r');
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.startsWith(`${checksum}-`) && n.endsWith('.osr'));
  const files = await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    return stat ? { file, mtime: stat.mtimeMs } : null;
  }));
  return files.filter(Boolean);
}

/** The replays with their headers: [{ file, mtime, header }], without those that can't be read. */
async function withHeaders(files) {
  const replays = await Promise.all(files.map(async (r) => ({ ...r, header: await readHeader(r.file).catch(() => null) })));
  return replays.filter((r) => r.header);
}

const sameStats = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

/**
 * Waits for osu! to write the play's local replay: one of the map's written since the play started,
 * with the same judgements. osu! writes it when you leave the results screen, which can be many
 * minutes later. Resolves to { replay, others } (the map's earlier replays) or null.
 */
async function findReplay(gameFolder, play) {
  const since = new Date(play.startedAt ?? play.at).getTime();
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const files = await localReplayFiles(gameFolder, play.checksum);
    const fresh = await withHeaders(files.filter((r) => r.mtime >= since));
    const replay = fresh.find((r) => r.header.mode === MANIA_MODE && sameStats(play.stats, r.header.stats));
    if (replay) return { replay, others: await withHeaders(files.filter((r) => r.file !== replay.file)) };
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, FIND_INTERVAL_MS));
  }
}

/** Whether the replay beats the score of every other local replay of the map by the same player. */
function isLocalBest(replay, others) {
  const player = replay.header.player.toLowerCase();
  return others.every((r) => r.header.player.toLowerCase() !== player || r.header.score < replay.header.score);
}

/** The name F2 gives a replay, e.g. "Player - Artist - Title [Version] (2026-10-17) OsuMania.osr". */
function replayFileName({ player, artist, title, version }, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  // Characters Windows doesn't allow in file names.
  const name = `${player} - ${artist} - ${title} [${version}] (${day}) OsuMania`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '');
  return `${name}.osr`;
}

/** The first of "name (1).osr", "name (2).osr", ... that isn't taken. */
async function freeFileName(dir, name) {
  const base = name.replace(/\.osr$/, '');
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n}).osr`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
}

const exists = (file) => fs.access(file).then(() => true, () => false);

module.exports = { parseReplayHeader, findReplay, isLocalBest, replayFileName, freeFileName, exists };
