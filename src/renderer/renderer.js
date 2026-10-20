/* global TosuClient, isResultsScreen */

const MANIA_MODE = 3;
const MAP_CHANGE_DEBOUNCE_MS = 500;
// Give osu! time to submit the score before reloading after a play.
const RESULT_SCREEN_REFRESH_MS = 4000;

const STATE_LABELS = {
  menu: 'Main menu',
  edit: 'Editor',
  play: 'Playing',
  selectPlay: 'Song select',
  selectEdit: 'Editor song select',
  selectMulti: 'Multiplayer song select',
  resultScreen: 'Results',
  rankingVs: 'Multiplayer results',
  rankingTeam: 'Multiplayer results',
  rankingTagCoop: 'Multiplayer results',
  lobby: 'Multiplayer lobby',
  matchSetup: 'Multiplayer room',
};

const $ = (id) => document.getElementById(id);

let config = null;
let current = null; // latest normalized tosu state
let fetchSeq = 0;
let mapChangeTimer = null;
let resultTimer = null;

/** Small DOM helper; children may be strings, nodes, or falsy (skipped). Never uses innerHTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// ---------- formatting ----------

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtAcc = (a) => `${(a * 100).toFixed(2)}%`;
// pp is null for scores on unranked/loved maps.
const fmtPp = (pp) => (pp == null ? '– pp' : `${fmtInt(pp)}pp`);
const gradeLabel = (rank) => ({ X: 'SS', XH: 'SS', SH: 'S' }[rank] ?? rank ?? '?');
const profileUrl = (id) => `https://osu.ppy.sh/users/${id}/mania`;

function timeAgo(iso) {
  if (!iso) return '';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${unit}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function modsText(mods) {
  const shown = mods.filter((m) => m !== 'CL');
  return shown.length ? `+${shown.join('')}` : '';
}

// ---------- banner ----------

function showBanner(message) {
  $('banner').textContent = message;
  $('banner').classList.toggle('hidden', !message);
}

function credentialsBanner() {
  showBanner(config.hasCredentials ? '' : 'Add your osu! API client ID and secret in ⚙ Settings to load scores.');
}

// ---------- now playing ----------

function renderNowPlaying() {
  if (!current) return;
  const s = current;

  $('np-state').textContent = STATE_LABELS[s.state] ?? s.state;
  $('np-title').textContent = s.title ? `${s.title} [${s.version}]` : 'No map detected';
  $('np-artist').textContent = s.artist ? `${s.artist} · mapped by ${s.mapper}` : '';

  const pills = [
    s.keys ? el('span', { class: 'pill' }, `${s.keys}K`) : null,
    s.stars ? el('span', { class: 'pill' }, `★ ${Number(s.stars).toFixed(2)}`) : null,
    s.beatmapId > 0
      ? el('a', { class: 'pill', href: `https://osu.ppy.sh/b/${s.beatmapId}`, target: '_blank' }, `#${s.beatmapId}`)
      : el('span', { class: 'pill' }, 'unsubmitted / local'),
    s.mode != null && s.mode !== MANIA_MODE
      ? el('span', { class: 'pill pill-warn' }, 'Not in osu!mania mode — showing mania scores')
      : null,
  ];
  $('np-meta').replaceChildren(...pills.filter(Boolean));

  const origin = tosu.httpOrigin;
  const bg = $('np-bg');
  if (origin && s.checksum) {
    // tosu serves the background of the current map; the checksum busts the image cache on map change.
    bg.style.backgroundImage = `url("${origin}/files/beatmap/background?${encodeURIComponent(s.checksum)}")`;
  } else if (s.setId > 0) {
    bg.style.backgroundImage = `url("https://assets.ppy.sh/beatmaps/${s.setId}/covers/cover.jpg")`;
  } else {
    bg.style.backgroundImage = 'none';
  }
}

// ---------- skillsets ----------

const SKILLSET_LABELS = {
  stream: 'Stream',
  jumpstream: 'Jumpstream',
  handstream: 'Handstream',
  stamina: 'Stamina',
  jackspeed: 'Jackspeed',
  chordjack: 'Chordjack',
  technical: 'Technical',
};
const SKILLSET_DEBOUNCE_MS = 200;
let skillsets = null; // MinaCalc result for the current map and in-game mods, or { error }
let skillsetSeq = 0;
let skillsetTimer = null;

async function calculateSkillsets() {
  const seq = ++skillsetSeq;
  skillsets = null;
  renderSkillsets();
  if (!current?.checksum) return;
  try {
    const result = await window.tracker.calculateSkillsets({
      checksum: current.checksum,
      beatmapId: current.beatmapId,
      modBits: current.modBits,
    });
    if (seq === skillsetSeq) skillsets = result;
  } catch (err) {
    if (seq === skillsetSeq) skillsets = { error: err.message };
  }
  if (seq === skillsetSeq) renderSkillsets();
}

function renderSkillsets() {
  const box = $('np-skills');
  if (!current?.checksum) {
    box.replaceChildren();
    return;
  }
  if (!skillsets || skillsets.error || skillsets.unsupported) {
    box.replaceChildren(el('span', { class: 'muted' }, skillsets?.unsupported ?? skillsets?.error ?? 'Rating skillsets…'));
    return;
  }

  const { msd, rate, lnHeavy, lnShare, calcVersion } = skillsets;
  const top = Object.keys(SKILLSET_LABELS).sort((a, b) => msd[b] - msd[a]).slice(0, 2);
  const head = el('div', { class: 'skills-head' },
    el('b', { title: `Etterna MinaCalc ${calcVersion}: skill needed for a 93% (Wife) score` }, `MSD ${msd.overall.toFixed(2)}`),
    rate !== 1 ? el('span', { class: 'muted' }, ` · ${rate}x rate`) : null,
    lnHeavy
      ? el('span', { class: 'pill pill-warn', title: 'MinaCalc rates long notes like taps and ignores releases' },
        `${Math.round(lnShare * 100)}% LNs: likely underrated`)
      : null,
  );
  const bars = Object.entries(SKILLSET_LABELS).map(([key, label]) => {
    const fill = el('div', { class: 'skill-fill' });
    fill.style.width = `${Math.min(100, (msd[key] / msd.overall) * 100)}%`;
    return el('div', { class: `skill${top.includes(key) ? ' top' : ''}` },
      el('span', {}, label),
      el('div', { class: 'skill-bar' }, fill),
      el('b', {}, msd[key].toFixed(1)),
    );
  });
  box.replaceChildren(head, el('div', { class: 'skills' }, bars), difficultyGraph(skillsets));
}

const fmtSongTime = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * Area chart of the MSD through the map, against the map's overall MSD (dashed), so difficulty
 * spikes stand out. Hovering names the time, MSD and main skillset of that part.
 */
function difficultyGraph({ graph, msd, rate }) {
  if (!graph?.points.length) return null;
  const { points } = graph;
  const length = graph.length / rate; // real time, which DT and HT change
  const peak = points.reduce((a, b) => (b.overall > a.overall ? b : a));
  const high = Math.max(5, Math.ceil(Math.max(peak.overall, msd.overall) / 5) * 5);

  const readout = el('div', { class: 'diff-readout' });
  const show = (p, label) => {
    const skill = p.skill && p.overall > 0 ? el('span', {}, SKILLSET_LABELS[p.skill]) : null;
    if (skill) skill.style.color = SKILL_COLORS[p.skill];
    readout.replaceChildren(...[
      label ? el('span', { class: 'muted' }, label) : null,
      el('b', {}, fmtSongTime(p.time / rate)),
      el('span', {}, p.overall > 0 ? `MSD ${p.overall.toFixed(2)}` : 'Break'),
      skill,
    ].filter(Boolean));
  };
  const showPeak = () => show(peak, 'Hardest part');

  // Drawn at the container's pixel width so the labels stay the same size in narrow columns.
  const draw = (width) => {
    const height = 120;
    const pad = { left: 30, right: 12, top: 8, bottom: 18 };
    const x = (time) => pad.left + (length > 0 ? (time / rate / length) * (width - pad.left - pad.right) : 0);
    const y = (v) => pad.top + (1 - v / high) * (height - pad.top - pad.bottom);

    const grid = [];
    for (let v = 0; v <= high; v += high > 20 ? 10 : 5) {
      grid.push(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'chart-grid' }));
      grid.push(svgEl('text', { x: pad.left - 5, y: y(v) + 4, class: 'chart-label', 'text-anchor': 'end' }, String(v)));
    }
    const ticks = length <= 0 ? [0] : width < 400 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
    ticks.forEach((f, i) => grid.push(svgEl('text', {
      x: pad.left + f * (width - pad.left - pad.right), y: height - 4, class: 'chart-label',
      'text-anchor': i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle',
    }, fmtSongTime(f * length))));

    const line = points.map((p) => `${x(p.time).toFixed(1)},${y(p.overall).toFixed(1)}`).join(' ');
    const area = `${x(points[0].time).toFixed(1)},${y(0)} ${line} ${x(points.at(-1).time).toFixed(1)},${y(0)}`;
    const cursor = svgEl('line', { y1: pad.top, y2: height - pad.bottom, class: 'chart-cursor', visibility: 'hidden' });
    const dot = svgEl('circle', { r: 3, class: 'diff-dot', visibility: 'hidden' });
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'diff-chart', role: 'img', 'aria-label': 'Difficulty through the map' },
      ...grid,
      svgEl('polygon', { points: area, class: 'diff-area' }),
      svgEl('polyline', { points: line, class: 'diff-line' }),
      svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(msd.overall), y2: y(msd.overall), class: 'diff-msd' }),
      svgEl('circle', { cx: x(peak.time), cy: y(peak.overall), r: 3.5, class: 'diff-peak' }),
      cursor, dot);

    svg.addEventListener('mousemove', (e) => {
      const box = svg.getBoundingClientRect();
      const time = ((((e.clientX - box.left) / box.width) * width - pad.left) / (width - pad.left - pad.right)) * length * rate;
      const p = points.reduce((a, b) => (Math.abs(b.time - time) < Math.abs(a.time - time) ? b : a));
      cursor.setAttribute('x1', x(p.time));
      cursor.setAttribute('x2', x(p.time));
      dot.setAttribute('cx', x(p.time));
      dot.setAttribute('cy', y(p.overall));
      cursor.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      show(p, null);
    });
    svg.addEventListener('mouseleave', () => {
      cursor.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      showPeak();
    });
    return svg;
  };

  const chart = el('div', {}, draw(800));
  let drawnWidth = 800;
  // Redraw when the card changes width: window resizes, or moving between the Tracker and Game views.
  new ResizeObserver(() => {
    const width = Math.round(chart.clientWidth);
    if (width > 0 && width !== drawnWidth) {
      drawnWidth = width;
      chart.replaceChildren(draw(width));
    }
  }).observe(chart);
  showPeak();
  return el('div', { class: 'diff-graph', title: 'MSD of the 10 seconds around each point. The dashed line is the whole map\'s MSD.' }, chart, readout);
}

