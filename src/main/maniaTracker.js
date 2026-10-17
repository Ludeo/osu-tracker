// Public data from mania-tracker.com, which tracks osu!mania players' plays (also the ones that
// never make it into the osu! API's top 200) and rates them with MinaCalc. Only the osu! user ID is
// sent. Players the site doesn't track get empty results.

const BASE_URL = 'https://api.mania-tracker.com/api';
const CACHE_MS = 10 * 60 * 1000;
// skill-plays returns a player's 200 best plays per skillset; together they cover every play that
// counts towards a rating.
const AXES = ['Overall', 'Stream', 'Jumpstream', 'Handstream', 'Stamina', 'JackSpeed', 'Chordjack', 'Technical'];
// mania-tracker.com's skillset names -> the ones used in this app (minacalc.js).
const SKILLSET_KEYS = {
  Overall: 'overall', Stream: 'stream', Jumpstream: 'jumpstream', Handstream: 'handstream',
  Stamina: 'stamina', JackSpeed: 'jackspeed', Chordjack: 'chordjack', Technical: 'technical',
};

const cache = new Map(); // path -> { at, promise }

function get(pathname) {
  const hit = cache.get(pathname);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = fetch(`${BASE_URL}${pathname}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`mania-tracker.com: HTTP ${res.status}`);
    return res.json();
  });
  cache.set(pathname, { at: Date.now(), promise });
  promise.catch(() => cache.delete(pathname));
  return promise;
}

const renameRatings = (ratings) => Object.fromEntries(
  Object.entries(ratings ?? {}).filter(([key]) => SKILLSET_KEYS[key]).map(([key, value]) => [SKILLSET_KEYS[key], value]),
);

/**
 * The player's 4K ratings on mania-tracker.com, with percentiles among the players it tracks and
 * its dan estimate, or null if the site doesn't track them or has no 4K plays rated.
 */
async function getSkills(userId, username) {
  const body = await get(`/profiles/${userId}/skills`);
  const mode = body.modes?.find((m) => m.keyCount === 4);
  if (!body.tracked || !mode || !(mode.analyzedPlays > 0)) return null;
  const percentile = mode.percentiles?.Overall;
  const rc = mode.dan?.rc;
  return {
    url: `https://mania-tracker.com/player/${encodeURIComponent(username)}`,
    computedAt: body.computedAt,
    plays: mode.analyzedPlays,
    calcVersion: mode.minaCalc ?? null,
    ratings: renameRatings(mode.ratings),
    // The site shows "top X%" as 100 minus the percentile, at least one player's share.
    top: percentile?.population > 0
      ? { percent: Math.max(100 - percentile.value, 100 / percentile.population), population: percentile.population }
      : null,
    dan: rc
      ? {
        label: rc.label,
        skillsets: Object.fromEntries(Object.entries(rc.skillsets ?? {}).map(([key, s]) => [key, s.label])),
      }
      : null,
  };
}

/**
 * The player's rated 4K plays on mania-tracker.com: one per map, including plays it has tracked
 * that aren't in the osu! API's top 200. Returned like OsuApi.getBestScores' plays.
 */
async function getSkillPlays(userId, normalizeScore) {
  const plays = new Map(); // score ID -> play
  for (const axis of AXES) {
    const body = await get(`/profiles/${userId}/skill-plays?keys=4&axis=${axis}&limit=200&offset=0`);
    for (const item of body.items ?? []) {
      if (plays.has(item.scoreId) || item.keyCount !== 4 || !(item.beatmapId > 0)) continue;
      plays.set(item.scoreId, {
        ...normalizeScore({
          id: item.scoreId,
          statistics: item.score?.statistics,
          mods: item.mods ?? [],
          pp: item.pp,
          max_combo: item.score?.maxCombo,
          legacy_total_score: item.score?.totalScore,
          ended_at: item.playedAt,
        }),
        beatmap: { id: item.beatmapId, checksum: '', keys: 4, convert: false, version: item.version ?? '', stars: null },
        beatmapset: { title: item.title ?? '', artist: item.artist ?? '' },
      });
    }
  }
  return [...plays.values()];
}

/** mania-tracker.com's 4K rating history of the player: [{ at, ratings }], oldest first. */
async function getSkillHistory(userId) {
  const body = await get(`/profiles/${userId}/skill-history?keys=4&series=1`);
  return (body.points ?? [])
    .map((p) => ({ at: p.recordedAt, ratings: renameRatings(p.ratings) }))
    .filter((p) => p.ratings.overall > 0);
}

/** The player's latest plays tracked by mania-tracker.com, as raw osu! API scores. */
async function getRecentScores(userId) {
  const body = await get(`/profiles/${userId}/recent`);
  return Array.isArray(body.payload) ? body.payload : [];
}

module.exports = { getSkills, getSkillPlays, getSkillHistory, getRecentScores };
