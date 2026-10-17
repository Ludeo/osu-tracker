// Connects to a running tosu (https://github.com/tosuapp/tosu) or gosumemory instance, which read
// the osu! client's memory and publish the current game state over a local WebSocket.
// Supports tosu's v2 endpoint (/websocket/v2) and the gosumemory-compatible legacy endpoint (/ws).

/* exported TosuClient */

// gosumemory numeric states -> tosu v2 state names.
const LEGACY_STATES = {
  0: 'menu', 1: 'edit', 2: 'play', 3: 'exit', 4: 'selectEdit', 5: 'selectPlay', 6: 'selectDrank',
  7: 'resultScreen', 11: 'selectMulti', 12: 'rankingVs', 13: 'onlineSelection', 14: 'optionsOffsetWizard',
  15: 'rankingTagCoop', 16: 'rankingTeam', 22: 'tourney',
};

function normalizeTosuData(data) {
  if (data && data.beatmap && data.state) {
    const bm = data.beatmap;
    return {
      state: data.state.name,
      beatmapId: bm.id ?? 0,
      setId: bm.set ?? 0,
      checksum: bm.checksum ?? '',
      artist: bm.artist ?? '',
      title: bm.title ?? '',
      version: bm.version ?? '',
      mapper: bm.mapper ?? '',
      stars: bm.stats?.stars?.total ?? null,
      keys: bm.stats?.cs?.original ?? null,
      od: bm.stats?.od?.original ?? null,
      holds: bm.stats?.objects?.holds ?? null,
      objects: bm.stats?.objects?.total ?? null,
      // settings.mode is the selected ruleset; play.mode is only populated during gameplay.
      mode: data.settings?.mode?.number ?? bm.mode?.number ?? null,
      playerName: data.profile?.name || data.play?.playerName || '',
      // { "90": pp, ..., "100": pp } for the selected mods, calculated by tosu.
      ppByAcc: data.performance?.accuracy ?? {},
      mods: data.play?.mods?.name ?? '',
      modBits: data.play?.mods?.number ?? 0,
      songsFolder: data.folders?.songs ?? '',
      gameFolder: data.folders?.game ?? '',
      // The play in progress, or the one on the results screen. The hit errors stay with the
      // play: the results screen has none of its own.
      play: data.state.name === 'resultScreen' && data.resultsScreen
        ? playStats(data.resultsScreen, data.resultsScreen.accuracy, data.resultsScreen.pp, data.resultsScreen.maxCombo,
          data.resultsScreen.playerName ?? data.resultsScreen.name, data.resultsScreen.mods, data.play?.hitErrorArray)
        : playStats(data.play, data.play?.accuracy, data.play?.pp, data.play?.combo?.max, data.play?.playerName, data.play?.mods,
          data.play?.hitErrorArray),
    };
  }

  if (data && data.menu && data.menu.bm) {
    const bm = data.menu.bm;
    return {
      state: LEGACY_STATES[data.menu.state] ?? `state ${data.menu.state}`,
      beatmapId: bm.id ?? 0,
      setId: bm.set ?? 0,
      checksum: bm.md5 ?? '',
      artist: bm.metadata?.artist ?? '',
      title: bm.metadata?.title ?? '',
      version: bm.metadata?.difficulty ?? '',
      mapper: bm.metadata?.mapper ?? '',
      stars: bm.stats?.fullSR ?? bm.stats?.SR ?? null,
      keys: bm.stats?.memoryCS ?? bm.stats?.CS ?? null,
      od: bm.stats?.memoryOD ?? bm.stats?.OD ?? null,
      holds: null,
      objects: null,
      mode: data.menu.gameMode ?? null,
      playerName: data.gameplay?.name || '',
      // gosumemory only provides 95-100%.
      ppByAcc: Object.fromEntries(
        Object.entries(data.menu.pp ?? {}).filter(([acc]) => /^\d+$/.test(acc)),
      ),
      mods: data.menu.mods?.str ?? '',
      modBits: data.menu.mods?.num ?? 0,
      songsFolder: data.settings?.folders?.songs ?? '',
      gameFolder: data.settings?.folders?.game ?? '',
      play: playStats(data.gameplay, data.gameplay?.accuracy, data.gameplay?.pp, data.gameplay?.combo?.max,
        data.gameplay?.name, { name: data.menu.mods?.str }, data.gameplay?.hits?.hitErrorArray),
    };
  }

  return null;
}

/** Mod acronyms from tosu's mods ({ array: [{ acronym }] } or { name: "HDDT" }). */
function modList(mods) {
  if (Array.isArray(mods?.array)) return mods.array.map((m) => m?.acronym ?? m).filter((m) => typeof m === 'string');
  return (String(mods?.name ?? '').match(/[A-Z0-9]{2}/g) ?? []).filter((m) => m !== 'NM');
}

/**
 * Judgements and pp of a play, whose player it is (replays and autoplay have someone else's name),
 * its mods and its hit errors (ms, positive is late). In mania, geki is MAX (320) and katu is 200.
 */
function playStats(source, accuracy, pp, maxCombo, player, mods, hitErrors) {
  const hits = source?.hits;
  if (!hits) return null;
  return {
    player: player || '',
    mods: modList(mods),
    hits: {
      max: hits.geki ?? 0, 300: hits['300'] ?? 0, 200: hits.katu ?? 0,
      100: hits['100'] ?? 0, 50: hits['50'] ?? 0, miss: hits['0'] ?? 0,
    },
    accuracy: accuracy ?? null, // percent
    pp: pp?.current ?? null,
    ppFc: pp?.fc ?? null,
    maxCombo: maxCombo ?? null,
    hitErrors: Array.isArray(hitErrors) ? hitErrors : [],
  };
}

class TosuClient {
  /**
   * @param {object} handlers
   * @param {(status: 'connecting'|'connected'|'disconnected') => void} handlers.onStatus
   * @param {(state: ReturnType<typeof normalizeTosuData>) => void} handlers.onData
   */
  constructor({ onStatus, onData }) {
    this.onStatus = onStatus;
    this.onData = onData;
    this.url = null;
    this.ws = null;
    this.retryTimer = null;
  }

  connect(url) {
    this.url = url;
    this.disconnect();
    this.open();
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  open() {
    this.onStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.onStatus('disconnected');
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => this.onStatus('connected');
    ws.onmessage = (event) => {
      let state;
      try {
        state = normalizeTosuData(JSON.parse(event.data));
      } catch {
        return;
      }
      if (state) this.onData(state);
    };
    ws.onclose = () => {
      this.ws = null;
      this.onStatus('disconnected');
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), 3000);
  }

  /** HTTP origin of the tosu server, used for local files such as the beatmap background. */
  get httpOrigin() {
    try {
      const u = new URL(this.url);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      return u.origin;
    } catch {
      return null;
    }
  }
}
