// Etterna's MinaCalc (https://github.com/etternagame/etterna, MIT), compiled to WebAssembly by
// native/build-minacalc.sh. Rates 4K charts per skillset (MSD).

const createMinaCalc = require('./minacalc-wasm');

const SKILLSETS = ['overall', 'stream', 'jumpstream', 'handstream', 'stamina', 'jackspeed', 'chordjack', 'technical'];

let modulePromise = null;
const load = () => (modulePromise ??= createMinaCalc());

/**
 * Skillset values of a chart given as rows from osuFile.toRows. By default this is the chart's MSD
 * at `rate`; with `goal` (0..1) set it is the rating of a score with that Wife accuracy instead.
 */
async function rateChart({ masks, times }, { rate = 1, goal = null } = {}) {
  const mod = await load();
  const count = masks.length;
  const masksPtr = mod._malloc(count * 4);
  const timesPtr = mod._malloc(count * 4);
  const outPtr = mod._malloc(SKILLSETS.length * 4);
  try {
    mod.HEAPU32.set(masks, masksPtr / 4);
    mod.HEAPF32.set(times, timesPtr / 4);
    mod._mc_calc(masksPtr, timesPtr, count, rate, goal ?? 0.93, goal == null ? 0 : 1, outPtr);
    const out = mod.HEAPF32.subarray(outPtr / 4, outPtr / 4 + SKILLSETS.length);
    return Object.fromEntries(SKILLSETS.map((name, i) => [name, out[i]]));
  } finally {
    mod._free(masksPtr);
    mod._free(timesPtr);
    mod._free(outPtr);
  }
}

async function calcVersion() {
  return (await load())._mc_version();
}

module.exports = { rateChart, calcVersion, SKILLSETS };
