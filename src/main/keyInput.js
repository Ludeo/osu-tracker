// Key presses for the game view's key overlay. osu! stable has no key overlay in mania and tosu
// only reports the osu!standard keys, so the keyboards are read directly: on Linux from evdev
// (/dev/input/event*, readable by the "input" group), on Windows with a low-level keyboard hook
// (uiohook-napi). Only the four 4K keys bound in osu! are reported; every other key is dropped
// here and never leaves this module.

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_LAYOUT = ['D', 'F', 'J', 'K']; // osu!'s default 4K layout
const EV_KEY = 1;
const EVENT_SIZE = 24; // struct input_event on 64-bit: timeval (16), type (2), code (2), value (4)

// .NET Keys names, as stored in osu!.<user>.cfg, to Linux key codes (US positions).
const LETTER_CODES = {
  Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25,
  A: 30, S: 31, D: 32, F: 33, G: 34, H: 35, J: 36, K: 37, L: 38,
  Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
};
const KEY_CODES = {
  ...LETTER_CODES,
  D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 7, D7: 8, D8: 9, D9: 10, D0: 11,
  NumPad7: 71, NumPad8: 72, NumPad9: 73, NumPad4: 75, NumPad5: 76, NumPad6: 77,
  NumPad1: 79, NumPad2: 80, NumPad3: 81, NumPad0: 82,
  OemMinus: 12, OemPlus: 13, OemOpenBrackets: 26, Oem4: 26, OemCloseBrackets: 27, Oem6: 27,
  OemSemicolon: 39, Oem1: 39, OemQuotes: 40, Oem7: 40, OemTilde: 41, Oem3: 41,
  OemPipe: 43, Oem5: 43, OemComma: 51, OemPeriod: 52, OemQuestion: 53, Oem2: 53,
  OemBackslash: 86, Oem102: 86,
  Space: 57, Tab: 15, CapsLock: 58, Capital: 58, Enter: 28, Return: 28, Back: 14,
  LeftShift: 42, LShiftKey: 42, RightShift: 54, RShiftKey: 54,
  LeftControl: 29, LControlKey: 29, RightControl: 97, RControlKey: 97,
  LeftAlt: 56, LMenu: 56, RightAlt: 100, RMenu: 100,
  Up: 103, Left: 105, Right: 106, Down: 108,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
};
// The hook on Windows reports scan codes, which are the Linux key codes above except for these
// extended keys.
const WINDOWS_CODES = {
  RightControl: 0x0E1D, RControlKey: 0x0E1D, RightAlt: 0x0E38, RMenu: 0x0E38,
  Up: 0xE048, Left: 0xE04B, Right: 0xE04D, Down: 0xE050,
};
const NUMPAD_NAV = 0xEE00; // added to a numpad key's code while Num Lock is off

/** The codes a key can arrive with from the Windows hook. */
function windowsCodes(name) {
  if (name in WINDOWS_CODES) return [WINDOWS_CODES[name]];
  return name.startsWith('NumPad') ? [KEY_CODES[name], NUMPAD_NAV | KEY_CODES[name]] : [KEY_CODES[name]];
}

const KEY_LABELS = {
  OemMinus: '-', OemPlus: '=', OemOpenBrackets: '[', Oem4: '[', OemCloseBrackets: ']', Oem6: ']',
  OemSemicolon: ';', Oem1: ';', OemQuotes: "'", Oem7: "'", OemTilde: '`', Oem3: '`',
  OemPipe: '\\', Oem5: '\\', OemComma: ',', OemPeriod: '.', OemQuestion: '/', Oem2: '/',
  OemBackslash: '\\', Oem102: '\\', Space: '␣', LeftShift: 'LShift', RightShift: 'RShift',
  LeftControl: 'LCtrl', RightControl: 'RCtrl', LeftAlt: 'LAlt', RightAlt: 'RAlt',
};
const keyLabel = (name) => KEY_LABELS[name] ?? name.replace(/^D(\d)$/, '$1').replace(/^NumPad/, 'Num');

/**
 * The 4K layout selected in osu!, from the most recently used osu!.<user>.cfg in the game folder.
 * @returns {Promise<{ names: string[], source: string|null }>}
 */
async function readLayout(gameFolder) {
  let files = [];
  try {
    const names = (await fs.readdir(gameFolder)).filter((n) => /^osu!\..+\.cfg$/i.test(n));
    files = await Promise.all(names.map(async (n) => {
      const file = path.join(gameFolder, n);
      return { file, mtime: (await fs.stat(file)).mtimeMs };
    }));
  } catch {
    return { names: DEFAULT_LAYOUT, source: null };
  }
  for (const { file } of files.sort((a, b) => b.mtime - a.mtime)) {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const layouts = /^ManiaLayouts4K\s*=\s*(.*)$/m.exec(text)?.[1];
    if (!layouts) continue;
    const selected = Number(/^ManiaLayoutSelected4K\s*=\s*(\d+)/m.exec(text)?.[1] ?? 0);
    const options = layouts.split('|').map((l) => l.trim().split(/\s+/));
    const names = options[selected] ?? options[0];
    if (names.length === 4 && names.every((n) => n in KEY_CODES)) return { names, source: path.basename(file) };
  }
  return { names: DEFAULT_LAYOUT, source: null };
}

