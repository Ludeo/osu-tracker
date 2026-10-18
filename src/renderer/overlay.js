// The in-game overlays, one window each: the pp of the play in progress with the pp for an FC, the
// keys with keys per second (as in the Game view), and the judgements of the play. Shown while playing and on the results
// screen; unlocked, they're always shown so they can be dragged into place and resized.

/* global TosuClient, pickPb, paceOf, fmtPace */

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

const PANEL = ['keys', 'judgements'].find((name) => name === new URLSearchParams(location.search).get('panel')) ?? 'pp';
const KPS_WINDOW_MS = 1000;
const KPS_REFRESH_MS = 50;
const SHOWN_STATES = ['play', 'resultScreen'];

let locked = true;
let state = null;
let myScores = null; // { checksum, scores } your scores on the map the app last loaded, best first
let playPb = null; // the PB the latest play is compared with, kept after it ends (as in the app)
let keyFolder = null; // the game folder the keys were last read for
let keyLabels = ['D', 'F', 'J', 'K'];
let keyPressed = [false, false, false, false];
let keyPresses = [[], [], [], []]; // press times within the last KPS window, per column
let keyCounts = [0, 0, 0, 0]; // presses since the current play started
let shownHits = null; // the judgement counts on show

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function render() {
  $('overlay').classList.toggle('idle', locked && !SHOWN_STATES.includes(state?.state));
  $('overlay').classList.toggle('unlocked', !locked);
  $('lock').classList.toggle('hidden', locked);
  $('resize').classList.toggle('hidden', locked);
  if (PANEL !== 'pp') return;
  const play = state?.play;
  setText($('pp'), play?.pp != null ? fmtInt(play.pp) : '–');
  setText($('pp-fc'), play?.ppFc != null && state.state === 'play' ? fmtInt(play.ppFc) : '–');
  const pace = paceOf(play?.accuracy, playPb);
  setText($('pace'), pace == null ? '–' : fmtPace(pace));
  $('pace').parentElement.className = `stat pace${pace == null ? '' : pace >= 0 ? ' up' : ' down'}`;
}

function updatePlayPb() {
  if (state?.state !== 'play') return;
  playPb = myScores?.checksum === state.checksum ? pickPb(myScores.scores, state.play?.mods ?? []) : null;
}

// ---------- keys ----------

function renderKeys() {
  $('keys').replaceChildren(...keyLabels.map((label, i) => el('div', { class: `key${keyPressed[i] ? ' pressed' : ''}` },
    el('div', { class: 'key-cap' }, label),
    el('div', { class: 'key-kps' }, el('b', {}, '0'), ' KPS'),
    el('div', { class: 'key-count', title: 'Presses this play' }, fmtInt(keyCounts[i])))));
  renderKps();
}

/** Refreshes the KPS numbers: presses within the last second, per finger and in total. */
function renderKps() {
  const since = performance.now() - KPS_WINDOW_MS;
  const keys = $('keys').children;
  let total = 0;
  keyPresses.forEach((times, i) => {
    while (times.length && times[0] < since) times.shift();
    total += times.length;
    const kps = keys[i]?.querySelector('.key-kps b');
    if (kps) setText(kps, String(times.length));
  });
  setText($('kps'), String(total));
}

function onKey(column, pressed) {
  if (column < 0 || column >= keyLabels.length || keyPressed[column] === pressed) return;
  keyPressed[column] = pressed;
  const key = $('keys').children[column];
  key?.classList.toggle('pressed', pressed);
  if (!pressed) return;
  keyPresses[column].push(performance.now());
  keyCounts[column]++;
  const count = key?.querySelector('.key-count');
  if (count) count.textContent = fmtInt(keyCounts[column]);
  renderKps();
}

/** Reads the keys bound in osu!; again once tosu reports where the game is, if that's new. */
async function watchKeys(gameFolder) {
  if (keyFolder === gameFolder) return;
  keyFolder = gameFolder;
  const result = await window.overlay.watchKeys({ gameFolder }).catch(() => null);
  if (result?.keys && keyFolder === gameFolder) {
    keyLabels = result.keys;
    renderKeys();
  }
}

function onTosuData(next) {
  if (PANEL === 'keys') {
    if (next.state === 'play' && state?.state !== 'play') {
      keyPressed = keyPressed.map(() => false);
      keyCounts = keyCounts.map(() => 0);
      renderKeys();
    }
    if (next.gameFolder) watchKeys(next.gameFolder);
  }
  if (PANEL === 'judgements') renderJudgements(next);
  state = next;
  updatePlayPb();
  render();
}

// ---------- judgements ----------

/** Shows the play's count of each judgement; a box lights up when its count goes up during a play. */
function renderJudgements(next) {
  const hits = next.play?.hits ?? null;
  const playing = next.state === 'play' && state?.state === 'play';
  for (const box of $('judgements-panel').children) {
    const count = hits?.[box.dataset.hit] ?? 0;
    if (playing && count > (shownHits?.[box.dataset.hit] ?? 0)) {
      box.classList.remove('lit');
      void box.offsetWidth; // starts the animation over
      box.classList.add('lit');
    }
    setText(box, fmtInt(count));
  }
  shownHits = hits;
}

// ---------- moving and resizing ----------

// While unlocked, dragging the overlay moves its window and dragging the corner resizes it; the
// window follows the mouse pointer, and its spot and size are saved when let go.
let gesturing = false;

function onPointerDown(event) {
  if (locked || event.button !== 0 || event.target === $('lock')) return;
  gesturing = true;
  $('overlay').setPointerCapture(event.pointerId);
  window.overlay.gestureStart(event.target === $('resize'));
}

function onPointerMove() {
  if (gesturing) window.overlay.gesture();
}

function onPointerUp() {
  if (!gesturing) return;
  gesturing = false;
  window.overlay.gestureEnd();
}

function setScale(scale) {
  document.documentElement.style.setProperty('--scale', scale);
}

async function init() {
  $(`${PANEL}-panel`).classList.remove('hidden');
  window.overlay.onPb((pb) => {
    myScores = pb;
    updatePlayPb();
    render();
  });
  const config = await window.overlay.getConfig();
  myScores ??= config.pb;
  locked = config.locked;
  setScale(config.scale);
  window.overlay.onScale(setScale);
  window.overlay.onLocked((value) => {
    locked = value;
    render();
  });
  // The window is sized to the overlay's own size (unscaled), whenever that changes; a pixel more,
  // as offsetWidth rounds.
  new ResizeObserver(() => window.overlay.setSize($('overlay').offsetWidth + 1, $('overlay').offsetHeight + 1)).observe($('overlay'));
  $('overlay').addEventListener('pointerdown', onPointerDown);
  $('overlay').addEventListener('pointermove', onPointerMove);
  $('overlay').addEventListener('pointerup', onPointerUp);
  $('overlay').addEventListener('pointercancel', onPointerUp);
  $('lock').addEventListener('click', () => window.overlay.lock());
  if (PANEL === 'keys') {
    window.overlay.onKey(onKey);
    renderKeys();
    setInterval(renderKps, KPS_REFRESH_MS);
    watchKeys('');
  }
  render();
  new TosuClient({ onStatus() {}, onData: onTosuData }).connect(config.tosuUrl);
}

init();
