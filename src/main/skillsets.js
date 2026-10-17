// Skillset ratings (Etterna MSD) for the map selected in osu!.

const crypto = require('node:crypto');
const { parseOsuFile, toRows, MANIA_MODE } = require('./osuFile');
const { rateChart, calcVersion } = require('./minacalc');

// Legacy mod bits that change the music rate. NC and DC also set the DT and HT bits.
const DT = 64;
const HT = 256;
// Above this share of long notes the rating is unreliable: MinaCalc treats holds as taps.
const LN_HEAVY_SHARE = 0.3;
const CACHE_SIZE = 50;
// The difficulty graph rates overlapping windows of the chart this long (ms of chart time), about
// GRAPH_POINTS of them, at least GRAPH_MIN_STEP apart.
const GRAPH_WINDOW = 10000;
const GRAPH_POINTS = 150;
const GRAPH_MIN_STEP = 1000;

const charts = new Map(); // checksum -> parsed chart, most recently used last

const md5 = (bytes) => crypto.createHash('md5').update(bytes).digest('hex');

async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The .osu file of the selected map: from tosu, which serves the one osu! has loaded, or from
 * osu.ppy.sh for submitted maps. tosu's file is checked against the checksum because the selection
 * may have changed since the request was made.
 */
async function loadChart({ tosuOrigin, checksum, beatmapId }) {
  if (charts.has(checksum)) {
    const chart = charts.get(checksum);
    charts.delete(checksum);
    charts.set(checksum, chart);
    return chart;
  }

  let file = null;
  if (tosuOrigin) {
    const local = await fetchBytes(`${tosuOrigin}/files/beatmap/file`).catch(() => null);
    if (local && md5(local) === checksum) file = local;
  }
  if (!file && beatmapId > 0) file = await fetchBytes(`https://osu.ppy.sh/osu/${beatmapId}`);
  if (!file) throw new Error('Could not read the map file.');

  const chart = parseOsuFile(file.toString('utf8'));
  charts.set(checksum, chart);
  if (charts.size > CACHE_SIZE) charts.delete(charts.keys().next().value);
  return chart;
}

/**
 * Difficulty through the chart: the MSD of the GRAPH_WINDOW around each point, so spikes stand out.
 * Points are { time (ms into the chart at 1.0x), overall, skill (the highest skillset) }; breaks
 * come out as 0.
 */
async function difficultyGraph(notes, rate) {
  const start = notes[0].time;
  const end = notes[notes.length - 1].time;
  const step = Math.max(GRAPH_MIN_STEP, (end - start) / GRAPH_POINTS);
  const points = [];
  let from = 0;
  for (let time = start; time <= end + step / 2; time += step) {
    const lo = time - GRAPH_WINDOW / 2;
    while (from < notes.length && notes[from].time < lo) from++;
    let to = from;
    while (to < notes.length && notes[to].time < lo + GRAPH_WINDOW) to++;
    const window = notes.slice(from, to);
    const msd = new Set(window.map((n) => n.time)).size > 1 ? await rateChart(toRows(window), { rate }) : null;
    const skill = msd ? Object.keys(msd).filter((k) => k !== 'overall').reduce((a, b) => (msd[b] > msd[a] ? b : a)) : null;
    points.push({ time: Math.min(time, end) - start, overall: msd?.overall ?? 0, skill });
  }
  return { length: end - start, points };
}

/**
 * MSD per skillset of the selected map at the rate of `modBits`. Only native 4K osu!mania maps are
 * rated, since MinaCalc is tuned for 4K.
 */
async function mapSkillsets({ tosuOrigin, checksum, beatmapId, modBits }) {
  const chart = await loadChart({ tosuOrigin, checksum, beatmapId });
  if (chart.mode !== MANIA_MODE) return { unsupported: 'Skillsets are only rated for osu!mania maps, not converts.' };
  if (chart.keys !== 4) return { unsupported: `Skillsets are only rated for 4K maps (this one is ${chart.keys}K).` };
  if (chart.notes.length < 2) return { unsupported: 'This map has too few notes to rate.' };

  const rate = modBits & DT ? 1.5 : modBits & HT ? 0.75 : 1;
  const lnShare = chart.notes.filter((n) => n.isHold).length / chart.notes.length;
  return {
    msd: await rateChart(toRows(chart.notes), { rate }),
    graph: await difficultyGraph(chart.notes, rate),
    rate,
    lnShare,
    lnHeavy: lnShare > LN_HEAVY_SHARE,
    calcVersion: await calcVersion(),
  };
}

module.exports = { mapSkillsets };
