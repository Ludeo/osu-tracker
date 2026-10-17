// The in-game overlays: live pp, and the keys with keys per second, in small windows kept above
// osu!. They run in a process of their own (overlayProcess.js) under X11, which on Wayland means XWayland: Wayland doesn't
// let a window keep itself above others or choose its position, and the app's own window stays on
// native Wayland. The two talk over the overlay's stdin and stdout, one JSON message per line.

const { spawn } = require('node:child_process');
const { app } = require('electron');

const OVERLAY_FLAG = '--osu-tracker-overlay';
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 3; // in a row, without a message from the overlay in between

class Overlay {
  constructor() {
    this.child = null;
    this.locked = true;
    this.pb = null; // { checksum, scores } your scores on the current map, for the pp overlay
    this.layout = {}; // { pp: { position: [x, y], scale }, keys: ... }; the overlay picks what's missing
    this.restarts = 0;
    this.restartTimer = null;
    this.onLayout = null; // (layout) => void, after an overlay has been moved or resized
    this.onState = null; // ({ running, locked }) => void
  }

  get running() {
    return this.child != null;
  }

  start(layout) {
    if (this.child) return;
    clearTimeout(this.restartTimer);
    this.layout = layout ?? {};
    this.locked = true;
    // In development the Electron binary needs the app's path; a packaged build is the app.
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), OVERLAY_FLAG];
    if (process.platform === 'linux') args.push('--ozone-platform=x11');
    args.push(`--overlay-layout=${JSON.stringify(this.layout)}`);
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;

    let pending = '';
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // not ours
        }
        this.restarts = 0;
        if (['pp', 'keys'].includes(message.panel)) {
          this.layout = { ...this.layout, [message.panel]: { position: message.position, scale: message.scale } };
          this.onLayout?.(this.layout);
        }
        if (typeof message.locked === 'boolean') {
          this.locked = message.locked;
          this.notify();
        }
      }
    });
    child.stdin.on('error', () => {}); // the overlay has exited; 'exit' handles it
    if (this.pb) this.send({ pb: this.pb });
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
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
    this.notify();
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
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify() {
    this.onState?.({ running: this.running, locked: this.locked });
  }
}

module.exports = { Overlay, OVERLAY_FLAG };
