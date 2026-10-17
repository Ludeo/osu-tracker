// Local play history, kept in history.json next to the config: every play recorded from tosu (and
// recent plays imported from the osu! API and mania-tracker.com), snapshots of the player's pp and
// rank, and snapshots of the skill profile. Sessions are worked out from the plays.

const fs = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 1;
const SESSION_GAP_MS = 60 * 60 * 1000; // a session ends after an hour without plays
// The same play recorded twice (from tosu and an import) has the same judgements and about the
// same time. A failed attempt's judgements in tosu can differ a little from the submitted ones, so
// a failed attempt from tosu and a failed import are only compared by time.
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const UNFINISHED_DUPLICATE_WINDOW_MS = 3 * 60 * 1000;
const SAME_RATING = 0.005;
const TIMING_PLAYS = 30;
const TIMING_MIN_HITS = 50;
const TIMING_MAX_LN_SHARE = 0.3;

const JUDGEMENTS = ['max', 300, 200, 100, 50, 'miss'];
const time = (iso) => new Date(iso).getTime();
const sameMap = (a, b) => (a.beatmapId > 0 || b.beatmapId > 0 ? a.beatmapId === b.beatmapId : a.checksum === b.checksum);
const sameStats = (a, b) => JUDGEMENTS.every((j) => (a.stats?.[j] ?? 0) === (b.stats?.[j] ?? 0));
const hitCount = (play) => JUDGEMENTS.reduce((sum, j) => sum + (play.stats?.[j] ?? 0), 0);
const stdev = (values) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

class History {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.loading = null;
    this.saving = Promise.resolve();
  }

  async load() {
    this.loading ??= fs.readFile(this.file, 'utf8')
      .then(JSON.parse)
      .catch(() => null)
      .then((data) => {
        this.data = data?.format === FORMAT ? data : { format: FORMAT, plays: [], userStats: [], skills: [] };
      });
    await this.loading;
    return this.data;
  }

  /** Writes the file; writes are queued, and go through a temporary file so a crash can't truncate it. */
  save() {
    this.saving = this.saving.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, JSON.stringify(this.data));
      await fs.rename(temp, this.file);
    }).catch(() => {
      // Kept in memory; the next save tries again.
    });
    return this.saving;
  }

  findDuplicate(play) {
    const at = time(play.at);
    return this.data.plays.find((p) => {
      if (!sameMap(p, play)) return false;
      const apart = Math.abs(time(p.at) - at);
      if (sameStats(p, play)) return apart <= DUPLICATE_WINDOW_MS;
      const [recorded, imported] = p.source === 'tosu' ? [p, play] : [play, p];
      return !p.passed && !play.passed && recorded.source === 'tosu' && imported.source !== 'tosu' && !recorded.scoreId
        && apart <= UNFINISHED_DUPLICATE_WINDOW_MS;
    });
  }

  /**
   * Adds a play, or fills in the details missing from the copy already recorded (such as the score
   * ID and pp from an import). Returns the stored play and whether it is new.
   */
  async addPlay(play) {
    await this.load();
    const existing = this.findDuplicate(play);
    if (existing) {
      let changed = false;
      for (const [key, value] of Object.entries(play)) {
        if (value != null && existing[key] == null) {
          existing[key] = value;
          changed = true;
        }
      }
      if (changed) await this.save();
      return { play: existing, added: false };
    }
    this.data.plays.push(play);
    this.data.plays.sort((a, b) => time(a.at) - time(b.at));
    await this.save();
    return { play, added: true };
  }

  async updatePlay(id, patch) {
    await this.load();
    const play = this.data.plays.find((p) => p.id === id);
    if (!play) return null;
    Object.assign(play, patch);
    await this.save();
    return play;
  }

  async plays() {
    return (await this.load()).plays;
  }

  /**
   * Records the player's pp and ranks. If they are the same as last time, only the time they were
   * last confirmed (`checkedAt`) moves on.
   */
  async addUserStats(userId, stats) {
    await this.load();
    const now = new Date().toISOString();
    const last = this.data.userStats.findLast((s) => s.userId === userId);
    if (last && last.pp === stats.pp && last.globalRank === stats.globalRank && last.countryRank === stats.countryRank) {
      last.checkedAt = now;
    } else {
      this.data.userStats.push({ at: now, checkedAt: now, userId, ...stats });
    }
    await this.save();
  }

  async lastUserStatsAt(userId) {
    await this.load();
    const last = this.data.userStats.findLast((s) => s.userId === userId);
    return last ? time(last.checkedAt ?? last.at) : 0;
  }

  /** Records the skill profile's ratings, unless they are the same as last time. Returns whether it was added. */
  async addSkillSnapshot(userId, { ratings, playCount, sources }) {
    await this.load();
    const last = this.data.skills.findLast((s) => s.userId === userId);
    if (last && Object.keys(ratings).every((k) => Math.abs((last.ratings[k] ?? 0) - ratings[k]) < SAME_RATING)) return false;
    const rounded = Object.fromEntries(Object.entries(ratings).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    this.data.skills.push({ at: new Date().toISOString(), userId, ratings: rounded, playCount, sources });
    await this.save();
    return true;
  }

  async skillSnapshots(userId) {
    return (await this.load()).skills.filter((s) => s.userId === userId);
  }

  /**
   * Hit timing over your recent plays recorded from tosu: the mean (ms, positive is late) weighted
   * by hits, and the average unstable rate. Only nomod-rate plays of maps with few long notes
   * count towards the mean: osu! counts long note releases too, which would skew it, and the offset
   * is set in real time, which rate mods would mix up.
   */
  async recentTiming() {
    const { plays } = await this.load();
    const recent = plays.filter((p) => p.timing?.count >= TIMING_MIN_HITS).slice(-TIMING_PLAYS);
    if (recent.length === 0) return null;
    const offsetPlays = recent.filter((p) => p.rate === 1 && !(p.lnShare > TIMING_MAX_LN_SHARE));
    const hits = offsetPlays.reduce((sum, p) => sum + p.timing.count, 0);
    return {
      plays: recent.length,
      ur: recent.reduce((sum, p) => sum + p.timing.ur, 0) / recent.length,
      offsetPlays: offsetPlays.length,
      mean: hits ? offsetPlays.reduce((sum, p) => sum + p.timing.mean * p.timing.count, 0) / hits : null,
      // How much the plays disagree: the spread of their means.
      spread: offsetPlays.length > 1 ? stdev(offsetPlays.map((p) => p.timing.mean)) : null,
    };
  }

  /**
   * Sessions, newest first: plays with less than an hour between them. pp and rank changes come
   * from the snapshots of the player's stats around the session.
   */
  async sessions(userId, limit = 20) {
    const { plays, userStats } = await this.load();
    const stats = userStats.filter((s) => s.userId === userId);
    const groups = [];
    for (const play of plays) {
      const start = time(play.startedAt ?? play.at);
      const group = groups.at(-1);
      if (group && start - group.end <= SESSION_GAP_MS) {
        group.plays.push(play);
        group.end = Math.max(group.end, time(play.at));
      } else {
        groups.push({ start, end: time(play.at), plays: [play] });
      }
    }
    return groups.slice(-limit).reverse().map((g) => summarise(g, stats));
  }
}

