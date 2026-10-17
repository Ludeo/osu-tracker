// osu!mania pp for a target (stable) accuracy.
//
// Mania pp depends on how the hits are spread over the judgements, not on accuracy alone: it uses
// an accuracy where MAX is worth 320 and 300 is worth 300. tosu fills a target accuracy with only
// MAX and 50s, which nobody plays like and overestimates pp by ~20%. Here the hits are instead
// modelled as timing errors following a Laplace distribution (heavier tailed than a normal one,
// which matches real plays' share of MAX and misses well), scaled until stable accuracy matches.

// Legacy mod bits that change the pp multiplier.
const NF = 1;
const EZ = 2;

/** stable's mania hit windows in ms (±), MAX through 50. */
function hitWindows(od) {
  return [16, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od];
}

/** Share of hits per judgement (MAX, 300, 200, 100, 50, miss) for a Laplace error scale `b`. */
function judgementShares(windows, b) {
  const within = windows.map((w) => 1 - Math.exp(-w / b));
  return [...within.map((p, i) => p - (within[i - 1] ?? 0)), 1 - within[within.length - 1]];
}

const stableAccuracy = ([max, n300, n200, n100, n50]) => (300 * (max + n300) + 200 * n200 + 100 * n100 + 50 * n50) / 300;
const ppAccuracy = ([max, n300, n200, n100, n50]) => (320 * max + 300 * n300 + 200 * n200 + 100 * n100 + 50 * n50) / 320;

/** Judgement shares that give `accuracy` (0..1) in stable, found by bisecting the error scale. */
function sharesForAccuracy(od, accuracy) {
  const windows = hitWindows(od);
  if (accuracy >= 1) return [1, 0, 0, 0, 0, 0];
  let lo = 0.01;
  let hi = 1000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (stableAccuracy(judgementShares(windows, mid)) > accuracy) lo = mid;
    else hi = mid;
  }
  return judgementShares(windows, lo);
}

/** osu!'s ManiaPerformanceCalculator. `hits` is stable's judgement count (one per hold note). */
function maniaPp({ stars, hits, accuracy, mods }) {
  let multiplier = 1;
  if (mods & NF) multiplier *= 0.75;
  if (mods & EZ) multiplier *= 0.5;
  return 8 * Math.max(stars - 0.15, 0.05) ** 2.2
    * Math.max(0, 5 * accuracy - 4)
    * (1 + 0.1 * Math.min(1, hits / 1500))
    * multiplier;
}

/** Estimated pp at each stable accuracy in `accuracies` (percent). */
function ppByAccuracy({ stars, hits, od, mods, accuracies }) {
  return Object.fromEntries(accuracies.map((acc) => [
    acc,
    maniaPp({ stars, hits, mods, accuracy: ppAccuracy(sharesForAccuracy(od, acc / 100)) }),
  ]));
}

module.exports = { ppByAccuracy, maniaPp };
