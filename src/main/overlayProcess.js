// The overlay's own process (started by overlay.js): small frameless, transparent windows kept
// above osu!, one per overlay picked in the settings (the pp, the keys with keys per second, the
// judgements), which clicks go through while they're locked. It reads tosu and the keyboard itself, so it keeps up while the app's window
// is minimised or behind the game.

const net = require('node:net');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const config = require('./config');
const { KeyInput } = require('./keyInput');
const { IPC_FLAG, PANELS_FLAG, OVERLAY_PANELS } = require('./overlay');

const MARGIN = 24;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

// Chromium's storage (cache, local storage) can't be shared with the app's running process; the
// config stays where the app keeps it.
app.setPath('sessionData', path.join(app.getPath('userData'), 'overlay-session'));

const keyInput = new KeyInput();
const panels = {}; // name -> { win, size: [w, h] at scale 1, or null until the page reports it, scale, position }
let locked = true;
let pb = null; // { checksum, scores } from the app, for the pp overlay

/** The value of a `--name=value` argument from the app. */
function argument(name) {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
}

// The overlays to show, from the app.
const PANELS = OVERLAY_PANELS.filter((name) => (argument(PANELS_FLAG) ?? '').split(',').includes(name));

// The connection to the app (see overlay.js); when the app goes away, so does the overlay.
const ipc = net.connect(argument(IPC_FLAG) ?? '');
ipc.on('error', () => app.quit());
ipc.on('close', () => app.quit());

/** Tells the app something, one JSON message per line. */
function report(message) {
  if (ipc.writable) ipc.write(`${JSON.stringify(message)}\n`);
}

/** Where each panel was left and how big it was, from the app: { pp: { position, scale }, ... }. */
function savedLayout() {
  try {
    return JSON.parse(argument('--overlay-layout')) ?? {};
  } catch {
    return {};
  }
}

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale) || 1));

/** The saved spot, if it's still on a screen. */
function savedPosition(position) {
  const [x, y] = Array.isArray(position) ? position.map(Number) : [];
  const onScreen = screen.getAllDisplays().some(({ bounds }) => x >= bounds.x && y >= bounds.y
    && x < bounds.x + bounds.width - MARGIN && y < bounds.y + bounds.height - MARGIN);
  return Number.isFinite(x) && Number.isFinite(y) && onScreen ? [x, y] : null;
}

/**
 * First time (or when the saved screen is gone): pp at the top centre of the main screen, keys at
 * its left, judgements at its right.
 */
function defaultPosition(name, [width, height]) {
  const { workArea } = screen.getPrimaryDisplay();
  if (name === 'pp') return [Math.round(workArea.x + (workArea.width - width) / 2), workArea.y + MARGIN];
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  if (name === 'judgements') return [Math.round(workArea.x + workArea.width - width - MARGIN), y];
  return [workArea.x + MARGIN, y];
}

/** Sizes a panel's window to its content at its scale; shows it the first time. */
function fit(panel) {
  if (!panel.size) return;
  const width = Math.ceil(panel.size[0] * panel.scale);
  const height = Math.ceil(panel.size[1] * panel.scale);
  const [x, y] = panel.position ?? panel.win.getPosition();
  panel.win.setBounds({ x, y, width, height });
  if (!panel.win.isVisible()) panel.win.showInactive();
}

function setLocked(value) {
  locked = value;
  for (const { win } of Object.values(panels)) {
    win.setIgnoreMouseEvents(locked);
    win.webContents.send('overlay:locked', locked);
  }
}

