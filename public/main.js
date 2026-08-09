/*
 * Ink field.
 *
 * Streams are emitted from the left edge and carried rightward through a
 * Perlin flow field. Each stream keeps its own recent path and is redrawn
 * every frame at an alpha set by its age, so old streams dissolve
 * individually instead of the whole frame being washed down uniformly.
 * The canvas doubles as the color-scheme toggle.
 */

(function () {
  'use strict';

  var canvas = document.getElementById('ink');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * A stream is redrawn in full every frame, so its length costs segments.
   * Sampling the path every SAMPLE frames buys a long silky filament for a
   * cheap vertex count — at ~3 CSS px between points the polyline still
   * reads as a smooth curve.
   */
  var TRAIL = 80;
  var SAMPLE = 3;
  var CHUNKS = 8; // opacity steps along a trail, tail to head

  // ------------------------------------------------------------ noise

  function makeNoise(seed) {
    var perm = new Uint8Array(256);
    var p = new Uint8Array(512);
    var i;

    for (i = 0; i < 256; i++) perm[i] = i;

    var s = seed >>> 0;
    function rnd() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    }
    for (i = 255; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    for (i = 0; i < 512; i++) p[i] = perm[i & 255];

    function fade(t) {
      return t * t * t * (t * (t * 6 - 15) + 10);
    }
    function lerp(a, b, t) {
      return a + (b - a) * t;
    }
    function grad(h, x, y) {
      switch (h & 3) {
        case 0:
          return x + y;
        case 1:
          return -x + y;
        case 2:
          return x - y;
        default:
          return -x - y;
      }
    }

    return function (x, y) {
      var fx = Math.floor(x);
      var fy = Math.floor(y);
      var X = fx & 255;
      var Y = fy & 255;
      var xf = x - fx;
      var yf = y - fy;
      var u = fade(xf);
      var v = fade(yf);

      var aa = p[p[X] + Y];
      var ab = p[p[X] + Y + 1];
      var ba = p[p[X + 1] + Y];
      var bb = p[p[X + 1] + Y + 1];

      var x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
      var x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
      return lerp(x1, x2, v);
    };
  }

  var noise = makeNoise(0x5eed1);

  function smoothstep(e0, e1, x) {
    var t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  // ------------------------------------------------------------ colors

  var inkRGB = '255 255 255';
  var surfaceRGB = '0 0 0';

  // Dark ink on white reads heavier than white ink on black at equal alpha.
  var inkScale = 1;

  /*
   * Stroke colors are quantized to 256 alpha steps and cached. Building
   * "rgb(r g b / a)" strings per segment per frame was measurably the most
   * expensive thing in the loop; this makes it a array lookup.
   */
  var strokeCache = new Array(256);

  function inkAt(a) {
    var q = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0;
    var s = strokeCache[q];
    if (s === undefined) {
      s = 'rgb(' + inkRGB + ' / ' + (q / 255).toFixed(3) + ')';
      strokeCache[q] = s;
    }
    return s;
  }

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    inkRGB = (cs.getPropertyValue('--ink-rgb') || '255 255 255').trim();
    surfaceRGB = (cs.getPropertyValue('--surface-rgb') || '0 0 0').trim();
    inkScale = document.documentElement.getAttribute('data-theme') === 'light' ? 0.92 : 1;
    strokeCache = new Array(256); // ink color changed; drop memoized strings
  }

  // ------------------------------------------------------------ state

  var W = 0; // backing-store pixels
  var H = 0;
  var dpr = 1;
  var particles = [];
  var COUNT = 0;
  var time = 0;
  var rafId = null;

  var pointer = { x: 0, y: 0, active: false };

  /*
   * Held-pointer vortex. `power` eases toward 1 while the pointer is down
   * and back to 0 on release, so the rotation spins up and unwinds instead
   * of snapping. Rotation is per-millisecond, not per-frame — a 120Hz
   * display would otherwise turn the streams twice as fast as a 60Hz one.
   */
  var swirl = { x: 0, y: 0, held: false, power: 0, dir: 1 };
  var SWIRL_RATE = 0.0028; // radians per ms at full power
  var lastStep = 0;

  /*
   * The field opens already wound around a still core and holds there, so
   * the resting state is the singularity rather than a flat band. The first
   * press hands control over and it never comes back.
   */
  var intro = true;

  function gaussian() {
    // Box-Muller, clamped — keeps the stroke banded around the centerline.
    var u = 0;
    var v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    var g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(-2.5, Math.min(2.5, g));
  }

  function spawn(pt, seedAcross) {
    pt.x = seedAcross ? Math.random() * W : -Math.random() * W * 0.08;
    pt.y = H * 0.5 + gaussian() * H * 0.16;
    pt.speed = (0.55 + Math.random() * 0.9) * dpr;
    pt.maxLife = 520 + Math.random() * 700;
    // Stagger initial ages so streams don't all dissolve on the same beat.
    pt.life = seedAcross ? Math.random() * pt.maxLife : 0;

    // Wider streams run fainter, so the band keeps some depth.
    var w = Math.random();
    pt.weight = (0.35 + w * 1.0) * dpr;
    pt.alpha = 0.66 - w * 0.34;

    if (!pt.tx) {
      pt.tx = new Float32Array(TRAIL);
      pt.ty = new Float32Array(TRAIL);
    }
    pt.n = 0;
    pt.head = 0;
    return pt;
  }

  function pushPoint(pt, x, y) {
    pt.tx[pt.head] = x;
    pt.ty[pt.head] = y;
    pt.head = (pt.head + 1) % TRAIL;
    if (pt.n < TRAIL) pt.n++;
  }

  function build() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) return false;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // CSS owns the aspect ratio; fall back only if layout hasn't resolved.
    var cssH = rect.height || rect.width / 2.5;
    W = Math.max(1, Math.round(rect.width * dpr));
    H = Math.max(1, Math.round(cssH * dpr));

    canvas.width = W;
    canvas.height = H;

    readColors();
    // Butt caps, not round: consecutive chunks share an endpoint, and round
    // caps stack there into a visible bright bead along every filament.
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    // Trails are redrawn each frame, so density is a cost as well as a look.
    COUNT = Math.round(Math.min(850, Math.max(380, (W * H) / (1800 * dpr))));
    particles = new Array(COUNT);
    for (var i = 0; i < COUNT; i++) particles[i] = spawn({}, true);

    // Re-centre the resting vortex; a resize changes where the middle is.
    if (intro) {
      swirl.x = W / 2;
      swirl.y = H / 2;
      swirl.held = true;
    }

    time = 0;
    return true;
  }

  // ------------------------------------------------------------ field

  var SX = 0.0016;
  var SY = 0.0026;

  function angleAt(x, y, t) {
    var a = noise(x * SX, y * SY + t);
    var b = noise(x * SX * 2.6, y * SY * 2.6 - t * 1.4);
    return (a * 0.68 + b * 0.32) * 0.95;
  }

  /*
   * `draw` false advances the simulation without painting. Settling the
   * still frame for reduced motion needs hundreds of steps of field
   * evolution, and drawing them all would block the page for seconds —
   * the physics alone is cheap.
   */
  function step(draw) {
    time += 0.0016;

    // Warm-up steps aren't wall-clock paced, so give them a nominal frame.
    var dt = 16;
    if (draw) {
      var now = Date.now();
      if (lastStep) dt = Math.min(64, now - lastStep);
      lastStep = now;

      ctx.fillStyle = 'rgb(' + surfaceRGB + ')';
      ctx.fillRect(0, 0, W, H);
    }

    // Ease the vortex in while held, out once released.
    swirl.power += ((swirl.held ? 1 : 0) - swirl.power) * Math.min(1, dt / 160);
    var swirling = swirl.power > 0.005;
    var swirlR = Math.max(W, H) * 0.42;
    var swirlStep = SWIRL_RATE * swirl.power * swirl.dir * dt;

    var repel = 130 * dpr;

    for (var i = 0; i < COUNT; i++) {
      var pt = particles[i];

      var ang = angleAt(pt.x, pt.y, time);
      var vx = Math.cos(ang) * pt.speed;
      var vy = Math.sin(ang) * pt.speed;

      // Pull back toward the centerline so the field resolves into one
      // horizontal stroke instead of dispersing off the bottom.
      vy += (H * 0.5 - pt.y) * 0.005;

      if (pointer.active && !swirling) {
        var dx = pt.x - pointer.x;
        var dy = pt.y - pointer.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < repel && d > 0.001) {
          var f = (1 - d / repel) * 2.6;
          vx += (dx / d) * f;
          vy += (dy / d) * f;
        }
      }

      if (swirling) {
        /*
         * Rigid rotation about the held point: displacement = dtheta x r,
         * so everything inside the radius turns together rather than
         * shearing. Smoothstep the falloff so the edge has no seam.
         */
        var rx = pt.x - swirl.x;
        var ry = pt.y - swirl.y;
        var rd = Math.sqrt(rx * rx + ry * ry);
        if (rd < swirlR) {
          var e = 1 - rd / swirlR;
          var dtheta = swirlStep * e * e * (3 - 2 * e);
          vx += -ry * dtheta;
          vy += rx * dtheta;
        }
      }

      pt.x += vx;
      pt.y += vy;
      pt.life++;

      if (pt.x > W * 1.06 || pt.y < -H * 0.2 || pt.y > H * 1.2 || pt.life > pt.maxLife) {
        spawn(pt, false);
        continue;
      }

      if (pt.life % SAMPLE === 0) pushPoint(pt, pt.x, pt.y);
      if (!draw || pt.n < 2) continue;

      var lifeT = pt.life / pt.maxLife;

      // A stream dies from its tail forward: `death` is how far along the
      // trail the dissolve has swept, so the oldest ink is always the first
      // to go and the leading head is the last thing left.
      var death = smoothstep(0.4, 1, lifeT);
      var a2 = pt.alpha * smoothstep(0, 0.05, lifeT) * inkScale;
      if (a2 <= 0.003 || death >= 0.99) continue;

      var start = (pt.head - pt.n + TRAIL) % TRAIL;
      var span = pt.n - 1;
      ctx.lineWidth = pt.weight;

      /*
       * Walk the trail in chunks from tail to head, each stroked at the
       * opacity for its own position along the fade. Chunks behind the
       * dissolve front are fully transparent and skipped outright, so an
       * old stream costs less to draw as it disappears.
       */
      for (var c = 0; c < CHUNKS; c++) {
        var i0 = ((c * span) / CHUNKS) | 0;
        var i1 = (((c + 1) * span) / CHUNKS) | 0;
        if (i1 <= i0) continue;

        // Position of this chunk along the trail: 0 at the tail, 1 at the head.
        var u = (i0 + i1) / 2 / span;
        if (u <= death) continue;

        var t = (u - death) / (1 - death);
        var aChunk = a2 * t * (0.35 + 0.65 * t);
        if (aChunk <= 0.004) continue;

        ctx.strokeStyle = inkAt(aChunk);
        ctx.beginPath();
        ctx.moveTo(pt.tx[(start + i0) % TRAIL], pt.ty[(start + i0) % TRAIL]);
        for (var k = i0 + 1; k <= i1; k++) {
          var idx = (start + k) % TRAIL;
          ctx.lineTo(pt.tx[idx], pt.ty[idx]);
        }
        ctx.stroke();
      }
    }
  }

  var lastFrame = 0;

  function loop() {
    lastFrame = Date.now();
    step(true);
    rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (rafId !== null || reduceMotion) return;
    lastFrame = Date.now();
    rafId = window.requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId === null) return;
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  /*
   * iOS can suspend rAF without firing visibilitychange — returning from a
   * lock screen or a bfcache back-navigation leaves a scheduled callback
   * that never runs. `rafId` is still set, so start() would no-op and the
   * canvas would sit frozen forever. If the page is visible but no frame
   * has landed recently, tear the loop down and rebuild it.
   */
  function ensureRunning() {
    if (reduceMotion || document.hidden) return;
    if (rafId !== null && Date.now() - lastFrame < 1000) return;
    stop();
    start();
  }

  function render() {
    if (!build()) return;
    if (reduceMotion) {
      /*
       * Settle a still frame worth looking at. Seeded streams all start on
       * a near-identical path and only diverge as the field evolves, so a
       * short warm-up collapses into a single pinched comet. Simulate long
       * enough for the band to spread, then paint one frame.
       */
      for (var i = 0; i < 1400; i++) step(false);
      step(true);
      return;
    }

    /*
     * Wind the resting vortex before the first paint. Left to run in real
     * time it needs about seven seconds to close into a ring, which is far
     * longer than anyone waits — simulating it costs ~50ms instead.
     */
    if (intro) {
      for (var j = 0; j < 700; j++) step(false);
    }

    stop();
    start();
  }

  // ------------------------------------------------------------ pointer

  function toLocal(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = (clientX - rect.left) * (W / rect.width);
    pointer.y = (clientY - rect.top) * (H / rect.height);
    pointer.active = true;
  }

  function endIntro() {
    if (!intro) return;
    intro = false;
    swirl.held = false; // unwinds unless the press below takes it over
  }

  function holdAt(clientX, clientY) {
    endIntro();
    toLocal(clientX, clientY);
    swirl.x = pointer.x;
    swirl.y = pointer.y;
    if (!swirl.held) swirl.dir = -swirl.dir; // alternate so repeat taps differ
    swirl.held = true;
  }

  var pressing = false;

  function release() {
    pressing = false;
    // Only a press ends the resting vortex — not a stray mouseout or blur.
    if (intro) return;
    swirl.held = false;
  }

  canvas.addEventListener('pointermove', function (e) {
    toLocal(e.clientX, e.clientY);
    // Only an actual press drags the vortex. `swirl.held` is also true
    // during the intro, so keying off it would let a passing cursor haul
    // the resting singularity across the canvas.
    if (pressing) {
      swirl.x = pointer.x;
      swirl.y = pointer.y;
    }
  });

  canvas.addEventListener('pointerdown', function (e) {
    pressing = true;
    // Keep receiving moves even if the finger slides off the canvas.
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    holdAt(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('pointerleave', function () {
    pointer.active = false;
    release();
  });

  // Keyboard equivalent: hold Enter or Space to swirl from the center.
  canvas.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    endIntro();
    if (swirl.held) return; // ignore auto-repeat
    swirl.x = W / 2;
    swirl.y = H / 2;
    swirl.dir = -swirl.dir;
    swirl.held = true;
  });

  canvas.addEventListener('keyup', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') release();
  });

  canvas.addEventListener('blur', release);
  window.addEventListener('blur', release);

  // ------------------------------------------------------------- theme

  // Touch-primary devices have no key to press, so they stay on dark.
  var themeLocked = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  function toggleTheme() {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (_) {}

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#000000' : '#ffffff');

    readColors();
    if (reduceMotion) render();
  }

  document.addEventListener('keydown', function (e) {
    if (themeLocked) return;
    if (e.key !== 't' && e.key !== 'T') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Don't hijack the key while someone is typing.
    var el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;

    e.preventDefault();
    toggleTheme();
  });

  // ------------------------------------------------------------ lifecycle

  var resizeTimer = null;
  var lastWidth = window.innerWidth;

  window.addEventListener('resize', function () {
    // Mobile browsers fire resize on toolbar collapse; width is the real signal.
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(render, 180);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else ensureRunning();
  });

  // Restored from bfcache, or refocused after the loop was suspended.
  window.addEventListener('pageshow', ensureRunning);
  window.addEventListener('focus', ensureRunning);

  render();
})();