// ---------- pp by accuracy ----------

const MIN_PP_ACC = 90;
let myBestAcc = null; // 0..1, accuracy of your best score on the current map

// Mods that affect mania pp, as legacy bitflags. HT and DT are mutually exclusive.
const PP_MODS = [['HT', 256], ['DT', 64], ['EZ', 2], ['NF', 1]];
let ppMods = null; // null = use the mods selected in osu!, otherwise a bitmask picked here
let ppCalc = null; // { ppByAcc, stars } for the current map and mods, or { error }
let ppCalcSeq = 0;

const activePpMods = () => ppMods ?? current?.modBits ?? 0;

function renderModPicker() {
  const chip = (label, active, onclick, title) =>
    el('button', { type: 'button', class: `mod-chip${active ? ' active' : ''}`, onclick, title }, label);
  $('pp-mod-picker').replaceChildren(
    chip('In-game', ppMods == null, () => setPpMods(null), 'Use the mods selected in osu!'),
    ...PP_MODS.map(([name, bit]) => chip(name, ppMods != null && (ppMods & bit) !== 0, () => togglePpMod(bit))),
  );
}

function togglePpMod(bit) {
  let mods = (ppMods ?? 0) ^ bit;
  if (bit === 256 && mods & 256) mods &= ~64;
  if (bit === 64 && mods & 64) mods &= ~256;
  setPpMods(mods);
}

function setPpMods(mods) {
  ppMods = mods;
  renderModPicker();
  calculatePp();
}

async function calculatePp() {
  const seq = ++ppCalcSeq;
  ppCalc = null;
  renderPp();
  if (!current?.checksum) return;
  try {
    const result = await window.tracker.calculatePp(activePpMods(), current.od);
    if (seq === ppCalcSeq) ppCalc = result;
  } catch (err) {
    if (seq === ppCalcSeq) ppCalc = { error: err.message };
  }
  if (seq === ppCalcSeq) renderPp();
}

function renderPp() {
  const entries = Object.entries(ppCalc?.ppByAcc ?? {})
    .map(([acc, pp]) => [Number(acc), pp])
    .filter(([acc, pp]) => acc >= MIN_PP_ACC && Number.isFinite(pp))
    .sort(([a], [b]) => a - b);

  const names = ppMods == null
    ? current?.mods ?? ''
    : PP_MODS.filter(([, bit]) => ppMods & bit).map(([name]) => name).join('');
  const stars = ppCalc?.stars ? ` · ★ ${ppCalc.stars.toFixed(2)}` : '';
  $('pp-mods').textContent = `${names ? `with +${names}` : 'no mods'}${stars}`;
  $('pp-mods').title = 'Estimated for a typical spread of judgements at each accuracy';
  if (entries.length === 0) {
    const message = ppCalc?.error ?? (current?.checksum ? 'Calculating…' : 'No map selected yet.');
    $('pp-table').replaceChildren(el('span', { class: 'muted' }, message));
    return;
  }

  const reachedAcc = myBestAcc == null ? -1 : myBestAcc * 100;
  $('pp-table').replaceChildren(...entries.map(([acc, pp]) =>
    el('div', { class: `pp-cell${acc <= reachedAcc ? ' reached' : ''}`, title: acc <= reachedAcc ? 'Reached by your best score' : null },
      el('span', {}, `${acc}%`),
      el('b', {}, `${Math.round(pp)}pp`),
    ),
  ));
}

// ---------- scores ----------

function statRow(score) {
  const items = [
    ['MAX', score.stats.max], ['300', score.stats[300]], ['200', score.stats[200]],
    ['100', score.stats[100]], ['50', score.stats[50]], ['Miss', score.stats.miss],
  ];
  return el('div', { class: 'stat-row' }, items.map(([label, value]) => el('div', {}, el('b', {}, fmtInt(value)), el('span', {}, label))));
}

function renderMyBest(result, checksum) {
  const box = $('my-best');
  box.classList.remove('empty');
  myBestAcc = result.me?.score?.accuracy ?? null;
  renderPp();
  setMyScores(checksum, result.me?.scores ?? []);

  let message = null;
  if (result.reason === 'unsubmitted') message = 'This map is not submitted, so there are no online scores.';
  else if (result.reason === 'no-username') message = 'Set your username in ⚙ Settings (or log into osu!) to see your score.';
  else if (!result.me?.score) message = result.me?.error ?? 'You have no score on this map yet. Go set one!';

  if (message) {
    box.classList.add('empty');
    box.replaceChildren(message);
    return;
  }

  const top = result.me.score;
  const topPp = result.boards.find((b) => b.key === 'pp')?.entries.find((e) => e.isMe)?.score ?? top;
  box.replaceChildren(...(topPp.id === top.id
    ? [bestBlock('Top score · Top pp', top)]
    : [bestBlock('Top score', top), bestBlock('Top pp', topPp)]));
}

function bestBlock(label, s) {
  return el('div', { class: 'best-block' },
    el('div', { class: 'best-label' }, label),
    el('div', { class: 'best-grid' },
      el('div', { class: `grade grade-big grade-${s.rank}` }, gradeLabel(s.rank)),
      el('div', {},
        el('div', { class: 'best-score' }, fmtInt(s.score)),
        el('div', { class: 'best-sub' },
          `${fmtAcc(s.accuracy)} · ${fmtInt(s.maxCombo)}x`,
          ' · ', el('b', { class: 'best-pp' }, fmtPp(s.pp)),
          s.position ? ` · #${fmtInt(s.position)} global` : '',
          ' · ', timeAgo(s.date),
          ' ', el('span', { class: 'mods' }, modsText(s.mods)),
        ),
        statRow(s),
      ),
    ),
  );
}

function leaderboardRow(entry, index) {
  const { user, score, isMe, error } = entry;
  return el('li', { class: `lb-row${isMe ? ' me' : ''}${score ? '' : ' no-score'}` },
    el('div', { class: 'lb-pos' }, score ? `#${index + 1}` : '–'),
    el('img', { class: 'avatar', src: user.avatarUrl, alt: '' }),
    el('div', { class: `grade grade-${score?.rank}` }, score ? gradeLabel(score.rank) : ''),
    el('div', { class: 'lb-name' },
      el('a', { href: profileUrl(user.id), target: '_blank' }, user.username), isMe ? ' (you)' : '',
      el('div', { class: 'lb-details' },
        score
          ? [`${fmtAcc(score.accuracy)} · ${fmtInt(score.maxCombo)}x · ${timeAgo(score.date)} `, el('span', { class: 'mods' }, modsText(score.mods))]
          : error ?? 'No score',
      ),
    ),
    el('div', { class: 'lb-pp', title: score && score.pp == null ? 'No pp: the map is not ranked' : null },
      score ? fmtPp(score.pp) : ''),
    el('div', { class: 'lb-score' },
      score ? el('b', {}, fmtInt(score.score)) : null,
      score?.position ? el('span', { class: 'muted' }, `#${fmtInt(score.position)} global`) : null,
    ),
  );
}

let boards = []; // [{ key, label, entries }] from the last score fetch
let activeBoard = 'score'; // kept across maps; falls back to 'score' if the map has no such board

function renderLeaderboard(result) {
  boards = result.boards;
  const list = $('leaderboard');
  if (!result.beatmapId) {
    $('lb-tabs').replaceChildren();
    list.replaceChildren(el('li', { class: 'placeholder' }, 'No online leaderboard for this map.'));
    return;
  }
  if (boards[0].entries.length === 0) {
    $('lb-tabs').replaceChildren();
    list.replaceChildren(el('li', { class: 'placeholder' }, 'Add friends on the right to compare scores.'));
    return;
  }
  renderBoard();
}

function renderBoard() {
  const board = boards.find((b) => b.key === activeBoard) ?? boards[0];
  $('lb-tabs').replaceChildren(...boards.map((b) =>
    el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(b === board),
      class: `mod-chip${b === board ? ' active' : ''}`,
      title: b.key.startsWith('mods:') ? `Best ${b.label} score of each player` : null,
      onclick: () => { activeBoard = b.key; renderBoard(); },
    }, b.label)));
  $('leaderboard').replaceChildren(...board.entries.map(leaderboardRow));
}

function setPlaceholder(text) {
  $('my-best').classList.add('empty');
  $('my-best').replaceChildren(text);
  $('lb-tabs').replaceChildren();
  $('leaderboard').replaceChildren(el('li', { class: 'placeholder' }, text));
}

async function loadScores() {
  if (!current || !current.checksum) return;
  const { checksum } = current;
  if (!config.hasCredentials) {
    credentialsBanner();
    setPlaceholder('osu! API credentials missing.');
    return;
  }

  const seq = ++fetchSeq;
  $('lb-note').textContent = 'Loading…';
  try {
    const result = await window.tracker.fetchScores({
      beatmapId: current.beatmapId,
      checksum,
      playerName: current.playerName,
    });
    if (seq !== fetchSeq) return; // a newer request superseded this one
    showBanner('');
    renderMyBest(result, checksum);
    renderLeaderboard(result);
    $('lb-note').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (seq !== fetchSeq) return;
    showBanner(err.message);
    $('lb-note').textContent = '';
  }
}

// ---------- comparing a play with your PB ----------

let myScores = null; // { checksum, scores } your scores on the map last loaded, best first
let playPb = null; // the PB the latest play is compared with (see pickPb), kept after it ends

function setMyScores(checksum, scores) {
  myScores = { checksum, scores: scores.map((s) => ({ accuracy: s.accuracy, mods: s.mods })) };
  window.tracker.setOverlayPb(myScores).catch(() => {});
}

/** While playing, follows your scores and the play's mods; afterwards it stays, so a new PB doesn't replace it. */
function updatePlayPb(s) {
  if (s.state !== 'play') return;
  playPb = myScores?.checksum === s.checksum ? pickPb(myScores.scores, s.play?.mods ?? []) : null;
}

// ---------- tosu ----------

