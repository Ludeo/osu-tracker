// Dan level estimate for 4K regular (rice) charts, following the method mania-tracker.com publishes
// (https://mania-tracker.com/dan-estimates): every chart gets a dan level, each pass is credited
// that level adjusted by its accuracy against a 96% bar, each skill's dan is the average of its 20
// best passes, and the dan is the average of the skills. Passes of the REFORM dan courses and their
// skillset practice charts set a floor.
//
// mania-tracker.com rates charts with its own estimator; here a chart's level comes from its
// MinaCalc MSD instead, through a table fitted to the levels mania-tracker.com gives about 1,800
// charts (October 2026). A single chart's level is typically off by about half a dan, but they
// mostly average out: on eight players from dan 4 to 16, the overall estimate was within 0.4 of
// mania-tracker.com's on average, a single skill within 0.7.

// Overall MSD at the play's rate -> dan, interpolated linearly (and extended past the ends).
const MSD_TO_DAN = [
  [8, 1.63], [12, 2.0], [14, 2.28], [16, 2.68], [18, 3.88], [20, 5.22], [22, 6.88],
  [24, 8.59], [26, 10.71], [28, 12.49], [30, 14.03], [33, 14.68], [40, 17.23],
];
const LN_WEIGHT = 0.35; // dan added per share of hold notes
const LN_CHART_SHARE = 0.45; // charts with more holds are on the LN ladder, which isn't estimated

const BAR = 0.96;
const BELOW_BAR = 0.05; // passes down to 91% still count, for less
// Credit above and below the bar: [share of the way to 100% / to 91%, dan added].
const ABOVE = [[0, 0], [0.25, 0], [0.675, 0.2], [0.75, 0.7], [0.875, 1.1], [1, 1.5]];
const BELOW = [[0, 0], [0.2, -0.5075], [0.8, -1.25], [1, -1.5]];
const MIN_OD = 5.5;
const WINDOW = 20; // best passes averaged per skill
const QUORUM = 4; // passes a skill needs to count
const OUTLIER_GAP = 5; // passes this far below the best five's average are left out, up to three
const RATES_PER_CHART = 2;

const SKILLS = ['jack', 'tech', 'speed', 'stamina'];
// A chart's skill: the one whose MSD skillsets stand out most against its overall, with a small
// bias fitted to match the skills mania-tracker.com picks (they agree on about 80% of charts).
const SKILL_SOURCES = {
  jack: { skillsets: ['jackspeed', 'chordjack'], bias: 0.04 },
  tech: { skillsets: ['technical'], bias: 0.02 },
  speed: { skillsets: ['stream'], bias: 0 },
  stamina: { skillsets: ['handstream', 'stamina', 'jumpstream'], bias: 0 },
};

const LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];

// Dan ~ REFORM ~ courses (1st to Eta) by Thaumiel and Emik03, and the skillset practice charts by
// yzuio: beatmap ID -> [level, skill (null for the courses)].
const COURSES = new Map([
  [2259503, 1], [2259504, 2], [2259505, 3], [2259506, 4], [2259507, 5], [2588623, 6], [2259540, 6],
  [2259541, 7], [2259542, 8], [2259543, 9], [2259539, 10], [2259544, 11], [2259545, 12], [2259548, 13],
  [2259546, 14], [2259547, 15], [2738788, 16], [4123991, 16], [2738787, 17],
].map(([id, level]) => [id, [level, null]]));
const PRACTICE = {
  jack: [4961192, 4961190, 4961188, 4961185, 4961189, 4961195, 4961191, 4961197, 4961184, 4961196, 4961186, 4961193, 4961183, 4961182, 4961194],
  speed: [4969885, 4969886, 4969876, 4969884, [4969882, 4969888], [4969878, 4969887], 4969877, 4969889, 4969875, 4969881, 4969879, 4969874, 4969883, 4969890, 4969880],
  stamina: [4961718, 4961710, 4961719, 4961706, 4961709, 4961716, 4961714, 4961707, 4961711, 4961708, 4961715, 4961717, 4961720, 4961712, 4961713],
  tech: [4961239, 4961238, 4961233, 4961230, 4961227, 4961237, 4961240, 4961235, 4961228, 4961236, 4961234, 4961226, 4961231, 4961229, 4961232],
};
for (const [skill, ids] of Object.entries(PRACTICE)) {
  ids.forEach((entry, i) => [entry].flat().forEach((id) => COURSES.set(id, [i + 1, skill])));
}
// Mods that void a course run: anything easier or slower.
const COURSE_VOIDING_MODS = new Set(['EZ', 'NF', 'HT', 'DC']);

