// Minimal osu! API v2 client using the client-credentials grant (public scope).
// Docs: https://osu.ppy.sh/docs/index.html

const BASE_URL = 'https://osu.ppy.sh';
// Opt into the current score format (statistics.perfect/great/..., total_score, legacy_total_score).
const API_VERSION = '20240529';

class OsuApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class OsuApi {
  constructor() {
    this.clientId = '';
    this.clientSecret = '';
    this.token = null;
    this.tokenExpiresAt = 0;
    this.userCache = new Map(); // lowercased username -> user
    this.rateLimit = null; // { limit, remaining, at } from the last response's headers
    this.onRateLimit = () => {};
  }

  updateRateLimit(res) {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const remaining = res.status === 429 ? 0 : Number(res.headers.get('x-ratelimit-remaining'));
    if (!limit || !Number.isFinite(remaining)) return;
    this.rateLimit = { limit, remaining, at: Date.now() };
    this.onRateLimit(this.rateLimit);
  }

  setCredentials(clientId, clientSecret) {
    clientId = String(clientId || '').trim();
    clientSecret = String(clientSecret || '').trim();
    if (clientId === this.clientId && clientSecret === this.clientSecret) return;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get hasCredentials() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.hasCredentials) {
      throw new OsuApiError('osu! API credentials are not set. Open the settings and add your OAuth client ID and secret.', 0);
    }

    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: Number(this.clientId) || this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
    });
    if (!res.ok) {
      throw new OsuApiError(`Could not authenticate with the osu! API (HTTP ${res.status}). Check your client ID and secret.`, res.status);
    }
    const body = await res.json();
    this.token = body.access_token;
    // Refresh a minute early to avoid using a token right as it expires.
    this.tokenExpiresAt = Date.now() + (body.expires_in - 60) * 1000;
    return this.token;
  }

  async request(pathname, { allow404 = false, retried = false } = {}) {
    const token = await this.getToken();
    const res = await fetch(`${BASE_URL}/api/v2${pathname}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'x-api-version': API_VERSION,
      },
    });
    this.updateRateLimit(res);

    if (res.status === 401 && !retried) {
      this.token = null;
      return this.request(pathname, { allow404, retried: true });
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 429) throw new OsuApiError('osu! API rate limit reached. Try again in a minute.', 429);
    if (!res.ok) throw new OsuApiError(`osu! API request failed (HTTP ${res.status}) for ${pathname}`, res.status);
    return res.json();
  }

  async getUser(username) {
    const key = username.trim().toLowerCase();
    if (!key) return null;
    if (this.userCache.has(key)) return this.userCache.get(key);

    const raw = await this.request(`/users/@${encodeURIComponent(username.trim())}/mania`, { allow404: true });
    if (!raw) return null;
    const user = {
      id: raw.id,
      username: raw.username,
      avatarUrl: raw.avatar_url,
      countryCode: raw.country_code,
      // osu! stable only opens osu://b links in game (osu!direct) for supporters.
      supporter: Boolean(raw.is_supporter),
    };
    this.userCache.set(key, user);
    this.userCache.set(user.username.toLowerCase(), user);
    return user;
  }

  /** The player's current osu!mania pp and ranks. Not cached, since they change with every play. */
  async getUserStats(userId) {
    const raw = await this.request(`/users/${userId}/mania`, { allow404: true });
    const stats = raw?.statistics;
    if (!stats) return null;
    return {
      pp: stats.pp ?? null,
      globalRank: stats.global_rank ?? null,
      countryRank: stats.country_rank ?? null,
      playCount: stats.play_count ?? null,
    };
  }

  /** The player's osu!mania plays of the last 24 hours, failed ones included, latest first (raw scores). */
  async getRecentScores(userId) {
    return (await this.request(`/users/${userId}/scores/recent?mode=mania&include_fails=1&limit=100`, { allow404: true })) ?? [];
  }

  async lookupBeatmapByChecksum(checksum) {
    if (!checksum) return null;
    return this.request(`/beatmaps/lookup?checksum=${encodeURIComponent(checksum)}`, { allow404: true });
  }

  /**
   * A user's top osu!mania plays, best first, with the beatmap each was set on. The API returns at
   * most 100 per request and 200 in total.
   */
  async getBestScores(userId, limit = 200) {
    const scores = [];
    while (scores.length < limit) {
      const count = Math.min(100, limit - scores.length);
      const page = await this.request(`/users/${userId}/scores/best?mode=mania&limit=${count}&offset=${scores.length}`);
      scores.push(...page);
      if (page.length < count) break;
    }
    return scores.map((s) => ({
      ...normalizeScore(s),
      beatmap: {
        id: s.beatmap?.id ?? 0,
        checksum: s.beatmap?.checksum ?? '',
        keys: s.beatmap?.cs ?? null,
        convert: Boolean(s.beatmap?.convert),
        version: s.beatmap?.version ?? '',
        stars: s.beatmap?.difficulty_rating ?? null,
      },
      beatmapset: { title: s.beatmapset?.title ?? '', artist: s.beatmapset?.artist ?? '' },
    }));
  }

  /**
   * Ranked status, current checksum and what pp needs (nomod stars, OD, note count) of beatmaps,
   * 50 IDs per request.
   */
  async getBeatmapInfo(ids) {
    const result = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const query = ids.slice(i, i + 50).map((id) => `ids[]=${id}`).join('&');
      const { beatmaps } = await this.request(`/beatmaps?${query}`);
      for (const b of beatmaps ?? []) {
        result.set(b.id, {
          status: b.status,
          checksum: b.checksum,
          stars: b.difficulty_rating,
          od: b.accuracy,
          hits: (b.count_circles ?? 0) + (b.count_sliders ?? 0),
        });
      }
    }
    return result;
  }

  /**
   * All osu!mania scores of a user on a beatmap (one per mod combination), best first.
   *
   * The API's "best score" endpoint ranks by lazer's standardised total_score, which can pick a
   * different score than stable's leaderboard (ranked by classic score), so the order here comes
   * from compareScores. The global position only comes from the best-score endpoint and is
   * attached to whichever score it refers to.
   */
  async getUserScores(beatmapId, userId) {
    const [all, best] = await Promise.all([
      this.request(`/beatmaps/${beatmapId}/scores/users/${userId}/all?mode=mania`, { allow404: true }),
      this.request(`/beatmaps/${beatmapId}/scores/users/${userId}?mode=mania`, { allow404: true }),
    ]);

    return (all?.scores ?? [])
      .map((s) => ({ position: best?.score?.id === s.id ? best.position ?? null : null, ...normalizeScore(s) }))
      .sort(compareScores);
  }
}

function normalizeScore(s) {
  const st = s.statistics || {};
  const pick = (...values) => values.find((v) => typeof v === 'number') ?? 0;
  const stats = {
    max: pick(st.perfect, st.count_geki),
    300: pick(st.great, st.count_300),
    200: pick(st.good, st.count_katu),
    100: pick(st.ok, st.count_100),
    50: pick(st.meh, st.count_50),
    miss: pick(st.miss, st.count_miss),
  };
  const mods = (s.mods || []).map((m) => (typeof m === 'string' ? m : m.acronym));
  const accuracy = stableAccuracy(stats) ?? s.accuracy ?? 0;
  return {
    id: s.id,
    // Players on stable see the classic score, lazer-only scores only have total_score.
    score: s.legacy_total_score || s.total_score || s.score || 0,
    accuracy,
    maxCombo: s.max_combo ?? 0,
    // The API's rank follows lazer's accuracy, so derive it from the stable accuracy instead.
    rank: s.passed === false ? 'F' : stableRank(accuracy, mods),
    pp: s.pp ?? null,
    mods,
    date: s.ended_at || s.created_at || null,
    stats,
  };
}

/**
 * osu!stable's mania accuracy (0..1): MAX and 300 are both worth 300. The API reports lazer's
 * accuracy, which weights MAX at 305 and so comes out lower for the same judgements.
 */
function stableAccuracy(stats) {
  const hits = stats.max + stats[300] + stats[200] + stats[100] + stats[50] + stats.miss;
  if (!hits) return null;
  return (300 * (stats.max + stats[300]) + 200 * stats[200] + 100 * stats[100] + 50 * stats[50]) / (300 * hits);
}

/** osu!stable's mania grade for an accuracy; HD/FL/FI turn S and SS silver. */
function stableRank(accuracy, mods) {
  const silver = mods.some((m) => m === 'HD' || m === 'FL' || m === 'FI');
  if (accuracy >= 1) return silver ? 'XH' : 'X';
  if (accuracy > 0.95) return silver ? 'SH' : 'S';
  if (accuracy > 0.9) return 'A';
  if (accuracy > 0.8) return 'B';
  if (accuracy > 0.7) return 'C';
  return 'D';
}

/** Sort order for normalized scores: higher score first, then higher pp, then the earlier one. */
function compareScores(a, b) {
  return b.score - a.score || (b.pp ?? 0) - (a.pp ?? 0) || new Date(a.date) - new Date(b.date);
}

module.exports = { OsuApi, OsuApiError, compareScores, normalizeScore, stableAccuracy };