function onTosuData(next) {
  const prev = current;
  current = next;
  // The results screen has no hit errors of its own; they're the play's.
  if (isResultsScreen(next.state) && next.play && !next.play.hitErrors.length && prev?.play?.hitErrors.length) {
    next.play.hitErrors = prev.play.hitErrors;
  }
  updatePlayPb(next);

  const mapChanged = !prev || prev.checksum !== next.checksum;
  const stateChanged = !prev || prev.state !== next.state;
  const playerChanged = prev && prev.playerName !== next.playerName && !config.username;

  if (mapChanged) myBestAcc = null;
  if (mapChanged || stateChanged) renderNowPlaying();
  // tosu's own pp values arrive slightly after a map change; a change in them means it has loaded
  // the new map, so recalculate then too.
  const ppChanged = JSON.stringify(prev?.ppByAcc) !== JSON.stringify(next.ppByAcc);
  const inGameModsChanged = ppMods == null && prev?.modBits !== next.modBits;
  if (mapChanged || ppChanged || inGameModsChanged) calculatePp();
  if (mapChanged || prev?.modBits !== next.modBits) {
    // Drop the previous map's ratings (and any request still running) while waiting.
    skillsetSeq++;
    skillsets = null;
    renderSkillsets();
    clearTimeout(skillsetTimer);
    skillsetTimer = setTimeout(calculateSkillsets, SKILLSET_DEBOUNCE_MS);
  }

  if (mapChanged || playerChanged) {
    // Scrolling through song select changes the map rapidly; wait until it settles.
    clearTimeout(mapChangeTimer);
    mapChangeTimer = setTimeout(loadScores, MAP_CHANGE_DEBOUNCE_MS);
  }

  if (stateChanged && next.state === 'play') {
    keyCounts = keyCounts.map(() => 0);
    if (keyTimer) renderKeyOverlay();
  }
  trackPlay(prev, next);
  renderPlayHud();

  if (stateChanged && isResultsScreen(next.state)) {
    clearTimeout(resultTimer);
    resultTimer = setTimeout(loadScores, RESULT_SCREEN_REFRESH_MS);
  }
}

const tosu = new TosuClient({
  onStatus(status) {
    const label = { connecting: 'connecting…', connected: 'tosu connected', disconnected: 'tosu not running' }[status];
    $('tosu-status').textContent = label;
    $('tosu-status').className = `status status-${status}`;
  },
  onData: onTosuData,
});

// ---------- osu! API rate limit ----------

function renderRateLimit(rateLimit) {
  const node = $('api-limit');
  if (!rateLimit) return;
  const share = rateLimit.remaining / rateLimit.limit;
  node.textContent = `API ${fmtInt(rateLimit.remaining)} / ${fmtInt(rateLimit.limit)}`;
  node.className = `status status-${share > 0.5 ? 'connected' : share > 0.1 ? 'connecting' : 'disconnected'}`;
  node.title = `osu! API requests left in the current minute (as of ${new Date(rateLimit.at).toLocaleTimeString()}). `
    + 'The allowance refills over time.';
}

// ---------- friends ----------

function renderFriends() {
  const list = $('friend-list');
  if (config.friends.length === 0) {
    list.replaceChildren(el('li', { class: 'muted' }, 'No friends added yet.'));
    return;
  }
  list.replaceChildren(...config.friends.map((f) =>
    el('li', {},
      el('img', { class: 'avatar', src: f.avatarUrl, alt: '' }),
      el('a', { class: 'name', href: profileUrl(f.id), target: '_blank' }, f.username),
      el('button', { class: 'remove-btn', title: `Remove ${f.username}`, onclick: () => removeFriend(f.id) }, '×'),
    ),
  ));
}

async function addFriend(event) {
  event.preventDefault();
  const input = $('friend-input');
  const button = event.submitter;
  const name = input.value.trim();
  if (!name) return;

  $('friend-error').textContent = '';
  if (!config.hasCredentials) {
    $('friend-error').textContent = 'Set your osu! API credentials in Settings first.';
    return;
  }

  button.disabled = true;
  try {
    config = await window.tracker.addFriend(name);
    input.value = '';
    renderFriends();
    loadScores();
  } catch (err) {
    $('friend-error').textContent = err.message;
  } finally {
    button.disabled = false;
    input.focus();
  }
}

async function removeFriend(id) {
  config = await window.tracker.removeFriend(id);
  renderFriends();
  loadScores();
}

// ---------- views ----------

function showView(name) {
  for (const tab of document.querySelectorAll('.view-tab')) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  placeTrackerCards(name === 'game');
  $('view-tracker').classList.toggle('hidden', name !== 'tracker');
  $('view-game').classList.toggle('hidden', name !== 'game');
  $('view-recs').classList.toggle('hidden', name !== 'recs');
  $('view-progress').classList.toggle('hidden', name !== 'progress');
  if (name === 'recs' && !recs && !recsLoading) loadRecommendations();
  if (name === 'progress') loadProgress();
  if (name === 'game') {
    startKeyOverlay();
    renderPlayHud();
  } else {
    stopKeyOverlay();
  }
}

// ---------- game view ----------

const TRACKER_CARDS = ['banner', 'now-playing', 'pp-card', 'best-card', 'timing-card', 'lb-card'];

/** Moves the tracker cards and the Friends panel around the osu! window in the game view, or back. */
function placeTrackerCards(game) {
  $('layout').classList.toggle('game-mode', game);
  if (game) {
    $('game-left').append($('banner'), $('now-playing'), $('pp-card'), $('best-card'), $('timing-card'));
    $('game-right').append($('lb-card'), $('friends'));
  } else {
    $('view-tracker').append(...TRACKER_CARDS.map($));
    $('layout').append($('friends'));
  }
}

let captureStream = null;

function stopCapture() {
  for (const track of captureStream?.getTracks() ?? []) track.stop();
  captureStream = null;
  $('capture-video').srcObject = null;
  $('capture-video').classList.add('hidden');
  $('capture-area').classList.remove('streaming');
  $('capture-empty').classList.remove('hidden');
  $('capture-stop').classList.add('hidden');
  $('capture-note').textContent = '';
}

async function startCapture(source) {
  $('capture-picker').classList.add('hidden');
  try {
    if (!(await window.tracker.selectCaptureSource(source.id))) throw new Error('That window is gone. Select it again.');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: false });
    stopCapture();
    captureStream = stream;
    const [track] = stream.getVideoTracks();
    // The track ends when the window closes or the capture is stopped from the desktop.
    track.addEventListener('ended', () => { if (captureStream === stream) stopCapture(); });
    $('capture-video').srcObject = stream;
    $('capture-video').classList.remove('hidden');
    $('capture-empty').classList.add('hidden');
    $('capture-stop').classList.remove('hidden');
    $('capture-note').textContent = source.name;
  } catch (err) {
    if (!captureStream) $('capture-empty').classList.remove('hidden');
    showToast(`Couldn't capture the window: ${err.message}`);
  }
}

/** Sizes the capture area to the captured window, so a 16:9 window has no black bars above and below. */
function fitCaptureArea() {
  const video = $('capture-video');
  if (!captureStream || !video.videoWidth || !video.videoHeight) return;
  $('capture-area').style.setProperty('--capture-ratio', `${video.videoWidth} / ${video.videoHeight}`);
  $('capture-area').classList.add('streaming');
}

/** On Wayland the desktop's own picker has already chosen a window; on X11 the user picks one here. */
async function selectCaptureWindow() {
  let sources;
  try {
    sources = await window.tracker.getCaptureSources();
  } catch (err) {
    showToast(`Couldn't list windows: ${err.message}`);
    return;
  }
  if (sources.length === 0) return; // picker cancelled
  if (sources.length === 1) {
    startCapture(sources[0]);
    return;
  }
  const isOsu = (s) => /^osu!/i.test(s.name);
  sources.sort((a, b) => isOsu(b) - isOsu(a));
  $('capture-empty').classList.add('hidden');
  $('capture-picker').replaceChildren(...sources.map((source) => el('li', {},
    el('button', { type: 'button', class: `capture-source${isOsu(source) ? ' osu' : ''}`, onclick: () => startCapture(source) },
      source.thumbnail ? el('img', { src: source.thumbnail, alt: '' }) : el('div', { class: 'capture-thumb' }),
      el('span', {}, source.name)))));
  $('capture-picker').classList.remove('hidden');
}

// ---------- key overlay ----------

const KPS_WINDOW_MS = 1000;
const KPS_REFRESH_MS = 50;
let keyLabels = ['D', 'F', 'J', 'K'];
let keyPressed = [false, false, false, false];
let keyPresses = [[], [], [], []]; // press times within the last KPS window, per column
let keyCounts = [0, 0, 0, 0]; // presses since the current play started
let keyTimer = null;
let keyWatchSeq = 0;

function renderKeyOverlay() {
  $('key-overlay').replaceChildren(...keyLabels.map((label, i) => el('div', { class: `key${keyPressed[i] ? ' pressed' : ''}` },
    el('div', { class: 'key-cap' }, label),
    el('div', { class: 'key-kps' }, el('b', {}, '0'), ' KPS'),
    el('div', { class: 'key-count', title: 'Presses this play' }, fmtInt(keyCounts[i])))));
}

/** Refreshes the KPS numbers: presses within the last second, per finger and in total. */
function renderKps() {
  const since = performance.now() - KPS_WINDOW_MS;
  const keys = $('key-overlay').children;
  let total = 0;
  keyPresses.forEach((times, i) => {
    while (times.length && times[0] < since) times.shift();
    total += times.length;
    const kps = keys[i]?.querySelector('.key-kps b');
    if (kps && kps.textContent !== String(times.length)) kps.textContent = times.length;
  });
  if ($('kps-total').textContent !== String(total)) $('kps-total').textContent = total;
}

function onKey(column, pressed) {
  if (column < 0 || column >= keyLabels.length || keyPressed[column] === pressed) return;
  keyPressed[column] = pressed;
  const key = $('key-overlay').children[column];
  key?.classList.toggle('pressed', pressed);
  if (!pressed) return;
  keyPresses[column].push(performance.now());
  keyCounts[column]++;
  const count = key?.querySelector('.key-count');
  if (count) count.textContent = fmtInt(keyCounts[column]);
  renderKps();
}

/** Starts reading the four 4K keys bound in osu! while the game view is open. */
async function startKeyOverlay() {
  if (keyTimer) return;
  const seq = ++keyWatchSeq;
  keyTimer = setInterval(renderKps, KPS_REFRESH_MS);
  renderKeyOverlay();
  try {
    const result = await window.tracker.watchKeys({
      songsFolder: config.songsFolder || '',
      gameFolder: current?.gameFolder || '',
    });
    if (seq !== keyWatchSeq) return;
    keyLabels = result.keys;
    $('keys-note').textContent = result.error ?? '';
    $('keys-note').title = result.layoutSource ? `Key bindings from ${result.layoutSource}` : 'osu!\'s default keys; your osu! config wasn\'t found';
  } catch (err) {
    if (seq === keyWatchSeq) $('keys-note').textContent = err.message;
  }
  if (seq === keyWatchSeq) renderKeyOverlay();
}

