// Preload for verify.mjs: a sidecar log line matching FORTUNA_THROW_ON throws, which puts
// a throw at that line where no known input causes one. The sidecar knows nothing of this.
//
//   node --require ./tools/throw-on-log.cjs fortuna-sidecar.mjs

const pattern = new RegExp(process.env.FORTUNA_THROW_ON);
const writeLine = console.log;

console.log = (...args) => {
  if (pattern.test(String(args[0]))) throw new Error('injected fault');
  writeLine(...args);
};
