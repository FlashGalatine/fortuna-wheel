// spin-math — the deterministic spin animation math, shared verbatim between
// the overlay (plain <script>) and verify.mjs (evaluated in Node). The sidecar
// decides the outcome ONCE ({selectedIndex, seed, durationMs, extraSpins,
// startedAt}); every surface derives the IDENTICAL animation from those numbers,
// so multiple OBS sources and the control preview all land on the same slice at
// the same moment. Nothing here may use Math.random() or Date.now() for the
// target — only for nothing at all, in fact: it's all pure functions.

(function (root) {
  'use strict';

  var TAU = Math.PI * 2;
  var REVEAL_MAX_AGE_MS = 5 * 60 * 1000;

  // Angle (radians, clockwise from the pointer at 12 o'clock) of the CENTER of
  // segment i on an N-segment wheel drawn with segment 0 starting at the pointer.
  function segmentCenter(i, n) {
    return (i + 0.5) * (TAU / n);
  }

  // Deterministic jitter keeps the pointer off segment edges but strictly inside
  // the winning slice — ±40% of a half-segment, derived from the seed.
  function jitter(seed, n) {
    return (((seed % 1000) / 1000) - 0.5) * 0.8 * (TAU / n);
  }

  // Total rotation the wheel travels: extraSpins full turns plus whatever brings
  // the selected segment's center (offset by jitter) under the pointer.
  function targetRotation(selectedIndex, n, seed, extraSpins) {
    var landing = TAU - segmentCenter(selectedIndex, n) + jitter(seed, n);
    return extraSpins * TAU + ((landing % TAU) + TAU) % TAU;
  }

  // Ease-out quintic — fast launch, long dramatic deceleration.
  function ease(p) {
    return 1 - Math.pow(1 - p, 5);
  }

  // Animation progress in [0,1] given wall-clock elapsed ms.
  function progress(elapsedMs, durationMs) {
    if (durationMs <= 0) return 1;
    return Math.max(0, Math.min(1, elapsedMs / durationMs));
  }

  // Current wheel rotation (radians) at a point in time.
  function rotationAt(elapsedMs, spin, n) {
    var theta = targetRotation(spin.selectedIndex, n, spin.seed, spin.extraSpins);
    return theta * ease(progress(elapsedMs, spin.durationMs));
  }

  // Which segment index sits under the pointer for a given rotation — used by
  // the verify suite to prove the animation lands on the sidecar's pick.
  function segmentAt(rotation, n) {
    var pointerAngle = ((TAU - (rotation % TAU)) % TAU + TAU) % TAU;
    return Math.floor(pointerAngle / (TAU / n)) % n;
  }

  // Whether a revealed spin is still on show: nothing has changed since the sidecar
  // revealed it, and it's recent enough for a reconnect to replay. A spin saved before
  // revealRevision existed has nothing to compare, so only its age counts.
  function revealOnShow(payload, nowMs) {
    var spin = payload.spin;
    if (!spin || spin.state !== 'revealed') return false;
    if (spin.revealRevision != null && spin.revealRevision !== payload.revision) return false;
    return nowMs - (Date.parse(spin.startedAt) + spin.durationMs) <= REVEAL_MAX_AGE_MS;
  }

  // The slices to paint. The rotation only lands on the winner on the list it was worked
  // out for, so a spin paints its frozen segments from launch until its reveal is over:
  // edits during the spin, and removeOnDraw at the reveal, only change the live entries.
  // A spin block with no usable segments (an older sidecar, a hand-edited config) paints
  // the live list.
  function paintedEntries(payload, nowMs) {
    var spin = payload.spin;
    if (!spin || !(spin.state === 'spinning' || revealOnShow(payload, nowMs))) return payload.entries;
    var slices = spin.segments;
    var usable = Array.isArray(slices) && slices.length === spin.entryCount && slices.every(function (s) {
      return s && typeof s.label === 'string' && typeof s.tag === 'string';
    });
    return usable ? slices : payload.entries;
  }

  root.FortunaSpinMath = { TAU: TAU, segmentCenter: segmentCenter, jitter: jitter, targetRotation: targetRotation, ease: ease, progress: progress, rotationAt: rotationAt, segmentAt: segmentAt, revealOnShow: revealOnShow, paintedEntries: paintedEntries };
})(typeof window !== 'undefined' ? window : globalThis);