function stopKeyOverlay() {
  if (!keyTimer) return;
  keyWatchSeq++;
  clearInterval(keyTimer);
  keyTimer = null;
  keyPressed = keyPressed.map(() => false);
  keyPresses = keyPresses.map(() => []);
  window.tracker.unwatchKeys().catch(() => {});
}

// ---------- play HUD ----------

let lastPlay = null; // { state, stats, od } of the latest play seen, kept after leaving it

function renderPlayHud() {
  if (current && (current.state === 'play' || isResultsScreen(current.state)) && current.play) {
    lastPlay = { state: current.state, stats: current.play, od: current.od };
  }
  renderTiming();
  if ($('view-game').classList.contains('hidden')) return;
  const stats = lastPlay?.stats;
  const hits = stats?.hits ?? { max: 0, 300: 0, 200: 0, 100: 0, 50: 0, miss: 0 };

  setText($('hud-pp'), stats?.pp != null ? fmtInt(stats.pp) : '–');
  const live = lastPlay && current?.state === lastPlay.state;
  const label = !lastPlay ? 'No play yet' : live ? (lastPlay.state === 'play' ? 'Playing' : 'Results') : 'Last play';
  setText($('hud-play-note'), [
    label,
    stats?.accuracy != null ? `${stats.accuracy.toFixed(2)}%` : null,
    stats?.ppFc != null && lastPlay?.state === 'play' ? `FC ${fmtInt(stats.ppFc)}pp` : null,
  ].filter(Boolean).join(' · '));

  const ratio = hits[300] > 0 ? `${(hits.max / hits[300]).toFixed(2)}:1` : hits.max > 0 ? '∞' : '–';
  const grid = $('hud-judgements');
  if (!grid.children.length) {
    // Built once; later updates only change the numbers.
    const cell = (key, name) => [el('span', { class: `j-${key}` }, name), el('b', { class: `j-${key}`, 'data-hit': key })];
    grid.append(
      ...cell('max', 'MAX'), ...cell('300', '300'), ...cell('200', '200'),
      ...cell('100', '100'), ...cell('50', '50'), ...cell('miss', 'Miss'),
      el('div', { class: 'ratio', title: 'Marvelous (MAX) to Perfect (300) ratio' }, 'MAX:300 ', el('b', { 'data-ratio': '' })),
    );
  }
  for (const b of grid.querySelectorAll('[data-hit]')) setText(b, fmtInt(hits[b.dataset.hit]));
  setText(grid.querySelector('[data-ratio]'), ratio);

  renderPace(stats);
}

function renderPace(stats) {
  const node = $('hud-pace');
  const pace = paceOf(stats?.accuracy, playPb);
  setText(node, pace == null ? '' : `${fmtPace(pace)} vs PB`);
  node.className = `pace${pace == null ? '' : pace >= 0 ? ' up' : ' down'}`;
  node.title = playPb
    ? `Your accuracy against your PB's (${playPb.accuracy.toFixed(2)}%${playPb.mods.length ? ` +${playPb.mods.join('')}` : ''}`
      + `${playPb.sameMods ? '' : ', with other mods: you have no score with these'})`
    : '';
}

const HIST_BINS = 41; // odd, so the middle bin is centred on 0 ms
let timingShown = null; // { errors, count, state } last drawn, to skip redrawing an unchanged play

/**
 * The latest play's UR, mean timing and a histogram of its hit errors, from the 200 window early
 * to the 200 window late (outliers at the edges).
 */
function renderTiming() {
  const stats = lastPlay?.stats;
  const live = lastPlay && current?.state === lastPlay.state;
  const label = !lastPlay ? 'No play yet' : live ? (lastPlay.state === 'play' ? 'Playing' : 'Results') : 'Last play';
  setText($('play-timing-note'), label);
  const errors = stats?.hitErrors ?? [];
  if (timingShown?.errors === errors && timingShown.count === errors.length) return;
  timingShown = { errors, count: errors.length };

  const timing = timingSummary(errors, stats?.mods);
  setText($('play-ur'), timing ? timing.ur.toFixed(0) : '–');
  setText($('play-mean'), timing ? timingText(timing.mean) : 'No hits yet');
  $('play-mean').title = timing ? `Average hit error, ${timing.early} early and ${timing.late} late hits` : '';

  const hist = $('play-hist');
  const windows = hitWindows(lastPlay?.od);
  const range = windows[200];
  const binWidth = (2 * range) / HIST_BINS;
  if (hist.dataset.range !== String(range)) {
    // Built for the map's hit windows; later updates only change the heights.
    hist.dataset.range = String(range);
    hist.title = `Hit errors from ${range.toFixed(0)} ms early to ${range.toFixed(0)} ms late, coloured by the judgement they get (MAX, 300, 200)`;
    hist.replaceChildren(...Array.from({ length: HIST_BINS }, (_, i) => {
      const centre = Math.abs(-range + (i + 0.5) * binWidth);
      return el('div', { class: `hist-bar ${centre <= windows.max ? 'j-max' : centre <= windows[300] ? 'j-300' : 'j-200'}` });
    }), el('div', { class: 'hist-mean' }));
  }
  const counts = new Array(HIST_BINS).fill(0);
  for (const e of errors) {
    counts[Math.min(HIST_BINS - 1, Math.max(0, Math.floor((e + range) / binWidth)))]++;
  }
  const top = Math.max(1, ...counts);
  counts.forEach((c, i) => { hist.children[i].style.height = `${(c / top) * 100}%`; });
  const mean = hist.lastChild;
  mean.classList.toggle('hidden', !timing);
  // The marker is in song time, like the bars.
  if (timing) mean.style.left = `${Math.min(100, Math.max(0, ((timing.mean * rateOf(stats.mods) + range) / (2 * range)) * 100))}%`;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// ---------- recording plays ----------

const MIN_RECORDED_HITS = 20; // attempts restarted sooner aren't recorded
// Judgements that arrive with the results screen beyond the last ones seen during the play.
const MAX_RESULT_EXTRA_HITS = 30;
let attempt = null; // { startedAt, map, stats, finishing, failed } of the play in progress

const hitTotal = (hits) => (hits ? Object.values(hits).reduce((a, b) => a + b, 0) : 0);

/**
 * Follows plays in tosu and records each attempt in the play history: passed when the results
 * screen comes up (unless failed in multiplayer, where the play carries on), failed or quit when
 * the play is left or restarted before that.
 */
function trackPlay(prev, next) {
  if (next.state === 'play') {
    const restarted = attempt && !attempt.finishing && hitTotal(next.play?.hits) < hitTotal(attempt.stats?.hits);
    if (!attempt || prev?.state !== 'play' || restarted) {
      if (attempt) finishAttempt(attempt.finishing && !attempt.failed);
      startAttempt(next);
    }
    if (hitTotal(next.play?.hits) > 0) attempt.stats = next.play;
    if (next.play?.failed) attempt.failed = true;
    return;
  }
  if (!attempt) return;
  if (prev?.state === 'play' && isResultsScreen(next.state)) attempt.finishing = true;
  if (!attempt.finishing) {
    finishAttempt(false);
    return;
  }
  if (isResultsScreen(next.state)) {
    // The results can take a moment to replace the previous ones.
    const last = hitTotal(attempt.stats?.hits);
    const total = hitTotal(next.play?.hits);
    if (total >= last && total <= last + MAX_RESULT_EXTRA_HITS) {
      attempt.stats = next.play;
      finishAttempt(!attempt.failed);
    }
    return;
  }
  finishAttempt(!attempt.failed); // left the results screen before they came in
}

function startAttempt(s) {
  attempt = {
    startedAt: new Date().toISOString(),
    map: {
      beatmapId: s.beatmapId, setId: s.setId, checksum: s.checksum, title: s.title, artist: s.artist,
      version: s.version, mapper: s.mapper, stars: s.stars, keys: s.keys, od: s.od, mode: s.mode,
      holds: s.holds, objects: s.objects,
    },
    stats: null,
    finishing: false,
    failed: false,
  };
  window.tracker.playStarted({ playerName: s.playerName }).catch(() => {});
}

function finishAttempt(passed) {
  const done = attempt;
  attempt = null;
  const stats = done?.stats;
  if (!stats || done.map.mode !== MANIA_MODE || hitTotal(stats.hits) < MIN_RECORDED_HITS) return;
  // Replays, spectating and autoplay carry someone else's name.
  if (stats.player && current?.playerName && stats.player !== current.playerName) return;
  window.tracker.recordPlay({
    ...done.map,
    startedAt: done.startedAt,
    at: new Date().toISOString(),
    passed,
    mods: stats.mods,
    stats: stats.hits,
    pp: stats.pp,
    maxCombo: stats.maxCombo,
    timing: timingSummary(stats.hitErrors, stats.mods),
    playerName: current?.playerName ?? '',
    songsFolder: current?.songsFolder ?? '',
    gameFolder: current?.gameFolder ?? '',
  }).catch(() => {});
}

// ---------- recommendations ----------

const FOCUS_HINTS = {
  fit: 'Ranked maps around your level that play to your strongest skillsets. Good for pp.',
  pp: 'Ranked maps around your level where a good play would raise your total pp, as a new top play or by beating your score, '
    + 'by how much it adds. The expected accuracy comes from your top plays on maps of similar difficulty.',
  warmup: 'Maps of all kinds a bit below your level, to warm up on before harder maps.',
  train: (label) => `Maps that focus on ${label}, slightly above your ${label} rating.`,
};
let recs = null; // last result from the main process
let recsFocus = 'fit';
let recsSource = 'all';
let recsLoading = false;
let recsStale = false; // a map was imported while loading, so the result is already out of date

const SOURCE_LABELS = { all: 'All maps', local: 'Downloaded', online: 'Not downloaded' };
// Statuses shown on a card; ranked and approved maps get no label.
const STATUS_LABELS = {
  loved: 'Loved',
  qualified: 'Qualified',
  pending: 'Unranked',
  wip: 'Unranked',
  graveyard: 'Unranked',
  unsubmitted: 'Unsubmitted',
};

/** `quiet` keeps the current list on screen, for refreshes while online maps are being rated. */
async function loadRecommendations({ refresh = false, quiet = false } = {}) {
  if (recsLoading) return;
  if (!config.hasCredentials) {
    showRecsBanner('Add your osu! API client ID and secret in ⚙ Settings first.');
    return;
  }
  recsLoading = true;
  if (!quiet) {
    showRecsBanner('');
    $('profile-refresh').disabled = true;
    $('recs-note').textContent = 'Loading…';
    renderFocusPicker();
  }
  try {
    recs = await window.tracker.getRecommendations({
      playerName: current?.playerName ?? '',
      songsFolder: current?.songsFolder ?? '',
      focus: recsFocus,
      source: recsSource,
      refresh,
    });
    recsFocus = recs.focus;
    recsSource = recs.source;
  } catch (err) {
    showRecsBanner(err.message);
  } finally {
    recsLoading = false;
    $('profile-refresh').disabled = false;
  }
  renderRecommendations();
  if (recsStale) {
    recsStale = false;
    loadRecommendations({ quiet: true });
  }
}

/** osu! has imported a downloaded set and the library was rescanned, so it counts as downloaded now. */
function onBeatmapImported(setId) {
  if (recsLoading) recsStale = true;
  else if (recs) loadRecommendations({ quiet: true });
  const map = awaitingImport.get(setId);
  if (!map) return;
  awaitingImport.delete(setId);
  // osu! selects a difficulty of the imported set itself and can't be told which without
  // osu!supporter, so the search for the recommended one is copied unless it's already selected.
  if (current?.beatmapId === map.beatmapId) switchToGame();
  else copySearch(map, (search) => `${map.title} is in osu!. Copied "${search}": paste it into song select with Ctrl+V to pick ${map.version}.`);
}

/** After a map has been picked from the recommendations, show the game if the setting is on. */
function switchToGame() {
  if (config.switchToGame) showView('game');
}

function showRecsBanner(message) {
  $('recs-banner').textContent = message;
  $('recs-banner').classList.toggle('hidden', !message);
}

function onRecommendationsProgress({ stage, done, total, ...online }) {
  if (stage === 'online') {
    if (!recs) return;
    recs.online = { ...recs.online, ...online };
    renderOnlineStatus();
    if (online.update && !$('view-recs').classList.contains('hidden')) loadRecommendations({ quiet: true });
    return;
  }
  const what = stage === 'library' ? 'Scanning Songs folder' : 'Rating your plays';
  $('recs-note').textContent = `${what}… ${fmtInt(done)} / ${fmtInt(total)}`;
  if (updatingProfile) $('skills-note').textContent = $('recs-note').textContent;
}

function setFocus(focus) {
  if (recsLoading || focus === recsFocus) return;
  recsFocus = focus;
  loadRecommendations();
}

function setSource(source) {
  if (recsLoading || source === recsSource) return;
  recsSource = source;
  loadRecommendations();
}

function renderSourcePicker() {
  $('recs-source').replaceChildren(...Object.entries(SOURCE_LABELS).map(([key, label]) => el('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(key === recsSource),
    class: `mod-chip${key === recsSource ? ' active' : ''}`,
    disabled: recsLoading,
    onclick: () => setSource(key),
  }, label)));
}

