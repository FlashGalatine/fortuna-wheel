// Preload for verify.mjs: puts a fault where no known input causes one. The sidecar knows
// nothing of this. Each variable holds a regex:
//
//   FORTUNA_THROW_ON         required: a log line matching it throws
//   FORTUNA_THROW_ON_UPDATE  the first fortuna:update matching it throws as it's serialized,
//                            because no log line comes after applyChange raises the revision
//   FORTUNA_REJECT_ON        a log line matching it also rejects a promise nobody holds
//   FORTUNA_STDERR_ON        a log line matching it also writes to stderr
//
// FORTUNA_THROW_MESSAGE replaces the injected error's message.
//
//   FORTUNA_THROW_ON=<regex> node --require ./tools/throw-on-log.cjs fortuna-sidecar.mjs

if (!process.env.FORTUNA_THROW_ON) {
  throw new Error('FORTUNA_THROW_ON is required: a regex for the log line to throw from');
}

const matches = (name, text) => !!process.env[name] && new RegExp(process.env[name]).test(text);
const fault = () => new Error(process.env.FORTUNA_THROW_MESSAGE || 'injected fault');

const writeLine = console.log;
console.log = (...args) => {
  const line = String(args[0]);
  if (matches('FORTUNA_STDERR_ON', line)) console.error('injected warning');
  if (matches('FORTUNA_REJECT_ON', line)) Promise.reject(fault());
  if (matches('FORTUNA_THROW_ON', line)) throw fault();
  writeLine(...args);
};

const stringify = JSON.stringify;
let updateThrew = false;
JSON.stringify = (...args) => {
  const json = stringify(...args);
  if (!updateThrew && args[0]?.type === 'fortuna:update' && matches('FORTUNA_THROW_ON_UPDATE', json)) {
    updateThrew = true;
    throw fault();
  }
  return json;
};