/** Piecewise-linear interpolation through [x, y] points; the end segments extend past the ends. */
function interpolate(points, x) {
  let i = points.findIndex(([px]) => px >= x);
  if (i === -1) i = points.length - 1;
  else if (i === 0) i = 1;
  const [[x0, y0], [x1, y1]] = [points[i - 1], points[i]];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** A chart's dan from its MSD at the rate played, or null if it's on the LN ladder. */
function chartDan(msd, lnShare = 0) {
  if (!(msd?.overall > 0) || lnShare >= LN_CHART_SHARE) return null;
  return Math.max(0, interpolate(MSD_TO_DAN, msd.overall) + LN_WEIGHT * lnShare);
}

/** The skill a chart counts towards, from its MSD per skillset. */
function chartSkill(msd) {
  const score = (skill) => Math.max(...SKILL_SOURCES[skill].skillsets.map((s) => msd[s] ?? 0)) / msd.overall + SKILL_SOURCES[skill].bias;
  return SKILLS.reduce((best, skill) => (score(skill) > score(best) ? skill : best));
}

/** Dan credited for a pass: the chart's level, plus a bonus above the bar or less below it. Null below 91%. */
function credit(accuracy, dan, skill) {
  const over = accuracy - BAR;
  if (over < -BELOW_BAR - 1e-9) return null;
  if (over < 0) return dan + interpolate(BELOW, Math.min(1, -over / BELOW_BAR));
  // Very high accuracy is normal on jack charts, so the bonus is halved there.
  return dan + interpolate(ABOVE, Math.min(1, over / (1 - BAR))) * (skill === 'jack' ? 0.5 : 1);
}

/** "4", "7+", "alpha--": the level a raw dan is closest to and which fifth of it. */
function danLabel(raw) {
  const level = Math.max(1, Math.min(LEVELS.length, Math.round(raw)));
  const step = Math.max(-2, Math.min(2, Math.round((raw - level) / 0.2)));
  return LEVELS[level - 1] + (step < 0 ? '-'.repeat(-step) : '+'.repeat(step));
}

/** A course pass's dan by accuracy: the course's level at 96%, + at 97.5%, ++ at 98%, - at 95%, -- at 94%. */
function courseTier(accuracy) {
  if (accuracy >= 0.98) return 0.4;
  if (accuracy >= 0.975) return 0.2;
  if (accuracy >= BAR) return 0;
  if (accuracy >= 0.95) return -0.2;
  if (accuracy >= 0.94) return -0.4;
  return null;
}

const effectiveOd = (od, mods) => (mods.includes('HR') ? Math.min(od * 1.4, 10) : mods.includes('EZ') ? od / 2 : od);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const brief = (p, extra) => ({ beatmapId: p.beatmapId, title: p.title, version: p.version, mods: p.mods, accuracy: p.accuracy, ...extra });

/**
 * The dan estimate from rated passes (profile.js's ratePlay results, which carry the chart's MSD per
 * skillset at the rate played, its hold share and OD). Null if there are no 4K regular passes.
 */
function estimateDan(plays) {
  // Each pass's credit; per chart, the best pass at each rate and only the two best rates count.
  const byChart = new Map();
  let course = null;
  const practice = {};
  for (const p of plays) {
    const accuracy = p.accuracy;
    const level = COURSES.get(p.beatmapId);
    if (level && !p.mods.some((m) => COURSE_VOIDING_MODS.has(m))) {
      const [courseLevel, skill] = level;
      const tier = courseTier(accuracy);
      if (tier != null && (skill == null || accuracy >= BAR - 0.01)) {
        // Practice charts set a skill to their level, or one step under it just below the bar.
        const raw = courseLevel + (skill == null ? tier : Math.min(0, tier));
        const target = skill == null ? course : practice[skill];
        if (!(target?.raw >= raw)) {
          const found = brief(p, { raw, level: danLabel(raw) });
          if (skill == null) course = found;
          else practice[skill] = found;
        }
      }
    }
    const dan = chartDan(p.msds, p.lnShare);
    if (dan == null || !(accuracy > 0) || effectiveOd(p.od ?? 8, p.mods) < MIN_OD) continue;
    const skill = chartSkill(p.msds);
    const credited = credit(accuracy, dan, skill);
    if (credited == null) continue;
    const key = p.beatmapId > 0 ? `b${p.beatmapId}` : `c${p.checksum}`;
    const rates = byChart.get(key) ?? new Map();
    if (!(rates.get(p.rate)?.credited >= credited)) rates.set(p.rate, brief(p, { rate: p.rate, skill, chartDan: dan, credited }));
    byChart.set(key, rates);
  }
  const passes = [...byChart.values()].flatMap((rates) => [...rates.values()]
    .sort((a, b) => b.credited - a.credited).slice(0, RATES_PER_CHART));
  if (passes.length === 0 && !course) return null;

  const skills = {};
  for (const skill of SKILLS) {
    let list = passes.filter((p) => p.skill === skill).sort((a, b) => b.credited - a.credited);
    const floor = practice[skill] ?? null;
    if (list.length < QUORUM && !floor) continue;
    const bestFive = mean(list.slice(0, 5).map((p) => p.credited));
    const outliers = list.filter((p) => p.credited < bestFive - OUTLIER_GAP).slice(0, 3);
    list = list.filter((p) => !outliers.includes(p)).slice(0, WINDOW);
    const average = list.length >= QUORUM ? mean(list.map((p) => p.credited)) : 0;
    const raw = Math.max(average, floor?.raw ?? 0);
    skills[skill] = { raw, label: danLabel(raw), passes: list.length, top: list.slice(0, 5), floor: floor && floor.raw >= average ? floor : null };
  }
  const rated = Object.values(skills);
  let raw = rated.length >= 2
    ? mean(rated.map((s) => s.raw))
    : mean(passes.map((p) => p.credited).sort((a, b) => b - a).slice(0, WINDOW));
  const floor = course && !(raw > course.raw) ? course : null;
  raw = Math.max(Number.isFinite(raw) ? raw : 0, course?.raw ?? 0);
  return { raw, label: danLabel(raw), skills, passes: passes.length, course: floor };
}

module.exports = { estimateDan, chartDan, chartSkill, credit, danLabel, SKILLS };