function renderOnlineStatus() {
  const online = recs?.online;
  if (!online) {
    $('recs-online').textContent = '';
    return;
  }
  const range = online.range ? ` ${online.range.low.toFixed(1)}–${online.range.high.toFixed(1)}★` : '';
  // `count` is from the last load; maps rated since then are added to it.
  let text = `${fmtInt(online.count + online.rated - (recs.onlineRatedAtLoad ?? online.rated))} ranked${range} maps rated from osu.ppy.sh`;
  if (online.running) text += ` · rating more in the background (${fmtInt(online.rated)} this session)`;
  else if (online.error) text += ` · couldn't get more: ${online.error}`;
  $('recs-online').textContent = text;
  $('recs-online').title = 'Maps you don\'t have are found with the osu! beatmap search (most played first) and rated from their .osu file. Only the ratings are kept.';
}

function renderFocusPicker() {
  renderSourcePicker();
  const weakest = recs?.analysis.weakest;
  const chip = (key, label, title) => el('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(key === recsFocus),
    class: `mod-chip${key === recsFocus ? ' active' : ''}`,
    disabled: recsLoading,
    title,
    onclick: () => setFocus(key),
  }, label);
  $('recs-focus').replaceChildren(
    chip('fit', 'Best fit', FOCUS_HINTS.fit),
    chip('pp', 'pp gain', FOCUS_HINTS.pp),
    chip('warmup', 'Warmup', FOCUS_HINTS.warmup),
    ...Object.entries(SKILLSET_LABELS).map(([key, label]) =>
      chip(key, key === weakest ? `Train ${label} · weakest` : `Train ${label}`, FOCUS_HINTS.train(label))),
  );
}

const PROFILE_SOURCES = { top: 'from your top plays', 'mania-tracker': 'from mania-tracker.com', history: 'from your play history' };

function renderProfile() {
  const { ratings, analysis, user, playCount, builtAt, sources } = recs;
  $('profile-note').textContent = `${user.username} · ${playCount} maps · built ${new Date(builtAt).toLocaleTimeString()}`;
  $('profile-note').title = Object.entries(sources ?? {}).map(([key, count]) => `${count} ${PROFILE_SOURCES[key] ?? key}`).join('\n');
  const head = el('div', { class: 'skills-head' },
    el('b', { title: 'Etterna-style player rating from MinaCalc score ratings of your best play on each map' }, `Overall ${ratings.overall.toFixed(2)}`),
    el('span', { class: 'muted' },
      ` · strongest: ${analysis.strengths.map((s) => SKILLSET_LABELS[s]).join(', ')}`,
      ` · weakest: ${SKILLSET_LABELS[analysis.weakest]}`),
  );
  // Bars run from the weakest rating (shortest) to the strongest (full), so the differences show.
  const values = Object.keys(SKILLSET_LABELS).map((key) => ratings[key]);
  const [min, max] = [Math.min(...values), Math.max(...values)];
  const rows = Object.entries(SKILLSET_LABELS).map(([key, label]) => {
    const fill = el('div', { class: 'skill-fill' });
    fill.style.width = `${max > min ? 10 + ((ratings[key] - min) / (max - min)) * 90 : 100}%`;
    return el('div', {
      class: `skill profile-skill${analysis.strengths.includes(key) ? ' top' : ''}${key === analysis.weakest ? ' weak' : ''}`,
      title: `${label} rating ${ratings[key].toFixed(2)}`,
    },
    el('span', {}, label),
    el('div', { class: 'skill-bar' }, fill),
    el('b', {}, ratings[key].toFixed(1)),
    );
  });
  const counts = Object.entries(sources ?? {}).map(([key, count]) => `${fmtInt(count)} ${PROFILE_SOURCES[key] ?? key}`);
  $('profile').replaceChildren(head, el('div', { class: 'skills profile-skills' }, rows),
    el('p', { class: 'hint' }, `Your best play on each of ${fmtInt(playCount)} maps: ${counts.join(', ')}. `
      + 'Skillsets you rarely play can look weaker than they are.'),
    danSummary(recs.dan, recs.maniaTracker?.dan),
    trackerSummary(recs.maniaTracker, !recs.dan));
}

const DAN_SKILLS = { jack: 'Jack', tech: 'Tech', speed: 'Speed', stamina: 'Stamina' };

const passName = (p) => `${p.title} [${p.version}]${p.mods.length ? ` +${p.mods.join('')}` : ''} · ${fmtAcc(p.accuracy)}`;

/** The dan estimate, overall and per skill, with mania-tracker.com's next to it if there is one. */
function danSummary(dan, trackerDan) {
  if (!dan) return null;
  const skills = Object.entries(DAN_SKILLS).map(([key, name]) => {
    const skill = dan.skills[key];
    if (!skill) return el('span', { class: 'dan-skill muted', title: `Fewer than 4 passes count towards ${name}` }, `${name} –`);
    const title = [
      `${name} ${skill.raw.toFixed(2)}: the average of your ${skill.passes} best passes in it`,
      ...(skill.floor ? [`Set by your pass of ${passName(skill.floor)}`] : []),
      ...(skill.top.length ? ['', 'Best passes (dan credited):', ...skill.top.map((p) => `${p.credited.toFixed(2)}  ${passName(p)}`)] : []),
    ].join('\n');
    const tracker = trackerDan?.skillsets?.[key];
    return el('span', { class: 'dan-skill', title }, `${name} `, el('b', {}, `~${skill.label}`),
      tracker ? el('span', { class: 'muted' }, ` (${tracker})`) : null);
  });
  const title = [
    `Estimated dan ${dan.raw.toFixed(2)}: the average of your skills, from ${dan.passes} passes`,
    ...(dan.course ? [`Set by your pass of the dan course ${passName(dan.course)}`] : []),
    '',
    'Each 4K regular chart gets a dan from its MinaCalc rating, each pass is credited',
    "that dan adjusted by its accuracy against a 96% bar, and each skill's dan is the",
    'average of its 20 best passes, following mania-tracker.com\'s published method.',
    "mania-tracker.com rates charts with its own engine, so this can differ by a few steps.",
  ].join('\n');
  return el('div', { class: 'dan' },
    el('span', { title }, 'Dan ', el('b', {}, `~${dan.label}`)),
    ...skills,
    trackerDan ? el('span', { class: 'muted', title: "mania-tracker.com's dan, and per skill in brackets" }, `mania-tracker.com: ${trackerDan.label}`) : null);
}

async function openBeatmap(beatmapId) {
  try {
    await window.tracker.openBeatmap(beatmapId);
  } catch (err) {
    showRecsBanner(err.message);
  }
}

let toastTimer = null;

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4000);
}

/** Song select search for a map: its title and difficulty, without words osu! reads as filters. */
function songSelectSearch(map) {
  return `${map.title} ${map.version}`.split(/\s+/).filter((w) => w && !/[=<>]/.test(w)).join(' ');
}

async function copySearch(map, message = (search) => `Copied "${search}". Paste it into song select with Ctrl+V.`) {
  const search = songSelectSearch(map);
  try {
    await window.tracker.copyText(search);
    showToast(message(search));
    switchToGame();
  } catch (err) {
    showRecsBanner(err.message);
  }
}

const downloading = new Set(); // beatmap set IDs being downloaded
const awaitingImport = new Map(); // downloaded set ID -> recommended map, until osu! has imported it

async function downloadMap(map) {
  if (downloading.has(map.setId)) return;
  downloading.add(map.setId);
  showToast(`Downloading ${map.title}…`);
  try {
    await window.tracker.downloadBeatmap(map.setId, current?.songsFolder ?? '');
    showToast(`Opened ${map.title} in osu!. Its difficulty search is copied once osu! has imported it.`);
    awaitingImport.set(map.setId, map);
  } catch (err) {
    $('toast').classList.add('hidden');
    showRecsBanner(err.message);
  } finally {
    downloading.delete(map.setId);
  }
}