async function createWindow(name, saved = {}) {
  const win = new BrowserWindow({
    width: 200,
    height: 80,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Sized by the overlay itself (fit), from its content and the scale it's dragged to.
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Never takes the keyboard from osu!. On X11 this also makes it an override-redirect window,
    // which the window manager leaves alone: it stays where it's put, and KWin stacks it above
    // every window, fullscreen ones included.
    focusable: false,
    title: 'osu!mania Tracker overlay',
    webPreferences: {
      preload: path.join(__dirname, 'overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  panels[name] = { win, size: null, scale: clampScale(saved.scale), position: savedPosition(saved.position) };
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), { query: { panel: name } });
}

/** The panel a message came from. */
function panelOf(event) {
  return Object.values(panels).find((panel) => panel.win.webContents === event.sender);
}

function registerIpc() {
  ipcMain.handle('overlay:config', (event) => ({ tosuUrl: config.load().tosuUrl, locked, pb, scale: panelOf(event)?.scale ?? 1 }));

  ipcMain.handle('overlay:keys', (event, { gameFolder } = {}) => {
    keyInput.onKey = (column, pressed) => {
      if (!event.sender.isDestroyed()) event.sender.send('overlay:key', column, pressed);
    };
    // As in the app: the Songs folder setting is a real path, tosu's folders can be Windows paths.
    const { songsFolder } = config.load();
    return keyInput.start(songsFolder ? path.dirname(path.resolve(songsFolder)) : String(gameFolder || ''));
  });

  // The page's own size at scale 1, whenever its content changes size.
  ipcMain.on('overlay:size', (event, width, height) => {
    const panel = panelOf(event);
    if (!panel || !(width > 0 && height > 0)) return;
    const name = Object.keys(panels).find((key) => panels[key] === panel);
    panel.size = [width, height];
    panel.position ??= defaultPosition(name, [width * panel.scale, height * panel.scale]);
    fit(panel);
  });

  // Dragging and resizing follow the mouse pointer itself: the pointer events' own coordinates
  // shift with the window as it moves.
  let gesture = null; // { panel, resize, cursor, position, scale, size } when it started
  ipcMain.on('overlay:gesture-start', (event, resize) => {
    const panel = panelOf(event);
    if (locked || !panel?.size) return;
    const [width, height] = panel.win.getSize();
    gesture = { panel, resize, cursor: screen.getCursorScreenPoint(), position: panel.position, scale: panel.scale, size: [width, height] };
  });
  ipcMain.on('overlay:gesture', () => {
    if (locked || !gesture) return;
    const { panel, cursor: from, position, scale, size } = gesture;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - from.x;
    const dy = cursor.y - from.y;
    if (gesture.resize) {
      // Grows from the top-left corner, keeping its proportions: by whichever way the corner moved more.
      panel.scale = clampScale(scale * Math.max((size[0] + dx) / size[0], (size[1] + dy) / size[1]));
      panel.win.webContents.send('overlay:scale', panel.scale);
    } else {
      panel.position = [position[0] + dx, position[1] + dy];
    }
    fit(panel);
  });
  ipcMain.on('overlay:gesture-end', () => {
    if (!gesture) return;
    const { panel } = gesture;
    gesture = null;
    const name = Object.keys(panels).find((key) => panels[key] === panel);
    report({ panel: name, position: panel.position, scale: panel.scale });
  });

  ipcMain.on('overlay:lock', () => {
    setLocked(true);
    report({ locked: true });
  });
}

// Commands from the app.
let input = '';
ipc.setEncoding('utf8');
ipc.on('data', (chunk) => {
  const lines = (input + chunk).split('\n');
  input = lines.pop();
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message.locked === 'boolean' && PANELS.every((name) => panels[name])) setLocked(message.locked);
    if ('pb' in message) {
      pb = message.pb;
      panels.pp?.win.webContents.send('overlay:pb', pb);
    }
  }
});

app.whenReady().then(async () => {
  registerIpc();
  // As in the app: tosu rejects the WebSocket handshake from a file:// origin.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    callback({ requestHeaders: { ...details.requestHeaders, Origin: url.origin } });
  });
  const layout = savedLayout();
  await Promise.all(PANELS.map((name) => createWindow(name, layout[name])));
  report({ ready: true });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => keyInput.stop());
