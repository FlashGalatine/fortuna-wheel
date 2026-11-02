// wheel — the Fortuna overlay renderer. Consumes fortuna:update CustomEvents
// (dispatched by panel-core.js), paints the wheel on a canvas, and derives the
// spin animation deterministically from the sidecar's spin block so every OBS
// source lands on the same slice at the same moment.
//
// The canvas reads its palette from the CSS custom properties in wheel.css, so
// themes recolor it without touching JS (docs/THEMING.md). Reveal effects are
// dispatched through the window.FORTUNA_EFFECTS registry (effects.js).

(() => {
  'use strict';

  const M = window.FortunaSpinMath;
  const canvas = document.getElementById('wheel');
  const fxCanvas = document.getElementById('fx');
  const revealEl = document.getElementById('reveal');
  const revealLabel = document.getElementById('reveal-label');
  const bannerEl = document.getElementById('entries-banner');
  const bannerCount = document.getElementById('entries-count');
  const ctx = canvas.getContext('2d');

  // Reveal replays: a reconnect re-delivers the persisted payload, which still
  // carries the last revealed spin. The card re-shows while the reveal is on show
  // (spin-math.js); the effect only fires close to the actual moment (and once per spin).
  const EFFECT_MAX_AGE_MS = 10 * 1000;

  let state = null; // latest fortuna:update payload
  let painted = []; // the slices on the wheel, frozen during a spin (spin-math.js)
  let raf = null;
  let effectCancel = null;
  let effectSpinId = null;

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name);

  function segColors() {
    const list = cssVar('--fortuna-seg-colors').split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : ['#3d348b', '#7678ed', '#f7b801', '#f18701', '#f35b04'];
  }

  function tagColor(tag) {
    return cssVar(`--fortuna-tag-${tag}`).trim() || '#8d8d99';
  }

  // ── Wheel painting ──────────────────────────────────────────────────────────

  function draw(rotation) {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const entries = painted;
    const n = entries.length;
    const cx = size / 2;
    const cy = size / 2;
    const rimW = parseFloat(cssVar('--fortuna-rim-width')) || 14;
    const R = size / 2 - 2;
    const r = R - rimW;

    // Rim.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, M.TAU);
    ctx.fillStyle = cssVar('--fortuna-rim-color').trim() || '#1b1b2f';
    ctx.fill();

    if (!n) {
      // Empty wheel: a dim disc with a hint.
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, M.TAU);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fill();
      ctx.fillStyle = cssVar('--fortuna-label-color').trim() || '#fff';
      ctx.globalAlpha = 0.6;
      ctx.font = cssVar('--fortuna-label-font').trim() || '600 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Add entries to the wheel', cx, cy);
      ctx.globalAlpha = 1;
      return;
    }

    const colors = segColors();
    const seg = M.TAU / n;
    const font = cssVar('--fortuna-label-font').trim() || '600 22px sans-serif';

    ctx.save();
    ctx.translate(cx, cy);
    // Canvas 0 rad is 3 o'clock; the pointer sits at 12 o'clock. Segment 0
    // starts AT the pointer when rotation is 0.
    ctx.rotate(rotation - Math.PI / 2);

    for (let i = 0; i < n; i++) {
      const a0 = i * seg;
      const a1 = a0 + seg;

      // Slice.
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      ctx.strokeStyle = cssVar('--fortuna-seg-line').trim() || 'rgba(0,0,0,.35)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Tag stripe just inside the rim.
      ctx.beginPath();
      ctx.arc(0, 0, r - 4, a0 + 0.02, a1 - 0.02);
      ctx.strokeStyle = tagColor(entries[i].tag);
      ctx.lineWidth = 7;
      ctx.stroke();

      // Label along the slice's bisector, reading outward.
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.fillStyle = cssVar('--fortuna-label-color').trim() || '#fff';
      ctx.font = font;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const maxLen = n > 16 ? 14 : 22;
      const label = entries[i].label.length > maxLen ? entries[i].label.slice(0, maxLen - 1) + '…' : entries[i].label;
      ctx.fillText(label, r - 18, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  // ── Spin animation ──────────────────────────────────────────────────────────

  function stopAnim() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function spinN(spin) {
    return Math.max(spin.entryCount || state.entries.length, 1);
  }

  function currentRotation() {
    const spin = state && state.spin;
    if (!spin) return 0;
    const elapsed = Date.now() - Date.parse(spin.startedAt);
    return M.rotationAt(Math.min(elapsed, spin.durationMs), spin, spinN(spin));
  }

  function animate() {
    stopAnim();
    const spin = state && state.spin;
    if (!spin || spin.state !== 'spinning') { draw(currentRotation()); return; }
    const tick = () => {
      const elapsed = Date.now() - Date.parse(spin.startedAt);
      draw(M.rotationAt(elapsed, spin, spinN(spin)));
      if (elapsed < spin.durationMs) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = null;
        // Local animation done — the reveal card waits for the sidecar's
        // state:"revealed" broadcast so all surfaces flip together.
      }
    };
    raf = requestAnimationFrame(tick);
  }

  // ── Reveal card + effects ───────────────────────────────────────────────────

  function showReveal(spin) {
    const entry = spin.selectedEntry;
    revealLabel.textContent = entry.label;
    revealEl.classList.remove('tag-good', 'tag-bad', 'tag-neutral');
    revealEl.classList.add(`tag-${entry.tag}`);
    revealEl.hidden = false;

    const age = Date.now() - (Date.parse(spin.startedAt) + spin.durationMs);
    if (age <= EFFECT_MAX_AGE_MS && effectSpinId !== spin.spinId) {
      effectSpinId = spin.spinId;
      if (effectCancel) { try { effectCancel(); } catch {} }
      const fx = window.FORTUNA_EFFECTS && window.FORTUNA_EFFECTS[entry.tag];
      const durationMs = parseInt(cssVar('--fortuna-fx-duration'), 10) || 4000;
      effectCancel = fx ? fx({ canvas: fxCanvas, entry, durationMs, vars: cssVar }) : null;
    }
  }

  function hideReveal() {
    revealEl.hidden = true;
    if (effectCancel) { try { effectCancel(); } catch {} effectCancel = null; }
  }

  // ── State intake ────────────────────────────────────────────────────────────

  function apply(payload) {
    // Pushes can arrive out of order, so an older update never replaces a newer one. This
    // goes by time first, because a reset or restored config starts its revisions over.
    const newerBy = state ? Date.parse(state.generatedAt) - Date.parse(payload.generatedAt) : 0;
    if (state && (newerBy > 0 || (newerBy === 0 && payload.revision < state.revision))) return;

    state = payload;
    const spin = payload.spin;
    const now = Date.now();
    // spin-math.js can be older than this file (cached, or vendored by a theme). With no
    // helpers, this falls back on the live list and the spin's own state.
    painted = M.paintedEntries ? M.paintedEntries(payload, now) : payload.entries;

    // Entries-open banner.
    if (payload.entryMode && payload.entryMode.open) {
      const chatCount = payload.entries.filter((e) => e.source === 'chat').length;
      bannerCount.textContent = `${chatCount} / ${payload.entryMode.maxEntries} entered`;
      bannerEl.hidden = false;
    } else {
      bannerEl.hidden = true;
    }

    if (M.revealOnShow ? M.revealOnShow(payload, now) : spin && spin.state === 'revealed') showReveal(spin);
    else hideReveal();

    animate();
  }

  window.addEventListener('fortuna:update', (e) => apply(e.detail));
  window.addEventListener('resize', () => { if (state) draw(currentRotation()); });

  draw(0);
})();
