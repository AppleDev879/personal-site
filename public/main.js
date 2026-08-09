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

  function step() {
    time += 0.0016;

    ctx.fillStyle = 'rgb(' + surfaceRGB + ')';
    ctx.fillRect(0, 0, W, H);

    var repel = 130 * dpr;

    for (var i = 0; i < COUNT; i++) {
      var pt = particles[i];

      var ang = angleAt(pt.x, pt.y, time);
      var vx = Math.cos(ang) * pt.speed;
      var vy = Math.sin(ang) * pt.speed;

      // Pull back toward the centerline so the field resolves into one
      // horizontal stroke instead of dispersing off the bottom.
      vy += (H * 0.5 - pt.y) * 0.005;

      if (pointer.active) {
        var dx = pt.x - pointer.x;
        var dy = pt.y - pointer.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < repel && d > 0.001) {
          var f = (1 - d / repel) * 2.6;
          vx += (dx / d) * f;
          vy += (dy / d) * f;
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
      if (pt.n < 2) continue;

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

  function loop() {
    step();
    rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (rafId !== null || reduceMotion) return;
    rafId = window.requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId === null) return;
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  function render() {
    if (!build()) return;
    if (reduceMotion) {
      // Advance to a settled frame and leave it there.
      for (var i = 0; i < 240; i++) step();
      return;
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

  canvas.addEventListener('mousemove', function (e) {
    toLocal(e.clientX, e.clientY);
  });

  canvas.addEventListener('mouseleave', function () {
    pointer.active = false;
  });

  canvas.addEventListener(
    'touchmove',
    function (e) {
      if (e.touches && e.touches.length) {
        toLocal(e.touches[0].clientX, e.touches[0].clientY);
      }
    },
    { passive: true }
  );

  canvas.addEventListener('touchend', function () {
    pointer.active = false;
  });

  // ------------------------------------------------------------- theme

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

  canvas.addEventListener('click', toggleTheme);

  canvas.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleTheme();
    }
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
    else start();
  });

  render();
})();