/**
 * What clicking a card does. osu! stable only opens osu://b links in game for supporters (others
 * get the website), so without supporter a downloaded map's song select search is copied and a
 * map that isn't downloaded is fetched from a mirror and opened in osu!, which imports it.
 */
function cardAction(map) {
  const submitted = map.beatmapId > 0;
  if (recs?.user.supporter && submitted) {
    return {
      run: () => openBeatmap(map.beatmapId),
      title: map.source === 'online' ? 'Open in osu!direct' : 'Open in osu!',
    };
  }
  if (map.source === 'local') {
    return { run: () => copySearch(map), title: 'Copy a song select search for this map (opening it in osu! directly needs osu!supporter)' };
  }
  if (map.setId > 0) return { run: () => downloadMap(map), title: 'Download this map and open it in osu!' };
  return {
    run: () => window.open(`https://osu.ppy.sh/b/${map.beatmapId}`, '_blank'),
    title: 'Open the beatmap page to download it (osu!direct needs osu!supporter)',
  };
}

function recRow(map) {
  const submitted = map.beatmapId > 0;
  const online = map.source === 'online';
  const action = cardAction(map);
  const labels = [
    online && el('span', { class: 'pill pill-online', title: "Not in your Songs folder" }, 'Not downloaded'),
    STATUS_LABELS[map.status] && el('span', { class: 'pill pill-warn', title: 'No pp from this map' }, STATUS_LABELS[map.status]),
    map.outdated && el('span', { class: 'pill pill-warn', title: 'Your copy differs from the version on osu.ppy.sh' }, 'Update needed'),
  ];
  return el('li', {
    class: 'rec-row clickable',
    title: action.title,
    role: 'button',
    tabindex: '0',
    onclick: action.run,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action.run(); } },
  },
    el('div', { class: 'rec-main' },
      el('span', {}, `${map.title} [${map.version}]`),
      el('div', { class: 'lb-details' }, `${map.artist} · mapped by ${map.creator}`),
    ),
    el('div', { class: 'rec-tags' }, labels, map.tags.map((t) => el('span', { class: 'pill' }, SKILLSET_LABELS[t]))),
    map.expected
      ? el('div', { class: 'rec-msd', title: `About ${map.expected.accuracy}% expected, for ${Math.round(map.expected.pp)} pp · overall MSD ${map.msd.overall.toFixed(2)}` },
        el('b', {}, `+${map.expected.gain.toFixed(1)}`),
        el('span', { class: 'muted' }, 'total pp'),
      )
      : el('div', { class: 'rec-msd', title: `${SKILLSET_LABELS[map.skill]} ${map.msd[map.skill].toFixed(2)} · overall MSD ${map.msd.overall.toFixed(2)}` },
        el('b', {}, map.value.toFixed(2)),
        el('span', { class: 'muted' }, SKILLSET_LABELS[recsFocus] ? SKILLSET_LABELS[map.skill] : 'MSD'),
      ),
    submitted
      ? el('a', {
        class: 'btn btn-ghost btn-small',
        href: `https://osu.ppy.sh/b/${map.beatmapId}`,
        target: '_blank',
        title: 'Open the beatmap page on osu.ppy.sh',
        onclick: (e) => e.stopPropagation(),
        onkeydown: (e) => e.stopPropagation(),
      }, 'Website ↗')
      : el('span'),
    map.pp && el('div', { class: 'rec-pp', title: 'Estimated pp without mods at each accuracy' },
      el('span', { class: 'rec-pp-label' }, 'pp'),
      map.expected && el('span', { class: 'rec-pp-expected', title: 'Accuracy of a good play for you on a map this hard, and its pp' },
        `expected ${map.expected.accuracy}% `, el('b', {}, fmtInt(Math.round(map.expected.pp)))),
      map.expected?.current && el('span', { class: 'rec-pp-current', title: 'Your score on this map in your top plays, which a better play would replace' },
        [`yours ${(map.expected.current.accuracy * 100).toFixed(2)}%`, modsText(map.expected.current.mods)].filter(Boolean).join(' '), ' ',
        el('b', {}, fmtInt(Math.round(map.expected.current.pp)))),
      Object.entries(map.pp).map(([acc, pp]) => el('span', {}, `${acc}% `, el('b', {}, fmtInt(Math.round(pp)))))),
  );
}

function renderRecommendations() {
  renderFocusPicker();
  if (!recs) {
    $('recs-note').textContent = '';
    return;
  }
  renderProfile();
  $('recs-note').textContent = `${fmtInt(recs.library.count)} 4K maps in your Songs folder`;
  $('recs-note').title = recs.library.folder;
  recs.onlineRatedAtLoad = recs.online.rated;
  renderOnlineStatus();
  const label = SKILLSET_LABELS[recsFocus];
  $('recs-hint').textContent = label ? FOCUS_HINTS.train(label) : FOCUS_HINTS[recsFocus];
  $('recs-list').replaceChildren(...(recs.maps.length
    ? recs.maps.map(recRow)
    : [el('li', { class: 'placeholder muted' }, recsFocus === 'pp'
      ? 'No ranked maps around your level would raise your total pp yet. Try Not downloaded, or wait for more maps from osu.ppy.sh to be rated.'
      : recsSource === 'local'
      ? 'No maps in your Songs folder match. Download a few maps at your level and rebuild.'
      : 'No maps match yet. If maps from osu.ppy.sh are still being rated, they show up here as they come in.')]));
}

// ---------- progress: sessions, skill progress, play history ----------

const PROGRESS_RELOAD_MS = 1000;
const HISTORY_PAGE = 100;
const SKILL_COLORS = {
  overall: '#ff66aa', stream: '#66ccff', jumpstream: '#7ee08a', handstream: '#f0c060',
  stamina: '#ff8c5a', jackspeed: '#b38cff', chordjack: '#e6f2ff', technical: '#4dd0c8',
};
const SKILL_NAMES = { overall: 'Overall', ...SKILLSET_LABELS };
const HISTORY_FILTERS = { all: 'All', passed: 'Passed', pb: 'Personal bests', failed: 'Failed or quit' };
const SOURCE_NAMES = { tosu: 'Recorded', 'osu-api': 'osu! API', 'mania-tracker': 'mania-tracker.com' };

let progress = null; // last result from the main process
let progressLoading = false;
let progressStale = false; // the history changed while loading
let progressTimer = null;
let historyFilter = 'all';
let historyShown = HISTORY_PAGE;
let skillSource = null; // 'app' or 'tracker'; picked once data is in
const hiddenSkills = new Set(); // skillsets left out of the chart
let updatingProfile = false;

const fmtDate = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

function fmtDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** osu!stable's grade for an accuracy (0..1); F for plays that weren't passed. */
function gradeOf(play) {
  if (!play.passed) return 'F';
  const silver = play.mods.some((m) => m === 'HD' || m === 'FL' || m === 'FI');
  const a = play.accuracy;
  if (a >= 1) return silver ? 'XH' : 'X';
  if (a > 0.95) return silver ? 'SH' : 'S';
  return a > 0.9 ? 'A' : a > 0.8 ? 'B' : a > 0.7 ? 'C' : 'D';
}

function isProgressVisible() {
  return !$('view-progress').classList.contains('hidden');
}

async function loadProgress() {
  if (progressLoading) {
    progressStale = true;
    return;
  }
  progressLoading = true;
  try {
    progress = await window.tracker.getHistory({ playerName: current?.playerName ?? '', songsFolder: current?.songsFolder ?? '' });
    showProgressBanner(progress.error ?? '');
  } catch (err) {
    showProgressBanner(err.message);
  } finally {
    progressLoading = false;
  }
  renderProgress();
  if (progressStale) {
    progressStale = false;
    loadProgress();
  }
}

/** The history changed (a play was recorded, rated or checked); reload the tab if it's open. */
function onHistoryUpdated() {
  if (!isProgressVisible()) return; // reloaded when the tab is opened
  clearTimeout(progressTimer);
  progressTimer = setTimeout(loadProgress, PROGRESS_RELOAD_MS);
}

function showProgressBanner(message) {
  $('progress-banner').textContent = message;
  $('progress-banner').classList.toggle('hidden', !message);
}

function renderProgress() {
  if (!progress) return;
  renderSessions();
  renderTimingSummary();
  renderSkillProgress();
  renderHistory();
}

function statCell(label, value, title, cls = '') {
  return el('div', { class: `stat-cell ${cls}`, title }, el('span', {}, label), el('b', {}, value));
}

function signed(value, digits = 0) {
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : '±0';
}

function playLine(label, play) {
  return el('div', { class: 'session-play' },
    el('span', { class: 'muted' }, label),
    el('span', {}, `${play.title} [${play.version}] `, el('span', { class: 'mods' }, modsText(play.mods))),
    el('span', { class: 'muted' }, [
      fmtAcc(play.accuracy),
      play.pp != null ? `${fmtInt(play.pp)}pp` : null,
      play.ssr ? `rating ${play.ssr.toFixed(2)}` : null,
    ].filter(Boolean).join(' · ')));
}

