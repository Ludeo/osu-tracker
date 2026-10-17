// Skill profile from a player's plays, rated the way Etterna rates players: each play gets a score
// rating (SSR) per skillset from MinaCalc, and the best SSRs per map are aggregated per skillset.

const { toRows, MANIA_MODE } = require('./osuFile');
const { rateChart, SKILLSETS } = require('./minacalc');

/** Error function, Abramowitz & Stegun 7.1.26 (max error 1.5e-7). */
function erf(x) {
  const sign = Math.sign(x);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-x * x));
}

/** Etterna's Wife3 points (-5.5..2) for a hit `ms` off, on judge 4. */
function wife3(ms) {
  const zero = 65;
  const dev = 22.7;
  const maxBooWeight = 180;
  const missWeight = -5.5;
  if (ms <= 5) return 2;
  if (ms <= zero) return 2 * erf((zero - ms) / dev);
  if (ms <= maxBooWeight) return ((ms - zero) * missWeight) / (maxBooWeight - zero);
  return missWeight;
}

/**
 * Estimated Wife accuracy (0..1) of an osu!mania play. Judgements only tell which hit window a
 * hit landed in, so each is assumed to be a bit inside its window: osu!stable's windows for the
 * map's OD, with HR and EZ applied.
 */
function estimateWife(stats, od, mods) {
  if (mods.includes('HR')) od = Math.min(od * 1.4, 10);
  if (mods.includes('EZ')) od /= 2;
  const windows = [16, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od];
  const offset = (i) => (i === 0 ? windows[0] * 0.5 : windows[i - 1] + (windows[i] - windows[i - 1]) * 0.4);
  const counts = [stats.max, stats[300], stats[200], stats[100], stats[50]];
  const hits = counts.reduce((a, b) => a + b, 0) + stats.miss;
  if (!hits) return 0;
  const points = counts.reduce((sum, count, i) => sum + count * wife3(offset(i)), 0) + stats.miss * -5.5;
  return Math.max(0, points / (2 * hits));
}

/**
 * Etterna's player rating for one skillset: the lowest rating at which the SSRs no longer add up
 * to more than 2^(rating / 10), found by successive halving.
 */
function aggregateRatings(ssrs, rating = 0, step = 10.24, iteration = 1) {
  let sum;
  do {
    rating += step;
    sum = 0;
    for (const ssr of ssrs) sum += Math.max(0, 2 / (1 - erf(0.1 * (ssr - rating))) - 2);
  } while (2 ** (rating * 0.1) < sum);
  if (iteration === 11) return rating;
  return aggregateRatings(ssrs, rating - step, step / 2, iteration + 1);
}

const rateOfMods = (mods) => (mods.some((m) => m === 'DT' || m === 'NC') ? 1.5 : mods.some((m) => m === 'HT' || m === 'DC') ? 0.75 : 1);

// Rated plays by play, so rebuilding the profile with new plays only rates those. null means the
// chart can't be rated (not 4K mania).
const ratedPlays = new Map();

const playKey = (play) => [play.beatmap.id, play.beatmap.checksum, play.mods.join(''), JSON.stringify(play.stats)].join('|');

/**
 * MinaCalc rating of one play (shaped like OsuApi.getBestScores' plays): its SSR per skillset at
 * the estimated Wife accuracy and the chart's overall MSD at the play's rate. `loadChart(play)`
 * returns the parsed .osu file. Null if the chart isn't 4K osu!mania.
 */
async function ratePlay(play, loadChart) {
  const key = playKey(play);
  if (ratedPlays.has(key)) return ratedPlays.get(key);
  const chart = await loadChart(play);
  let rated = null;
  if (chart.mode === MANIA_MODE && chart.keys === 4 && chart.notes.length >= 2) {
    const wife = estimateWife(play.stats, chart.od, play.mods);
    const rate = rateOfMods(play.mods);
    const rows = toRows(chart.notes);
    const msds = await rateChart(rows, { rate });
    rated = {
      beatmapId: play.beatmap.id,
      checksum: play.beatmap.checksum || chart.checksum || '',
      title: play.beatmapset.title,
      version: play.beatmap.version,
      stars: play.beatmap.stars,
      mods: play.mods,
      accuracy: play.accuracy,
      pp: play.pp,
      source: play.source ?? 'top',
      date: play.date ?? null,
      wife,
      rate,
      ssr: await rateChart(rows, { rate, goal: wife }),
      msd: msds.overall,
      // For the dan estimate (dan.js).
      msds,
      lnShare: chart.notes.filter((n) => n.isHold).length / chart.notes.length,
      od: chart.od,
    };
  }
  ratedPlays.set(key, rated);
  return rated;
}

/**
 * Rates `plays` (shaped like OsuApi.getBestScores' plays, from any source) and aggregates them
 * into a rating per skillset. Like Etterna, only the best play on each map counts. `loadChart(play)`
 * returns the play's parsed .osu file. `passes` are all the rated plays.
 */
async function buildProfile(plays, loadChart, onProgress = () => {}) {
  const best = new Map(); // map -> its best rated play
  const passes = []; // every rated play, for the dan estimate
  let done = 0;
  for (const play of plays) {
    onProgress({ done: done++, total: plays.length });
    try {
      const rated = await ratePlay(play, loadChart);
      if (!rated) continue;
      passes.push(rated);
      const map = rated.beatmapId > 0 ? `b${rated.beatmapId}` : `c${rated.checksum}`;
      if (!(best.get(map)?.ssr.overall >= rated.ssr.overall)) best.set(map, rated);
    } catch {
      // Map file unavailable; leave the play out.
    }
  }
  onProgress({ done: plays.length, total: plays.length });

  const rated = [...best.values()];
  const ratings = Object.fromEntries(SKILLSETS.map((s) => [s, aggregateRatings(rated.map((p) => p.ssr[s]))]));
  const sources = {};
  for (const p of rated) sources[p.source] = (sources[p.source] ?? 0) + 1;
  return { ratings, plays: rated, passes, sources };
}

const FALLBACK_SLOPE = -0.01; // accuracy lost per MSD above the player's rating

/**
 * Accuracy (0..1) of a good play on a chart, given how far its overall MSD is above the player's
 * overall rating. A straight line fitted to the player's top plays, kept within their accuracies.
 */
function accuracyModel(plays, rating) {
  const points = plays.filter((p) => p.msd > 0 && p.accuracy > 0).map((p) => [p.msd - rating, p.accuracy]);
  const accs = points.map(([, acc]) => acc).sort((a, b) => a - b);
  if (points.length < 10) return () => null;
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const mx = mean(points.map(([x]) => x));
  const my = mean(accs);
  const sxx = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  let slope = sxx > 0 ? points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx : FALLBACK_SLOPE;
  if (!(slope < 0)) slope = FALLBACK_SLOPE;
  const low = accs[Math.floor(accs.length * 0.1)];
  const high = accs[Math.floor(accs.length * 0.9)];
  return (gap) => Math.min(high, Math.max(low, my + slope * (gap - mx)));
}

module.exports = { buildProfile, ratePlay, rateOfMods, estimateWife, aggregateRatings, accuracyModel };
