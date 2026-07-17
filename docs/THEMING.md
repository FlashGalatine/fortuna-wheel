# Theming Fortuna

The wheel is painted on a `<canvas>`, but the canvas **reads its entire palette
from CSS custom properties** via `getComputedStyle` — so a pure-CSS re-skin
recolors segments, rim, labels, pointer, and hub without touching JavaScript.
The reveal effects (confetti / rain / glow) are a swappable JS registry.
And because the wire protocol carries no wheel-specific data at all, an
advanced theme can replace the whole presentation with something else entirely —
a Magic 8-ball, a crystal ball, a gacha capsule (see the tutorial at the end).

## The CSS variables

All defined in a `:root` block at the top of [overlay/wheel.css](../overlay/wheel.css):

| Variable | What it controls |
|---|---|
| `--fortuna-wheel-size` | Wheel diameter (default `640px`) |
| `--fortuna-rim-width` | Outer ring thickness |
| `--fortuna-seg-colors` | Comma-separated fills, cycled around the wheel |
| `--fortuna-tag-good` / `-bad` / `-neutral` | Per-tag rim stripe + reveal-card tint |
| `--fortuna-rim-color`, `--fortuna-seg-line` | Rim fill, segment divider stroke |
| `--fortuna-label-color`, `--fortuna-label-font` | Segment label text (full CSS `font` shorthand) |
| `--fortuna-pointer-color`, `--fortuna-pointer-size` | The 12-o'clock pointer triangle |
| `--fortuna-hub-color`, `--fortuna-hub-size` | Center hub disc |
| `--fortuna-reveal-*` | Result card: `bg`, `ink`, `accent`, `font`, `kicker-font` |
| `--fortuna-banner-*` | `!entry` banner: `bg`, `ink`, `accent` |
| `--fortuna-fx-good-colors` | Confetti palette (comma-separated) |
| `--fortuna-fx-bad-color` | Rain streak color |
| `--fortuna-fx-neutral-glow` | Neutral reveal glow color |
| `--fortuna-fx-duration` | Effect run time in ms (unitless number) |

## Three ways to re-skin

1. **OBS per-source Custom CSS** — paste overrides into the browser source's
   Custom CSS box:
   ```css
   :root {
     --fortuna-seg-colors: #2b2d42, #8d99ae, #edf2f4, #ef233c, #d90429;
     --fortuna-pointer-color: #ef233c;
     --fortuna-label-font: 700 24px "Bahnschrift", sans-serif;
   }
   ```
2. **Edit `overlay/wheel.css`** — change the `:root` block once for every source.
3. **A theme script** — load an extra `<script>`/`<link>` after the stock files
   to override CSS *and* effects (below).

`body.offline` is toggled by panel-core whenever Streamer.bot is unreachable —
the stock sheet dims and desaturates the stage; style it however you like.

## Swapping the reveal effects

[overlay/effects.js](../overlay/effects.js) publishes a registry:

```js
window.FORTUNA_EFFECTS = { good: confettiBurst, bad: rainFall, neutral: softGlow };
```

At reveal, wheel.js calls `FORTUNA_EFFECTS[tag]({ canvas, entry, durationMs, vars })`:

- `canvas` — the full-viewport `#fx` layer, yours to paint
- `entry` — the drawn entry (`label`, `tag`, `source`)
- `durationMs` — from `--fortuna-fx-duration`
- `vars(name)` — live CSS variable lookup

Each effect **returns a cancel function**; wheel.js calls it when the next
update arrives. To replace one, add a script after `effects.js` in
`wheel.html` (or your theme copy of it):

