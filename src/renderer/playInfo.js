// Shared by the app and the in-game overlays: the hit timing of a play, and which of your scores on
// the map is the personal best to compare a play with.

/* exported timingSummary, timingText, hitWindows, rateOf, pickPb, paceOf, fmtPace */

const MIN_TIMING_HITS = 10;
// Mods that change accuracy, so a PB with other ones isn't a fair comparison (as on the leaderboard's mod tabs).
const PB_MODS = ['EZ', 'HT', 'DT', 'HR'];
const PB_MOD_ALIASES = { NC: 'DT', DC: 'HT' };

const rateOf = (mods) => (mods.some((m) => m === 'DT' || m === 'NC') ? 1.5 : mods.some((m) => m === 'HT' || m === 'DC') ? 0.75 : 1);

/**
 * Hit timing from osu!'s hit errors (ms, hit time minus note time, so positive is late), which are
 * in song time: the mean is converted to real time and the unstable rate (10 × standard deviation)
 * is divided by the rate, as osu! shows it.
 */
function timingSummary(hitErrors, mods = []) {
  const errors = Array.isArray(hitErrors) ? hitErrors.filter(Number.isFinite) : [];
  if (errors.length < MIN_TIMING_HITS) return null;
  const rate = rateOf(mods);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const variance = errors.reduce((a, b) => a + (b - mean) ** 2, 0) / errors.length;
  return {
    count: errors.length,
    mean: Math.round((mean / rate) * 10) / 10,
    ur: Math.round(((Math.sqrt(variance) * 10) / rate) * 10) / 10,
    early: errors.filter((e) => e < 0).length,
    late: errors.filter((e) => e > 0).length,
  };
}

/** "3.2 ms late", "1.0 ms early" or "on time". */
function timingText(mean) {
  if (Math.abs(mean) < 0.5) return 'on time';
  return `${Math.abs(mean).toFixed(1)} ms ${mean > 0 ? 'late' : 'early'}`;
}

/** osu!stable's mania hit windows (ms either side) for an OD, in song time. */
function hitWindows(od) {
  const o = Number.isFinite(od) ? od : 8;
  return { max: 16, 300: 64 - 3 * o, 200: 97 - 3 * o, 100: 127 - 3 * o, 50: 151 - 3 * o };
}

const pbModKey = (mods) => {
  const set = new Set(mods.map((m) => PB_MOD_ALIASES[m] ?? m));
  return PB_MODS.filter((m) => set.has(m)).join('');
};

/**
 * The PB to compare a play with: your best score on the map with the same mods that change
 * accuracy (DT, HT, EZ, HR), or your best score overall if there's none. `scores` are best first.
 * Returns { accuracy (percent), mods, sameMods } or null.
 */
function pickPb(scores, playMods) {
  if (!Array.isArray(scores) || scores.length === 0) return null;
  const key = pbModKey(playMods ?? []);
  const same = scores.find((s) => pbModKey(s.mods ?? []) === key);
  const pb = same ?? scores[0];
  return { accuracy: pb.accuracy * 100, mods: pb.mods ?? [], sameMods: Boolean(same) };
}

/** Accuracy of a play (percent) against the PB's: positive is ahead. */
function paceOf(accuracy, pb) {
  return pb && Number.isFinite(accuracy) ? accuracy - pb.accuracy : null;
}

function fmtPace(pace) {
  const rounded = Math.round(pace * 100) / 100;
  return `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)}%`;
}