/** Whether bit `code` is set in a /proc/bus/input/devices bitmap (hex words, most significant first). */
function hasBit(bitmap, code) {
  const words = bitmap.trim().split(/\s+/).reverse();
  const word = words[Math.floor(code / 64)];
  return word != null && (BigInt(`0x${word}`) >> BigInt(code % 64)) & 1n ? true : false;
}

/** evdev devices that can send all of the given keys. */
async function keyboardDevices(codes) {
  const text = await fs.readFile('/proc/bus/input/devices', 'utf8');
  return text.split(/\n\s*\n/).flatMap((block) => {
    const event = /^H: Handlers=.*\b(event\d+)\b/m.exec(block)?.[1];
    const keys = /^B: KEY=(.*)$/m.exec(block)?.[1];
    return event && keys && codes.every((c) => hasBit(keys, c)) ? [`/dev/input/${event}`] : [];
  });
}

class KeyInput {
  constructor() {
    this.readers = [];
    this.unhook = null; // stops the Windows hook
    this.onKey = null; // (column, pressed) => void
  }

  /**
   * Starts reading the keyboards for the 4K layout bound in osu!.
   * @returns {Promise<{ keys: string[], layoutSource: string|null, error: string|null }>}
   */
  async start(gameFolder) {
    this.stop();
    const { names, source } = gameFolder ? await readLayout(gameFolder) : { names: DEFAULT_LAYOUT, source: null };
    const result = { keys: names.map(keyLabel), layoutSource: source, error: null };
    if (process.platform === 'win32') return this.startHook(names, result);
    if (process.platform !== 'linux') return { ...result, error: 'The key overlay is only available on Linux and Windows.' };
    return this.startEvdev(names, result);
  }

  /** Windows: a low-level keyboard hook, which sees the keys while osu! has the focus. */
  startHook(names, result) {
    let uIOhook;
    try {
      ({ uIOhook } = require('uiohook-napi'));
    } catch (err) {
      return { ...result, error: `Couldn't load the keyboard hook: ${err.message}` };
    }
    const codes = names.map(windowsCodes);
    const pressed = names.map(() => false);
    const onEvent = (keycode, down) => {
      const column = codes.findIndex((c) => c.includes(keycode));
      // A held key repeats its key down.
      if (column === -1 || pressed[column] === down) return;
      pressed[column] = down;
      this.onKey?.(column, down);
    };
    const onDown = (event) => onEvent(event.keycode, true);
    const onUp = (event) => onEvent(event.keycode, false);
    uIOhook.on('keydown', onDown);
    uIOhook.on('keyup', onUp);
    this.unhook = () => {
      uIOhook.off('keydown', onDown);
      uIOhook.off('keyup', onUp);
      uIOhook.stop();
    };
    try {
      uIOhook.start();
    } catch (err) {
      this.stop();
      return { ...result, error: `Couldn't start the keyboard hook: ${err.message}` };
    }
    return result;
  }

  /** Linux: every keyboard's evdev device. */
  async startEvdev(names, result) {
    const codes = names.map((n) => KEY_CODES[n]);
    let devices;
    try {
      devices = await keyboardDevices(codes);
    } catch (err) {
      return { ...result, error: `Couldn't list the keyboards: ${err.message}` };
    }
    if (devices.length === 0) return { ...result, error: 'No keyboard found.' };

    const errors = [];
    // `cat` reads each device; a blocking read in Node would hold a libuv worker thread until the
    // next key press, even after the stream is closed. Killing cat ends it straight away.
    await Promise.all(devices.map((device) => new Promise((resolve) => {
      const child = spawn('cat', [device], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.readers.push(child);
      let pending = Buffer.alloc(0);
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        resolve();
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        for (; offset + EVENT_SIZE <= pending.length; offset += EVENT_SIZE) {
          if (pending.readUInt16LE(offset + 16) !== EV_KEY) continue;
          const column = codes.indexOf(pending.readUInt16LE(offset + 18));
          const value = pending.readInt32LE(offset + 20); // 1 press, 0 release, 2 auto-repeat
          if (column !== -1 && value !== 2) this.onKey?.(column, value === 1);
        }
        pending = pending.subarray(offset);
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => { errors.push(err.message); resolve(); });
      child.on('exit', (code) => {
        if (code) errors.push(stderr.trim() || `${device}: exit code ${code}`);
        resolve();
      });
      // A device that opened fine stays silent until a key is pressed.
      setTimeout(resolve, 300);
    })));

    if (errors.length === devices.length) {
      this.stop();
      const denied = errors.some((e) => /permission denied/i.test(e));
      return {
        ...result,
        error: denied ? 'No permission to read the keyboard. Add yourself to the "input" group and log in again.' : errors[0],
      };
    }
    return result;
  }

  stop() {
    for (const child of this.readers) child.kill();
    this.readers = [];
    const unhook = this.unhook;
    this.unhook = null;
    try {
      unhook?.();
    } catch {
      // Already stopped.
    }
  }
}

module.exports = { KeyInput, readLayout, keyLabel };