```html
<script src="effects.js"></script>
<script>
  // Fireworks instead of confetti — palette still comes from the CSS var.
  window.FORTUNA_EFFECTS.good = ({ canvas, durationMs, vars }) => {
    const colors = vars('--fortuna-fx-good-colors').split(',').map(s => s.trim());
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    let raf, t0 = performance.now();
    (function frame(now) {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (now - t0 > durationMs) return;
      for (let i = 0; i < 60; i++) {
        const a = i / 60 * Math.PI * 2;
        ctx.fillStyle = colors[i % colors.length];
        ctx.beginPath();
        ctx.arc(canvas.width / 2 + Math.cos(a) * 300 * t,
                canvas.height / 3 + Math.sin(a) * 300 * t + 150 * t * t, 4, 0, 7);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    })(t0);
    return () => { cancelAnimationFrame(raf); ctx.clearRect(0, 0, canvas.width, canvas.height); };
  };
</script>
```

## Anatomy of the overlay DOM

```
body
├── canvas#fx.fx                 full-viewport effect layer
└── main.stage
    ├── .wheel-wrap
    │   ├── canvas#wheel.wheel   the painted wheel
    │   ├── .pointer             CSS triangle at 12 o'clock
    │   └── .hub                 center disc
    ├── #reveal.reveal           result card (.tag-good/.tag-bad/.tag-neutral)
    │   ├── .reveal-kicker
    │   └── #reveal-label.reveal-label
    └── #entries-banner.entries-banner   "!entry · N / max entered"
```

## Tutorial: a Magic 8-ball theme from scratch

The payload is presentation-agnostic (docs/PROTOCOL.md): **any HTML page that
loads `/fortuna-shared/panel-core.js` and listens for `fortuna:update` is a
valid Fortuna surface.** The sidecar decides the winner and the timing; your
page decides everything visual. A complete, working 8-ball:

```html
<!doctype html><meta charset="utf-8">
<style>
  body { background: transparent; display: grid; place-items: center; height: 100vh; margin: 0; }
  .ball { width: 420px; height: 420px; border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #444, #000);
          display: grid; place-items: center; transition: transform .1s; }
  .ball.shaking { animation: shake .3s infinite; }
  @keyframes shake { 25% { transform: translate(-12px, 6px) rotate(-3deg); }
                     75% { transform: translate(12px, -6px) rotate(3deg); } }
  .window { width: 150px; height: 150px; border-radius: 50%; background: #06062a;
            color: #cfd6ff; display: grid; place-items: center; text-align: center;
            font: 700 18px/1.3 system-ui; padding: 18px; opacity: 0; transition: opacity .6s; }
  .ball.revealed .window { opacity: 1; }
</style>
<div class="ball" id="ball"><div class="window" id="answer"></div></div>
<script src="/fortuna-shared/panel-core.js"></script>
<script>
  const ball = document.getElementById('ball');
  const answer = document.getElementById('answer');
  let timer = null;
  window.addEventListener('fortuna:update', (e) => {
    const spin = e.detail.spin;
    clearTimeout(timer);
    ball.classList.remove('shaking', 'revealed');
    if (!spin) return;
    const msLeft = Date.parse(spin.startedAt) + spin.durationMs - Date.now();
    if (spin.state === 'spinning' && msLeft > 0) {
      ball.classList.add('shaking');                 // shake for the spin duration
      timer = setTimeout(() => ball.classList.remove('shaking'), msLeft);
    } else {
      answer.textContent = spin.selectedEntry.label; // the sidecar's pick
      ball.classList.add('revealed');
    }
  });
</script>
```

Drop it in `overlay/` (e.g. `eightball.html`), add it as an OBS browser source
at `http://127.0.0.1:7474/fortuna-overlay/eightball.html`, and it spins — well,
shakes — in perfect sync with every other Fortuna surface, because all timing
derives from the shared `spin` block. Use `spin.selectedEntry.tag` if you want
your own good/bad theatrics.

## Dev loop without Streamer.bot

`npm start` runs the mock SB server on :7474/:8080. Open
`http://127.0.0.1:7474/`, load the sample payload with
[/mock/fixture](http://127.0.0.1:7474/mock/fixture), and style against it —
POST any custom `fortuna:update` JSON to `/mock/push` to test states (a spin in
progress, a revealed bad draw, entries open…).
