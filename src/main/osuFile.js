// Reads the notes of an osu!mania chart from a .osu file.
// Format: https://osu.ppy.sh/wiki/en/Client/File_formats/osu_(file_format)

const MANIA_MODE = 3;
const HOLD_TYPE = 128;

const KEY_VALUE_SECTIONS = new Set(['General', 'Metadata', 'Difficulty']);

/**
 * Parses a .osu file. Returns { mode, keys, od, notes, meta }, where notes are { time, column, isHold }
 * sorted by time (ms) and meta holds the title, artist, version, creator and IDs. Notes are only read for osu!mania charts; converts from other modes would
 * need osu!'s conversion algorithm, so they come back without notes.
 */
function parseOsuFile(text) {
  const values = {};
  const notes = [];
  let section = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }

    if (KEY_VALUE_SECTIONS.has(section)) {
      const colon = line.indexOf(':');
      if (colon > 0) values[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    } else if (section === 'HitObjects' && Number(values.Mode) === MANIA_MODE) {
      const [x, , time, type] = line.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(time)) continue;
      const keys = Number(values.CircleSize);
      notes.push({
        time,
        column: Math.min(Math.max(Math.floor((x * keys) / 512), 0), keys - 1),
        isHold: (type & HOLD_TYPE) !== 0,
      });
    }
  }

  notes.sort((a, b) => a.time - b.time);
  return {
    mode: Number(values.Mode) || 0,
    keys: Number(values.CircleSize) || 0,
    od: Number(values.OverallDifficulty ?? 5),
    notes,
    meta: {
      title: values.Title || values.TitleUnicode || '',
      artist: values.Artist || values.ArtistUnicode || '',
      version: values.Version || '',
      creator: values.Creator || '',
      beatmapId: Number(values.BeatmapID) || 0,
      setId: Number(values.BeatmapSetID) || 0,
    },
  };
}

/**
 * Groups notes into rows for MinaCalc: one entry per distinct time, with a bitmask of the columns
 * hit (bit 0 = leftmost) and the time in seconds, starting at 0 or later.
 */
function toRows(notes) {
  const masks = [];
  const times = [];
  const offset = Math.min(0, notes[0]?.time ?? 0);
  for (const note of notes) {
    const time = (note.time - offset) / 1000;
    if (times.length && times[times.length - 1] === time) masks[masks.length - 1] |= 1 << note.column;
    else {
      masks.push(1 << note.column);
      times.push(time);
    }
  }
  return { masks: Uint32Array.from(masks), times: Float32Array.from(times) };
}

module.exports = { parseOsuFile, toRows, MANIA_MODE };