function renderSessions() {
  const [session, ...older] = progress.sessions;
  if (!session) {
    $('session-note').textContent = '';
    $('session').replaceChildren(el('p', { class: 'muted' },
      'No plays yet. Plays are recorded from tosu while the app is open, and your recent plays are imported from the osu! API.'));
    $('past-sessions').replaceChildren();
    return;
  }
  $('session-note').textContent = `${session.ongoing ? 'Current session' : 'Last session'} · ${fmtDate(session.start)} – `
    + `${session.ongoing ? 'now' : new Date(session.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const pp = session.pp ? session.pp.after - session.pp.before : null;
  const rank = session.rank ? session.rank.before - session.rank.after : null; // positive = climbed
  // The app was started during the session, so the change only counts from then.
  const since = session.pp?.since ? ` (since ${new Date(session.pp.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '';
  const cells = [
    statCell('Plays', fmtInt(session.plays), 'Attempts recorded in this session, passed or not'),
    statCell('Passed', `${fmtInt(session.passed)} · ${Math.round((session.passed / session.plays) * 100)}%`, 'Plays that reached the results screen'),
    statCell('Accuracy', session.accuracy != null ? fmtAcc(session.accuracy) : '–', 'Average accuracy of the passed plays'),
    statCell('Time played', session.playTime ? fmtDuration(session.playTime) : '–',
      'Time spent in plays: measured for plays recorded from tosu, the map\'s length for imported passes'),
    statCell('Notes hit', fmtInt(session.notes), 'Judgements in all plays of the session, misses included'),
    statCell(`pp${since ? '*' : ''}`, pp != null ? signed(pp, 1) : '–',
      session.pp ? `${fmtInt(session.pp.before)}pp → ${fmtInt(session.pp.after)}pp${since}` : 'Checked when a play starts and after each play, while the app is open',
      pp > 0 ? 'up' : pp < 0 ? 'down' : ''),
    statCell(`Rank${since ? '*' : ''}`, rank != null ? signed(rank) : '–',
      session.rank ? `#${fmtInt(session.rank.before)} → #${fmtInt(session.rank.after)} global${since}` : 'Checked when a play starts and after each play, while the app is open',
      rank > 0 ? 'up' : rank < 0 ? 'down' : ''),
    statCell('New PBs', fmtInt(session.pbs.length), 'Plays that became your best score on their map', session.pbs.length ? 'up' : ''),
  ];
  $('session').replaceChildren(...[
    el('div', { class: 'stat-grid' }, cells),
    session.best && playLine('Best pp', session.best),
    session.bestRated && session.bestRated.id !== session.best?.id && playLine('Highest rated', session.bestRated),
    ...session.pbs.map((p) => playLine('New PB', p)),
  ].filter(Boolean));

  $('past-sessions').replaceChildren(...(older.length ? [
    el('h3', { class: 'subtitle' }, 'Earlier sessions'),
    el('ol', { class: 'session-list' }, older.map((s) => el('li', {},
      el('span', {}, fmtDate(s.start)),
      el('span', { class: 'muted' }, fmtDuration(new Date(s.end) - new Date(s.start))),
      el('span', {}, `${fmtInt(s.plays)} plays · ${fmtInt(s.passed)} passed`),
      el('span', {}, s.accuracy != null ? fmtAcc(s.accuracy) : '–'),
      el('span', { class: s.pp && s.pp.after > s.pp.before ? 'up' : '' }, s.pp ? `${signed(s.pp.after - s.pp.before, 1)}pp` : ''),
      el('span', { class: s.rank && s.rank.after < s.rank.before ? 'up' : '' }, s.rank ? `${signed(s.rank.before - s.rank.after)} rank` : ''),
      el('span', { class: s.pbs.length ? 'up' : 'muted' }, s.pbs.length ? `${s.pbs.length} PB${s.pbs.length > 1 ? 's' : ''}` : ''),
    ))),
  ] : []));
}

/** One line about the player on mania-tracker.com: ratings, standing, and dan unless it's next to the app's. */
const MIN_OFFSET_PLAYS = 5;
const MIN_OFFSET_MS = 3; // closer to 0 than this isn't worth changing

/** Your timing over recent plays, and the universal offset change that would centre it. */
function renderTimingSummary() {
  const t = progress.timing;
  if (!t) {
    $('timing-note').textContent = '';
    $('timing').replaceChildren(el('p', { class: 'muted' },
      'Play a few maps with the app open. Your hit timing is read from tosu while you play, so imported plays have none.'));
    return;
  }
  $('timing-note').textContent = `Your last ${fmtInt(t.plays)} plays recorded from tosu`;
  const cells = [
    statCell('Average timing', t.mean == null ? '–' : timingText(t.mean),
      'Average hit error, weighted by hits, of your plays without rate mods on maps with few long notes'),
    statCell('Average UR', t.ur.toFixed(0), 'Unstable rate: how spread out your hits are. Lower is more consistent.'),
  ];
  let advice;
  if (t.mean == null || t.offsetPlays < MIN_OFFSET_PLAYS) {
    advice = `An offset suggestion needs at least ${MIN_OFFSET_PLAYS} plays without rate mods on maps with few long notes `
      + `(${fmtInt(t.offsetPlays)} so far).`;
  } else if (Math.abs(t.mean) < MIN_OFFSET_MS) {
    advice = 'Your timing is centred: no offset change needed.';
  } else {
    const change = Math.round(Math.abs(t.mean));
    advice = `You hit ${timingText(t.mean)} on average over ${fmtInt(t.offsetPlays)} plays. `
      + `${t.mean > 0 ? 'Lower' : 'Raise'} your universal offset by about ${change} ms `
      + `(Options → Audio → Offset adjustment) to centre it.`
      + (t.spread > Math.abs(t.mean) ? ' Your plays disagree a lot, so check it again after a few more.' : '');
  }
  $('timing').replaceChildren(el('div', { class: 'stat-grid' }, cells), el('p', { class: 'hint timing-advice' }, advice));
}

function trackerSummary(skills, showDan = true) {
  if (!skills) return null;
  const dan = skills.dan && showDan
    ? ` · dan ${skills.dan.label}${Object.keys(skills.dan.skillsets).length
      ? ` (${Object.entries(skills.dan.skillsets).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`
    : '';
  const top = skills.top ? ` · top ${skills.top.percent.toFixed(skills.top.percent < 1 ? 2 : 1)}% of ${fmtInt(skills.top.population)} tracked 4K players` : '';
  return el('p', { class: 'hint tracker-summary', title: Object.entries(SKILL_NAMES).map(([k, n]) => `${n} ${skills.ratings[k]?.toFixed(2) ?? '–'}`).join('\n') },
    el('a', { href: skills.url, target: '_blank' }, 'mania-tracker.com'),
    `: overall ${skills.ratings.overall.toFixed(2)}${top}${dan}, from ${fmtInt(skills.plays)} rated plays`,
    ' (it counts a different set of plays and works out Overall differently, so its ratings differ a little from this app\'s)');
}

function skillSeries() {
  const app = progress.skills.map((s) => ({ at: s.at, ratings: s.ratings }));
  const tracker = progress.maniaTracker?.history ?? [];
  return { app, tracker };
}

function renderSkillProgress() {
  const series = skillSeries();
  // Start on whichever source has more history.
  skillSource ??= series.app.length >= 2 || series.tracker.length < 2 ? 'app' : 'tracker';
  const sources = { app: 'This app', tracker: 'mania-tracker.com' };
  $('skill-source').replaceChildren(...Object.entries(sources).map(([key, label]) => el('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(key === skillSource),
    class: `mod-chip${key === skillSource ? ' active' : ''}`,
    disabled: key === 'tracker' && !progress.maniaTracker?.history?.length,
    title: key === 'app'
      ? 'Your skill profile each time it changed: when it is built or updated, and after each passed play once it has been built'
      : 'Rating history of your 4K plays on mania-tracker.com',
    onclick: () => { skillSource = key; renderSkillProgress(); },
  }, label)));

  $('skill-legend').replaceChildren(...Object.entries(SKILL_NAMES).map(([key, name]) => {
    const shown = !hiddenSkills.has(key);
    const dot = el('i', { class: 'legend-dot' });
    dot.style.background = SKILL_COLORS[key];
    return el('button', {
      type: 'button',
      class: `mod-chip legend-chip${shown ? ' active' : ''}`,
      'aria-pressed': String(shown),
      onclick: () => {
        if (shown) hiddenSkills.add(key);
        else hiddenSkills.delete(key);
        renderSkillProgress();
      },
    }, dot, name);
  }));

  const points = series[skillSource];
  const last = progress.skills.at(-1);
  $('skills-note').textContent = updatingProfile
    ? $('skills-note').textContent
    : last ? `${progress.skills.length} snapshot${progress.skills.length > 1 ? 's' : ''} · last ${timeAgo(last.at)}` : '';
  const trackerError = progress.maniaTracker?.error;
  $('tracker-summary').replaceChildren(...[
    danSummary(progress.profile?.dan, progress.maniaTracker?.skills?.dan),
    trackerSummary(progress.maniaTracker?.skills, !progress.profile?.dan),
    trackerError ? el('p', { class: 'hint' }, `Couldn't load mania-tracker.com: ${trackerError}`) : null,
    config.maniaTracker && progress.user && progress.maniaTracker && !progress.maniaTracker.skills && !trackerError
      ? el('p', { class: 'hint' }, 'mania-tracker.com doesn\'t track you yet. Look yourself up on the site to start tracking.')
      : null,
  ].filter(Boolean));

  if (points.length === 0) {
    $('skill-chart').replaceChildren(el('p', { class: 'muted' }, skillSource === 'app'
      ? 'No snapshots yet. Click ⟳ Update (or open Recommended) to build your skill profile; it is snapshotted every time it changes.'
      : 'No rating history on mania-tracker.com.'));
    $('skill-readout').textContent = '';
    return;
  }
  drawSkillChart(points);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

/** Line chart of the ratings over time, one line per shown skillset. */
function drawSkillChart(points) {
  const [width, height] = [800, 240];
  const pad = { left: 40, right: 12, top: 10, bottom: 24 };
  const keys = Object.keys(SKILL_NAMES).filter((k) => !hiddenSkills.has(k));
  const values = points.flatMap((p) => keys.map((k) => p.ratings[k]).filter((v) => v > 0));
  if (values.length === 0) {
    $('skill-chart').replaceChildren(el('p', { class: 'muted' }, 'Pick a skillset below.'));
    return;
  }
  let [low, high] = [Math.min(...values), Math.max(...values)];
  const margin = Math.max(0.2, (high - low) * 0.1);
  low = Math.floor((low - margin) * 2) / 2;
  high = Math.ceil((high + margin) * 2) / 2;
  const times = points.map((p) => new Date(p.at).getTime());
  const [first, end] = [times[0], times.at(-1)];
  const x = (t) => pad.left + (end > first ? ((t - first) / (end - first)) * (width - pad.left - pad.right) : (width - pad.left - pad.right) / 2);
  const y = (v) => pad.top + (1 - (v - low) / (high - low)) * (height - pad.top - pad.bottom);

  const grid = [];
  const step = high - low > 4 ? 1 : 0.5;
  for (let v = Math.ceil(low / step) * step; v <= high; v += step) {
    grid.push(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'chart-grid' }));
    grid.push(svgEl('text', { x: pad.left - 6, y: y(v) + 4, class: 'chart-label', 'text-anchor': 'end' }, String(v)));
  }
  const dates = end > first ? [first, (first + end) / 2, end] : [first];
  const anchors = end > first ? ['start', 'middle', 'end'] : ['middle'];
  dates.forEach((t, i) => grid.push(svgEl('text', { x: x(t), y: height - 6, class: 'chart-label', 'text-anchor': anchors[i] }, fmtDay(new Date(t).toISOString()))));

  const lines = keys.map((k) => {
    const pts = points.map((p, i) => (p.ratings[k] > 0 ? `${x(times[i]).toFixed(1)},${y(p.ratings[k]).toFixed(1)}` : null)).filter(Boolean);
    const color = SKILL_COLORS[k];
    return svgEl('g', {},
      svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': k === 'overall' ? 2.5 : 1.5, 'stroke-linejoin': 'round' }),
      ...(points.length <= 60 ? pts.map((pt) => {
        const [cx, cy] = pt.split(',');
        return svgEl('circle', { cx, cy, r: 2.5, fill: color });
      }) : []));
  });
  const cursor = svgEl('line', { y1: pad.top, y2: height - pad.bottom, class: 'chart-cursor', visibility: 'hidden' });
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'skill-chart', role: 'img', 'aria-label': 'Skill ratings over time' },
    ...grid, ...lines, cursor);

  const readout = (i) => {
    const p = points[i];
    $('skill-readout').replaceChildren(el('b', {}, fmtDate(p.at)), ...Object.keys(SKILL_NAMES)
      .filter((k) => p.ratings[k] > 0)
      .map((k) => el('span', { class: hiddenSkills.has(k) ? 'muted' : '' }, `${SKILL_NAMES[k]} ${p.ratings[k].toFixed(2)}`)));
  };
  // Hovering shows the ratings of the nearest snapshot; otherwise the latest.
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const t = first + (((e.clientX - box.left) / box.width) * width - pad.left) / (width - pad.left - pad.right) * (end - first);
    let nearest = 0;
    times.forEach((time, i) => { if (Math.abs(time - t) < Math.abs(times[nearest] - t)) nearest = i; });
    cursor.setAttribute('x1', x(times[nearest]));
    cursor.setAttribute('x2', x(times[nearest]));
    cursor.setAttribute('visibility', 'visible');
    readout(nearest);
  });
  svg.addEventListener('mouseleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    readout(points.length - 1);
  });
  $('skill-chart').replaceChildren(svg);
  readout(points.length - 1);
}

