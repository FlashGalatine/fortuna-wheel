// effects — the reveal-effect registry, Fortuna's re-skin seam for theme
// designers (docs/THEMING.md). wheel.js calls
//
//   window.FORTUNA_EFFECTS[tag]({ canvas, entry, durationMs, vars })
//
// when a spin reveals, where `tag` is the drawn entry's good|bad|neutral tag.
// Each effect returns a cancel function; wheel.js cancels the running effect
// when the next update arrives. To replace an effect, load ANOTHER script after
// this one and reassign the key:
//
//   <script src="effects.js"></script>
//   <script>window.FORTUNA_EFFECTS.good = myFireworks;</script>
//
// `vars` is a live getComputedStyle lookup — palettes come from the CSS custom
// properties --fortuna-fx-good-colors / --fortuna-fx-bad-color /
// --fortuna-fx-neutral-glow / --fortuna-fx-duration, so most re-skins never
// touch JS at all.

(() => {
  'use strict';

  function parseColors(list, fallback) {
    const colors = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
    return colors.length ? colors : fallback;
  }

  // Shared particle loop: sizes the canvas to the viewport, steps particles
  // until the deadline, clears, and self-cancels.
  function particleLoop(canvas, durationMs, step) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.scale(dpr, dpr);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const t0 = performance.now();
    let raf = null;
    let done = false;

    function frame(now) {
      if (done) return;
      const t = now - t0;
      ctx.clearRect(0, 0, w, h);
      if (t < durationMs) {
        step(ctx, t, w, h);
        raf = requestAnimationFrame(frame);
      } else {
        done = true;
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }

  // GOOD — confetti burst: rectangles launched from center-top, tumbling down.
  function confettiBurst({ canvas, durationMs, vars }) {
    const colors = parseColors(vars('--fortuna-fx-good-colors'), ['#ffd166', '#35d07f', '#ffffff']);
    const N = 180;
    const parts = Array.from({ length: N }, (_, i) => ({
      x0: 0.5 + (Math.sin(i * 12.9898) * 0.5) * 0.4,
      vx: Math.sin(i * 78.233) * 0.25,
      vy: 0.25 + Math.abs(Math.sin(i * 43.758)) * 0.55,
      size: 6 + (i % 7),
      spin: (i % 2 ? 1 : -1) * (2 + (i % 5)),
      color: colors[i % colors.length],
      delay: (i % 30) * 12,
    }));
    return particleLoop(canvas, durationMs, (ctx, t, w, h) => {
      for (const p of parts) {
        const tt = (t - p.delay) / 1000;
        if (tt < 0) continue;
        const x = p.x0 * w + p.vx * w * tt;
        const y = -20 + p.vy * h * tt + 220 * tt * tt; // gravity
        if (y > h + 20) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.spin * tt);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
    });
  }

  // BAD — rain: streaks falling over the whole scene.
  function rainFall({ canvas, durationMs, vars }) {
    const color = String(vars('--fortuna-fx-bad-color') || '#6ea8d8').trim();
    const N = 140;
    const drops = Array.from({ length: N }, (_, i) => ({
      x: (Math.abs(Math.sin(i * 91.17)) * 1.1) - 0.05,
      speed: 1.1 + Math.abs(Math.sin(i * 7.31)) * 0.9,
      len: 14 + (i % 12),
      phase: Math.abs(Math.sin(i * 3.7)),
    }));
    return particleLoop(canvas, durationMs, (ctx, t, w, h) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      for (const d of drops) {
        const y = (((t / 1000) * d.speed + d.phase) % 1.1) * (h + 60) - 40;
        const x = d.x * w;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 3, y + d.len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  // NEUTRAL — a soft pulsing glow behind the reveal card (CSS class based; the
  // fx canvas stays untouched so a theme's own card styling shows through).
  function softGlow({ durationMs, vars }) {
    const reveal = document.getElementById('reveal');
    if (!reveal) return () => {};
    const glow = String(vars('--fortuna-fx-neutral-glow') || '#ffd166').trim();
    const prev = reveal.style.boxShadow;
    reveal.style.boxShadow = `0 0 60px 8px ${glow}`;
    const timer = setTimeout(() => { reveal.style.boxShadow = prev; }, durationMs);
    return () => { clearTimeout(timer); reveal.style.boxShadow = prev; };
  }

  window.FORTUNA_EFFECTS = {
    good: confettiBurst,
    bad: rainFall,
    neutral: softGlow,
  };
})();
