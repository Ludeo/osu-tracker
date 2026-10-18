// The in-game overlays: live pp, the keys with keys per second, and the judgements of the play, in
// small windows kept above osu!, whichever of them are picked in the settings. They run in a process of their own (overlayProcess.js) under X11, which on Wayland means XWayland: Wayland doesn't
// let a window keep itself above others or choose its position, and the app's own window stays on
// native Wayland. The two talk over a local socket (a named pipe on Windows), one JSON message per
// line: a packaged app on Windows can't use the stdin and stdout it's started with.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const OVERLAY_FLAG = '--osu-tracker-overlay';
const IPC_FLAG = '--overlay-ipc';
const PANELS_FLAG = '--overlay-panels';
const OVERLAY_PANELS = ['pp', 'keys', 'judgements'];
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 3; // in a row, without a message from the overlay in between

class Overlay {
  constructor() {
    this.child = null;
    this.server = null;
    this.socket = null; // the overlay's end of the connection, once it has connected
    this.starts = 0;
    this.locked = true;
    this.pb = null; // { checksum, scores } your scores on the current map, for the pp overlay
    this.layout = {}; // { pp: { position: [x, y], scale }, keys: ... }; the overlay picks what's missing
    this.panels = OVERLAY_PANELS; // the ones shown
    this.restarts = 0;
    this.restartTimer = null;
    this.onLayout = null; // (layout) => void, after an overlay has been moved or resized
    this.onState = null; // ({ running, locked }) => void
  }

  get running() {
    return this.child != null;
  }

  start(layout, panels = this.panels) {
    if (this.child) return;
    clearTimeout(this.restartTimer);
    this.layout = layout ?? {};
    this.panels = OVERLAY_PANELS.filter((name) => panels.includes(name));
    this.locked = true;
    const ipcPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\osu-mania-tracker-overlay-${process.pid}-${++this.starts}`
      : path.join(os.tmpdir(), `osu-mania-tracker-overlay-${process.pid}-${++this.starts}.sock`);
    if (process.platform !== 'win32') fs.rmSync(ipcPath, { force: true });
    const server = net.createServer((socket) => {
      if (this.server !== server || this.socket) return socket.destroy(); // one overlay per start
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.on('error', () => {}); // the overlay has exited; 'exit' handles it
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
      });
      let pending = '';
      socket.on('data', (chunk) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop();
        for (const line of lines) this.receive(line);
      });
      if (this.pb) this.send({ pb: this.pb });
    });
    server.on('error', () => {});
    server.listen(ipcPath);
    this.server = server;

    // In development the Electron binary needs the app's path; a packaged build is the app.
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), OVERLAY_FLAG];
    if (process.platform === 'linux') args.push('--ozone-platform=x11');
    args.push(`--overlay-layout=${JSON.stringify(this.layout)}`, `${PANELS_FLAG}=${this.panels.join(',')}`, `${IPC_FLAG}=${ipcPath}`);
    const child = spawn(process.execPath, args, { stdio: 'ignore' });
    this.child = child;

    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.closeConnection();
      this.notify();
      // Restart an overlay that crashed, but not one that can't start at all.
      if (++this.restarts <= MAX_RESTARTS) this.restartTimer = setTimeout(() => this.start(this.layout), RESTART_DELAY_MS);
    });
    this.notify();
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.restarts = 0;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.closeConnection();
    this.notify();
  }

  closeConnection() {
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.restarts = 0;
    if (OVERLAY_PANELS.includes(message.panel)) {
      this.layout = { ...this.layout, [message.panel]: { position: message.position, scale: message.scale } };
      this.onLayout?.(this.layout);
    }
    if (typeof message.locked === 'boolean') {
      this.locked = message.locked;
      this.notify();
    }
  }

  /** Unlocked, the overlays can be dragged and resized; locked, clicks go through them to the game. */
  setLocked(locked) {
    this.locked = Boolean(locked);
    this.send({ locked: this.locked });
    this.notify();
  }

  setPb(pb) {
    this.pb = pb;
    this.send({ pb });
  }

  send(message) {
    if (this.socket?.writable) this.socket.write(`${JSON.stringify(message)}\n`);
  }

  notify() {
    this.onState?.({ running: this.running, locked: this.locked });
  }
}

module.exports = { Overlay, OVERLAY_FLAG, IPC_FLAG, PANELS_FLAG, OVERLAY_PANELS };