/** The latest stats snapshot taken at or before `at`. */
const statsAt = (stats, at) => stats.findLast((s) => time(s.at) <= at) ?? null;

function summarise({ start, end, plays }, stats) {
  const passed = plays.filter((p) => p.passed);
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  // Before: the stats when the first play started (they're checked then), if they were confirmed
  // around the session's start. After: the last ones taken during the session or shortly after it
  // (they're checked a few seconds after each play).
  // Without those (the app was started mid-session), the first ones taken during the session.
  let before = statsAt(stats, time(plays[0].at));
  if (before && time(before.checkedAt ?? before.at) < start - SESSION_GAP_MS) before = null;
  before ??= stats.find((s) => time(s.at) >= start && time(s.at) <= end + SESSION_GAP_MS) ?? null;
  const after = statsAt(stats, end + SESSION_GAP_MS);
  const changed = before && after && time(after.at) > time(before.at);
  const since = before && time(before.at) > start ? before.at : null;
  const best = passed.filter((p) => p.pp != null).sort((a, b) => b.pp - a.pp)[0] ?? null;
  const rated = passed.filter((p) => p.ssr?.overall > 0).sort((a, b) => b.ssr.overall - a.ssr.overall)[0] ?? null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    ongoing: Date.now() - end < SESSION_GAP_MS,
    plays: plays.length,
    passed: passed.length,
    accuracy: mean(passed.map((p) => p.accuracy)),
    notes: plays.reduce((sum, p) => sum + hitCount(p), 0),
    playTime: plays.reduce((sum, p) => sum + playDuration(p), 0),
    pbs: plays.filter((p) => p.pb).map(brief),
    best: best && brief(best),
    bestRated: rated && brief(rated),
    pp: before?.pp != null ? { before: before.pp, after: changed ? after.pp : before.pp, since } : null,
    rank: before?.globalRank != null ? { before: before.globalRank, after: changed ? after.globalRank : before.globalRank, since } : null,
  };
}

/**
 * How long a play took: from tosu, the time between its start and end; for imported plays, the
 * map's drain time at the play's rate if it was passed (failed ones don't say when they ended).
 */
function playDuration(play) {
  if (play.startedAt) return Math.max(0, time(play.at) - time(play.startedAt));
  return play.passed && play.length > 0 ? (play.length * 1000) / (play.rate || 1) : 0;
}

const brief = (p) => ({
  id: p.id, beatmapId: p.beatmapId, title: p.title, version: p.version, mods: p.mods,
  accuracy: p.accuracy, pp: p.pp, ssr: p.ssr?.overall ?? null,
});

module.exports = { History, SESSION_GAP_MS };