async function updateProfileFromProgress() {
  if (updatingProfile) return;
  updatingProfile = true;
  $('skills-update').disabled = true;
  $('skills-note').textContent = 'Building your profile…';
  try {
    await window.tracker.updateProfile({ playerName: current?.playerName ?? '', songsFolder: current?.songsFolder ?? '' });
    recs = null; // rebuilt, so the Recommended tab reloads with it
  } catch (err) {
    showProgressBanner(err.message);
  } finally {
    updatingProfile = false;
    $('skills-update').disabled = false;
  }
  await loadProgress();
}

function historyRow(play) {
  const ratio = play.stats['300'] > 0 ? `${(play.stats.max / play.stats['300']).toFixed(2)}:1` : null;
  const grade = gradeOf(play);
  return el('li', { class: `history-row${play.passed ? '' : ' failed'}` },
    el('span', { class: 'muted history-time', title: new Date(play.at).toLocaleString() }, fmtDate(play.at)),
    el('div', { class: `grade grade-${grade}` }, gradeLabel(grade)),
    el('div', { class: 'rec-main' },
      play.beatmapId > 0
        ? el('a', { class: 'history-title', href: `https://osu.ppy.sh/b/${play.beatmapId}`, target: '_blank' }, `${play.title} [${play.version}]`)
        : el('span', { class: 'history-title' }, `${play.title} [${play.version}]`),
      el('div', { class: 'lb-details' },
        [`${fmtInt(play.maxCombo ?? 0)}x`, ratio && `MAX:300 ${ratio}`, `${fmtInt(play.stats.miss)} miss`,
          play.timing && `UR ${play.timing.ur.toFixed(0)}, ${timingText(play.timing.mean)}`].filter(Boolean).join(' · '), ' ',
        el('span', { class: 'mods' }, modsText(play.mods)))),
    el('div', { class: 'rec-tags' },
      play.pb && el('span', { class: 'pill pill-online', title: 'Became your best score on this map' }, 'PB'),
      !play.passed && el('span', { class: 'pill pill-warn' }, 'Failed or quit'),
      play.source !== 'tosu' && el('span', { class: 'pill', title: 'Imported, so it was played while the app was closed' }, SOURCE_NAMES[play.source] ?? play.source)),
    el('div', { class: 'history-acc' }, fmtAcc(play.accuracy)),
    el('div', { class: 'lb-pp', title: play.pp == null ? 'No pp: not submitted, or the map isn\'t ranked' : null }, fmtPp(play.pp)),
    el('div', { class: 'rec-msd', title: play.ssr ? `Score rating (MinaCalc) at ${(play.rate ?? 1)}x · map MSD ${play.msd?.toFixed(2)}` : 'Only passed 4K plays are rated' },
      el('b', {}, play.ssr ? play.ssr.overall.toFixed(2) : '–'), el('span', { class: 'muted' }, 'rating')),
  );
}

function renderHistory() {
  $('history-filter').replaceChildren(...Object.entries(HISTORY_FILTERS).map(([key, label]) => el('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(key === historyFilter),
    class: `mod-chip${key === historyFilter ? ' active' : ''}`,
    onclick: () => { historyFilter = key; historyShown = HISTORY_PAGE; renderHistory(); },
  }, label)));
  const plays = progress.plays.filter((p) => historyFilter === 'all'
    || (historyFilter === 'passed' && p.passed)
    || (historyFilter === 'pb' && p.pb)
    || (historyFilter === 'failed' && !p.passed));
  $('history-note').textContent = `${fmtInt(progress.totalPlays)} plays${progress.totalPlays > progress.plays.length ? ` · latest ${fmtInt(progress.plays.length)} shown` : ''}`;
  const rows = plays.slice(0, historyShown).map(historyRow);
  if (plays.length > historyShown) {
    rows.push(el('li', { class: 'history-more' }, el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      onclick: () => { historyShown += HISTORY_PAGE; renderHistory(); },
    }, `Show more (${fmtInt(plays.length - historyShown)} left)`)));
  }
  $('history-list').replaceChildren(...(rows.length ? rows : [el('li', { class: 'placeholder muted' }, 'No plays here yet.')]));
}

// ---------- settings ----------

const SETTINGS_KEYS = ['username', 'clientId', 'clientSecret', 'tosuUrl', 'songsFolder', 'replaysFolder'];

function openSettings() {
  const form = $('settings-form');
  for (const key of SETTINGS_KEYS) form.elements[key].value = config[key] ?? '';
  form.elements.switchToGame.checked = config.switchToGame;
  form.elements.maniaTracker.checked = config.maniaTracker;
  form.elements.danLevels.checked = config.danLevels;
  form.elements.overlay.checked = config.overlay;
  for (const box of form.elements.overlayPanels) box.checked = config.overlayPanels.includes(box.value);
  renderOverlayPanels();
  form.elements.saveReplays.checked = config.saveReplays;
  renderReplaysFolder();
  $('settings').classList.remove('hidden');
  form.elements.username.focus();
}

/** The choice of overlays only applies while the overlay is on. */
function renderOverlayPanels() {
  $('overlay-panels').disabled = !$('settings-form').elements.overlay.checked;
}

/** The replays folder only applies while saving replays is on. */
function renderReplaysFolder() {
  const form = $('settings-form');
  form.elements.replaysFolder.disabled = !form.elements.saveReplays.checked;
}

function closeSettings() {
  $('settings').classList.add('hidden');
}

async function saveSettings(event) {
  event.preventDefault();
  const form = $('settings-form');
  const patch = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, form.elements[k].value]));
  patch.switchToGame = form.elements.switchToGame.checked;
  patch.maniaTracker = form.elements.maniaTracker.checked;
  patch.danLevels = form.elements.danLevels.checked;
  patch.overlay = form.elements.overlay.checked;
  patch.overlayPanels = [...form.elements.overlayPanels].filter((box) => box.checked).map((box) => box.value);
  patch.saveReplays = form.elements.saveReplays.checked;
  const urlChanged = patch.tosuUrl.trim() !== config.tosuUrl;
  const recsChanged = patch.songsFolder.trim() !== config.songsFolder || patch.username.trim() !== config.username
    || patch.maniaTracker !== config.maniaTracker || patch.danLevels !== config.danLevels;

  config = await window.tracker.saveConfig(patch);
  closeSettings();
  credentialsBanner();
  if (urlChanged) tosu.connect(config.tosuUrl);
  loadScores();
  if (recsChanged && !$('view-recs').classList.contains('hidden')) loadRecommendations();
  else if (recsChanged) recs = null;
  if (isProgressVisible()) loadProgress();
}

// ---------- in-game overlay ----------

let overlayState = { running: false, locked: true };

function renderOverlayButton(state) {
  overlayState = state;
  const button = $('overlay-btn');
  button.classList.toggle('hidden', !state.running);
  button.textContent = state.locked ? '⤧ Move overlays' : '✓ Lock overlays';
  button.title = state.locked
    ? 'Unlock the in-game overlays to drag them into place and resize them by their corner'
    : 'Lock the overlays where they are, so clicks go through them to osu!';
}

// ---------- init ----------

async function init() {
  config = await window.tracker.getConfig();

  $('friend-form').addEventListener('submit', addFriend);
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('settings-form').elements.overlay.addEventListener('change', renderOverlayPanels);
  $('settings-form').elements.saveReplays.addEventListener('change', renderReplaysFolder);
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
  $('refresh-btn').addEventListener('click', loadScores);
  $('overlay-btn').addEventListener('click', () => window.tracker.lockOverlay(!overlayState.locked));
  for (const tab of document.querySelectorAll('.view-tab')) tab.addEventListener('click', () => showView(tab.dataset.view));
  $('profile-refresh').addEventListener('click', () => loadRecommendations({ refresh: true }));
  $('capture-start').addEventListener('click', selectCaptureWindow);
  $('capture-select').addEventListener('click', selectCaptureWindow);
  $('capture-stop').addEventListener('click', stopCapture);
  $('capture-video').addEventListener('resize', fitCaptureArea);
  $('skills-update').addEventListener('click', updateProfileFromProgress);
  window.tracker.onHistoryUpdated(onHistoryUpdated);
  window.tracker.onReplaySaved((name) => showToast(`Saved the replay of your new PB: ${name}`));
  window.tracker.onKey(onKey);
  window.tracker.onRecommendationsProgress(onRecommendationsProgress);
  window.tracker.onBeatmapImported(onBeatmapImported);
  window.tracker.onOverlayState(renderOverlayButton);
  renderOverlayButton(await window.tracker.getOverlayState());

  renderFriends();
  renderFocusPicker();
  renderModPicker();
  renderPlayHud();
  window.tracker.onRateLimit(renderRateLimit);
  renderRateLimit(await window.tracker.getRateLimit());
  credentialsBanner();
  if (!config.hasCredentials) openSettings();
  tosu.connect(config.tosuUrl);
}

init();
