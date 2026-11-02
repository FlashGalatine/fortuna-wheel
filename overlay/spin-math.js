// spin-math — the deterministic spin animation math, shared verbatim between
// the overlay (plain <script>) and verify.mjs (evaluated in Node). The sidecar
// decides the outcome ONCE ({selectedIndex, seed, durationMs, extraSpins,
// startedAt}); every overlay derives the IDENTICAL animation from those numbers,
// so multiple OBS sources all land on the same slice at the same moment. Nothing
// here may use Math.random() or Date.now() for the target — only for nothing at
// all, in fact: it's all pure functions.

(function (root) {
  'use strict';

  var TAU = Math.PI * 2;

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

  root.FortunaSpinMath = { TAU: TAU, segmentCenter: segmentCenter, jitter: jitter, targetRotation: targetRotation, ease: ease, progress: progress, rotationAt: rotationAt, segmentAt: segmentAt };
})(typeof window !== 'undefined' ? window : globalThis);
