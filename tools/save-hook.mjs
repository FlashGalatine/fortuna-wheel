// Test-only preload for verify.mjs (node --import); the sidecar never loads it by itself.
// Wraps the writeFile its saves go through, so a check can catch the REAL sidecar in the
// middle of a save, the copyFile that sets a damaged config aside, and the readFile that takes
// in config.example.json. FORTUNA_SAVE_HOOK holds a comma-separated list of:
//   log               nothing extra, for a check that only counts the lines below
//   slow              each write takes 150 ms longer, so commands pile up behind it
//   stall             each write opens its file, which truncates it, and then never finishes
//   sigint            the first write also delivers a Ctrl+C, which Windows can't send from outside
//   sighup            the first write also delivers what closing the console window sends
//   copybusy          the first copy finds its file held with no sharing, for 300 ms (Windows only)
//   copyfail          each copy is refused
//   examplenoentries  config.example.json reads as settings with no entries key
//   exampleunusable   config.example.json reads as an entries list with nothing usable in it
// Every write prints "[save-hook] start" and then "done" or "stalled". The copy words print
// "[save-hook] copy held" and "copy refused", and the example words "example replaced". A check
// must look for those lines, or a sidecar that stops using these calls would pass it without
// being tested.

import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const EXCLUSIVE = 0x10000000; // libuv's UV_FS_O_EXLOCK: on Windows, open a file with no sharing
const words = (process.env.FORTUNA_SAVE_HOOK ?? '').split(',');
const realWriteFile = fsp.writeFile;
const realCopyFile = fsp.copyFile;
const realReadFile = fsp.readFile;
const STAND_IN_EXAMPLES = {
  examplenoentries: '{"settings":{"defaultChatTag":"bad"}}',
  exampleunusable: '{"entries":["One","Two"]}',
};
const exampleWord = Object.keys(STAND_IN_EXAMPLES).find((word) => words.includes(word));
let interrupted = false;
let copyHeld = false;

fsp.writeFile = async (path, data, options) => {
  console.log('[save-hook] start');
  const signal = ['SIGINT', 'SIGHUP'].find((name) => words.includes(name.toLowerCase()));
  if (signal && !interrupted) {
    interrupted = true;
    setImmediate(() => process.emit(signal));
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

fsp.readFile = async (path, options) => {
  if (exampleWord && String(path).endsWith('config.example.json')) {
    console.log('[save-hook] example replaced');
    return STAND_IN_EXAMPLES[exampleWord];
  }
  return realReadFile(path, options);
};

fsp.copyFile = async (src, dest, mode) => {
  if (words.includes('copyfail')) {
    console.log('[save-hook] copy refused');
    throw Object.assign(new Error('copy refused by the save hook'), { code: 'EACCES' });
  }
  if (words.includes('copybusy') && !copyHeld) {
    copyHeld = true;
    const held = await fsp.open(src, EXCLUSIVE | constants.O_RDONLY);
    setTimeout(() => held.close(), 300);
    console.log('[save-hook] copy held');
  }
  return realCopyFile(src, dest, mode);
};
syncBuiltinESMExports();
