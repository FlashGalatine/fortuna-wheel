// Test-only preload for verify.mjs (node --import); the sidecar never loads it by itself.
// Wraps the writeFile its saves go through, so a check can catch the REAL sidecar in the
// middle of a save. FORTUNA_SAVE_HOOK holds a comma-separated list of:
//   slow    each write takes 150 ms longer, so commands pile up behind it
//   stall   each write opens its file, which truncates it, and then never finishes
//   sigint  the first write also delivers a Ctrl+C, which Windows can't send from outside
// Every write prints "[save-hook] start" and then "done" or "stalled". A check must look for
// those lines, or a sidecar that stops using writeFile would pass it without being tested.

import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const words = (process.env.FORTUNA_SAVE_HOOK ?? '').split(',');
const realWriteFile = fsp.writeFile;
let interrupted = false;

fsp.writeFile = async (path, data, options) => {
  console.log('[save-hook] start');
  if (words.includes('sigint') && !interrupted) {
    interrupted = true;
    setImmediate(() => process.emit('SIGINT'));
  }
  if (words.includes('stall')) {
    await fsp.open(path, 'w');
    console.log('[save-hook] stalled');
    return new Promise(() => {});
  }
  if (words.includes('slow')) await new Promise((res) => setTimeout(res, 150));
  await realWriteFile(path, data, options);
  console.log('[save-hook] done');
};
syncBuiltinESMExports();
