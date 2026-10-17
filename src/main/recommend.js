// Picks maps from the local library for a skill profile.
//
// Raw skillset values aren't comparable across skillsets: MinaCalc rates almost every chart close
// to its overall value in Stamina and Technical, and far below it in Jackspeed. So a chart's
// "specialty" in a skillset is its share of the overall value relative to the median share over
// the library. The player's strengths are simply their highest ratings.

const FOCUS_SKILLSETS = ['stream', 'jumpstream', 'handstream', 'stamina', 'jackspeed', 'chordjack', 'technical'];
const MAX_LN_SHARE = 0.3; // MinaCalc underrates LN-heavy maps, so they're left out
const MAX_PER_SET = 2;
const LIMIT = 30;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
};

const LEVEL_BAND = 3; // shares are taken from charts within this much MSD of the player's level
const MIN_BAND_CHARTS = 50;

/** Median share of the overall value per skillset, over charts near `level` (all if too few). */
function typicalShares(charts, level) {
  const rated = charts.filter((c) => c.msd.overall > 0);
  const near = rated.filter((c) => Math.abs(c.msd.overall - level) <= LEVEL_BAND);
  const pool = near.length >= MIN_BAND_CHARTS ? near : rated;
  return Object.fromEntries(FOCUS_SKILLSETS.map((s) => [s, median(pool.map((c) => c.msd[s] / c.msd.overall))]));
}

const specialty = (msd, skill, shares) => msd[skill] / msd.overall / shares[skill];

/** The player's two highest-rated skillsets and the lowest-rated one. */
function analyseProfile(ratings) {
  const order = [...FOCUS_SKILLSETS].sort((a, b) => ratings[b] - ratings[a]);
  return { strengths: order.slice(0, 2), weakest: order[order.length - 1] };
}

/**
 * Recommended charts. `focus` is 'fit' (maps around your level that play to your strengths, for
 * pp), 'warmup' (easier maps of any kind, to warm up on), 'pp' (any maps around your level, to be
 * ranked by expected pp) or a skillset to train (maps that specialise in it, slightly above your
 * rating in it).
 */
function recommend({ charts, ratings, focus, exclude, limit = LIMIT }) {
  const shares = typicalShares(charts, ratings.overall);
  const { strengths } = analyseProfile(ratings);
  const train = FOCUS_SKILLSETS.includes(focus);
  const skills = focus === 'fit' ? strengths : train ? [focus] : FOCUS_SKILLSETS;  // Level each chart is judged by, and the band and target around the player's rating in it.
  const level = (c, skill) => (train ? c.msd[skill] : c.msd.overall);
  const rating = train ? ratings[focus] : ratings.overall;
  const [low, high, target] = {
    fit: [rating - 1.5, rating + 0.75, rating - 0.25],
    // Comfortably below your level, so the maps are easy to pass while you get your timing in.
    warmup: [rating * 0.72, rating * 0.9, rating * 0.82],
    // Candidates only: main.js keeps the ones whose expected pp would enter your top plays.
    pp: [rating - 2, rating + 1, rating],
  }[focus] ?? [rating - 1, rating + 1.5, rating + 0.25];

  const scored = [];
  for (const chart of charts) {
    if (exclude.has(chart.checksum) || chart.lnShare > MAX_LN_SHARE || !(chart.msd.overall > 0)) continue;
    // The chart's two most pronounced skillsets; the focus has to be one of them.
    const tags = [...FOCUS_SKILLSETS].sort((a, b) => specialty(chart.msd, b, shares) - specialty(chart.msd, a, shares)).slice(0, 2);
    const skill = tags.find((t) => skills.includes(t));
    if (!skill) continue;
    const spec = specialty(chart.msd, skill, shares);
    const value = level(chart, skill);
    if (value < low || value > high) continue;
    if (focus === 'warmup' || focus === 'pp') {
      scored.push({ chart, tags, skill, value, score: Math.abs(value - target) });
      continue;
    }
    if (spec < 1) continue;
    scored.push({ chart, tags, skill, value, score: Math.abs(value - target) - 2 * (spec - 1) });
  }
  scored.sort((a, b) => a.score - b.score);

  const perSet = new Map();
  const seen = new Set(); // the same map can be in the Songs folder twice
  const result = [];
  for (const { chart, tags, skill, value } of scored) {
    const setKey = chart.setId || chart.path.split(/[\\/]/)[0];
    if (seen.has(chart.checksum) || (perSet.get(setKey) ?? 0) >= MAX_PER_SET) continue;
    seen.add(chart.checksum);
    perSet.set(setKey, (perSet.get(setKey) ?? 0) + 1);
    result.push({
      title: chart.title,
      artist: chart.artist,
      version: chart.version,
      creator: chart.creator,
      beatmapId: chart.beatmapId,
      setId: chart.setId,
      source: chart.source,
      status: chart.status ?? null,
      checksum: chart.checksum,
      msd: chart.msd,
      skill,
      value,
      tags,
    });
    if (result.length >= limit) break;
  }
  return result;
}

module.exports = { recommend, analyseProfile, FOCUS_SKILLSETS, LIMIT };
