/* TD Five Boro Bike Tour — Straight or Curved?
 * Loads route-data.json (real 2026 GPS track + precomputed straight/curve segments)
 * and drives the map, selection sliders, bike animation, and the
 * notice -> quiz -> equation teaching flow.
 */

(() => {
  'use strict';

  const state = {
    data: null,
    points: null,          // Float64Array-backed arrays for speed
    dpr: Math.max(1, window.devicePixelRatio || 1),
    rect: null,
    bbox: null,             // {minX,maxX,minY,maxY}
    startMile: 0,
    endMile: 0,
    animating: false,
    lastLiveFit: null,      // populated right before opening the notice modal
    domType: null,
    notice: { questions: [], index: 0, answers: [] },
  };

  const el = (id) => document.getElementById(id);
  const routeCanvas = el('routeCanvas');
  const overlayCanvas = el('overlayCanvas');
  const canvasWrap = el('canvasWrap');
  const hoverTooltip = el('hoverTooltip');
  const startSlider = el('startSlider');
  const endSlider = el('endSlider');
  const rulerTrack = el('rulerTrack');
  const rulerMaxLabel = el('rulerMaxLabel');
  const statStart = el('statStart');
  const statEnd = el('statEnd');
  const statDistance = el('statDistance');
  const statBorough = el('statBorough');
  const validationMsg = el('validationMsg');
  const animateBtn = el('animateBtn');
  const resetBtn = el('resetBtn');

  const hitCanvas = document.createElement('canvas');
  const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });

  const MIN_MILES = 2;

  // ---------- color-scheme awareness ----------
  function isDark() {
    const stamped = document.documentElement.getAttribute('data-theme');
    if (stamped === 'dark') return true;
    if (stamped === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function segColor(seg) { return isDark() ? seg.color.dark : seg.color.light; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------- id <-> hit color encoding (matches meta.hitDetection) ----------
  function hitColorForId(id) {
    const n = id + 1;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgb(${r},${g},${b})`;
  }
  function idFromPixel(r, g, b) {
    const n = (r << 16) | (g << 8) | b;
    return n === 0 ? -1 : n - 1;
  }

  // ---------- load data ----------
  fetch('route-data.json')
    .then((r) => r.json())
    .then((data) => {
      state.data = data;
      indexPoints(data);
      init();
    })
    .catch((err) => {
      document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif;color:#c0392b">
        Could not load route-data.json (${err.message}). Serve this folder with a local web server
        (fetch() of a local JSON file is blocked when opened directly as a file:// URL in most browsers).</p>`;
    });

  function indexPoints(data) {
    const pts = data.points;
    const n = pts.length;
    const x = new Float64Array(n), y = new Float64Array(n), mile = new Float64Array(n);
    for (let i = 0; i < n; i++) { x[i] = pts[i].x; y[i] = pts[i].y; mile[i] = pts[i].mile; }
    state.points = { raw: pts, x, y, mile, n };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    }
    state.bbox = { minX, maxX, minY, maxY };
  }

  function init() {
    const themeParam = new URLSearchParams(location.search).get('theme');
    if (themeParam === 'dark' || themeParam === 'light') {
      document.documentElement.setAttribute('data-theme', themeParam);
    }
    const total = state.data.meta.totalMiles;
    startSlider.min = endSlider.min = 0;
    startSlider.max = endSlider.max = total;
    startSlider.value = 1.0;
    endSlider.value = 4.0;
    rulerMaxLabel.textContent = `Mile ${Math.round(total)}`;

    state.startMile = +startSlider.value;
    state.endMile = +endSlider.value;

    buildRulerGradient();
    resizeCanvases();
    drawStaticRoute();
    buildHitCanvas();
    updateSelectionUI();

    window.addEventListener('resize', debounce(() => {
      resizeCanvases();
      drawStaticRoute();
      buildHitCanvas();
      drawOverlay();
    }, 150));

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        drawStaticRoute();
        buildHitCanvas();
        drawOverlay();
        buildRulerGradient();
      });
    }

    startSlider.addEventListener('input', () => { state.startMile = +startSlider.value; updateSelectionUI(); });
    endSlider.addEventListener('input', () => { state.endMile = +endSlider.value; updateSelectionUI(); });

    resetBtn.addEventListener('click', resetSelection);
    animateBtn.addEventListener('click', startRide);

    canvasWrap.addEventListener('click', onMapClick);
    canvasWrap.addEventListener('mousemove', onMapHover);
    canvasWrap.addEventListener('mouseleave', () => { hoverTooltip.hidden = true; });

    wireModals();
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------- coordinate transform ----------
  function fitTransform() {
    const { minX, maxX, minY, maxY } = state.bbox;
    const pad = 28; // css px
    const w = state.rect.width - pad * 2;
    const h = state.rect.height - pad * 2;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min(w / spanX, h / spanY);
    const drawW = spanX * scale, drawH = spanY * scale;
    const offX = pad + (w - drawW) / 2;
    const offY = pad + (h - drawH) / 2;
    return { minX, minY, maxY, scale, offX, offY };
  }

  function milesToPixel(xMi, yMi, tf) {
    const px = tf.offX + (xMi - tf.minX) * tf.scale;
    const py = tf.offY + (tf.maxY - yMi) * tf.scale; // flip: north is up
    return [px, py];
  }

  function resizeCanvases() {
    state.rect = canvasWrap.getBoundingClientRect();
    const dpr = state.dpr;
    for (const c of [routeCanvas, overlayCanvas]) {
      c.width = Math.round(state.rect.width * dpr);
      c.height = Math.round(state.rect.height * dpr);
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    hitCanvas.width = Math.round(state.rect.width);
    hitCanvas.height = Math.round(state.rect.height);
  }

  // ---------- static route drawing ----------
  function drawStaticRoute() {
    const ctx = routeCanvas.getContext('2d');
    const tf = fitTransform();
    state.tf = tf;
    ctx.clearRect(0, 0, state.rect.width, state.rect.height);
    ctx.fillStyle = cssVar('--surface-3') || '#fff';
    ctx.fillRect(0, 0, state.rect.width, state.rect.height);

    const { x, y, n } = state.points;
    const segs = state.data.segments;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const seg of segs) {
      ctx.beginPath();
      ctx.strokeStyle = segColor(seg);
      ctx.lineWidth = 3.2;
      let first = true;
      for (let i = seg.startIndex; i <= seg.endIndex; i++) {
        const [px, py] = milesToPixel(x[i], y[i], tf);
        if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
      }
      ctx.stroke();
    }

    drawStartFinishMarkers(ctx, tf);
    drawBridgeLabels(ctx, tf);
    drawBoroughLabels(ctx, tf);
  }

  // The 🚲 emoji itself is a fixed-color glyph (fillStyle can't recolor it), so
  // we render it once to an offscreen canvas and re-tint every opaque pixel
  // green with a 'source-in' composite -- keeps the exact emoji artwork/shape,
  // just recolored, and it's cheap to rotate afterward as an image.
  let bikeIconCache = null;
  function getGreenBikeIcon(color) {
    if (bikeIconCache && bikeIconCache.color === color) return bikeIconCache.canvas;
    const size = 40;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const cctx = c.getContext('2d');
    cctx.font = `${size - 6}px system-ui, sans-serif`;
    cctx.textAlign = 'center';
    cctx.textBaseline = 'middle';
    cctx.fillText('🚲', size / 2, size / 2 + 1);
    cctx.globalCompositeOperation = 'source-in';
    cctx.fillStyle = color;
    cctx.fillRect(0, 0, size, size);
    cctx.globalCompositeOperation = 'source-over';
    bikeIconCache = { color, canvas: c };
    return c;
  }

  // The 🚲 artwork (Noto/Apple) already faces right (handlebars on the right
  // side) at rotation 0, which is exactly "east" in our screen-angle
  // convention, so no correction is needed.
  const BIKE_ICON_FACING_OFFSET = 0;

  function drawBikeIcon(ctx, cx, cy, heading, color) {
    const icon = getGreenBikeIcon(color);
    const size = icon.width;
    ctx.save();
    ctx.translate(cx, cy - size / 2 - 2);
    ctx.rotate(heading + BIKE_ICON_FACING_OFFSET);
    ctx.drawImage(icon, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  function drawStartFinishMarkers(ctx, tf) {
    const { x, y, n } = state.points;
    const [sx, sy] = milesToPixel(x[0], y[0], tf);
    const [ex, ey] = milesToPixel(x[n - 1], y[n - 1], tf);
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏁', sx, sy - 10);
    ctx.fillText('🏆', ex, ey - 10);
  }

  function pointAtMile(mile) {
    const { mile: mArr, n } = state.points;
    let idx = binarySearchMile(mArr, mile);
    idx = Math.min(Math.max(idx, 0), n - 1);
    return idx;
  }
  function binarySearchMile(mArr, mile) {
    let lo = 0, hi = mArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mArr[mid] < mile) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function drawBridgeLabels(ctx, tf) {
    const { x, y } = state.points;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const b of state.data.bridges) {
      const midMile = (b.startMile + b.endMile) / 2;
      const idx = pointAtMile(midMile);
      const [px, py] = milesToPixel(x[idx], y[idx], tf);
      const label = '🌉 ' + b.name;
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssVar('--surface-3') || '#fff';
      ctx.strokeText(label, px + 8, py + 14);
      ctx.fillStyle = cssVar('--text-primary') || '#111';
      ctx.fillText(label, px + 8, py + 14);
    }
  }

  function drawBoroughLabels(ctx, tf) {
    const { raw, x, y, n } = state.points;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = cssVar('--text-secondary') || '#555';
    ctx.strokeStyle = cssVar('--surface-3') || '#fff';
    ctx.lineWidth = 3;
    let runStart = 0;
    const MIN_RUN_MILES = 1.2; // skip labeling brief borough slivers (e.g. a bridge's far-side toe)
    for (let i = 1; i <= n; i++) {
      if (i === n || raw[i].borough !== raw[runStart].borough) {
        const runEnd = i - 1;
        if (raw[runEnd].mile - raw[runStart].mile >= MIN_RUN_MILES) {
          const mid = (runStart + runEnd) >> 1;
          const [px, py] = milesToPixel(x[mid], y[mid], tf);
          ctx.strokeText(raw[runStart].borough, px, py - 16);
          ctx.fillText(raw[runStart].borough, px, py - 16);
        }
        runStart = i;
      }
    }
  }

  // ---------- hit canvas (color-picking, per meta.hitDetection) ----------
  function buildHitCanvas() {
    const ctx = hitCtx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
    const { x, y, n } = state.points;
    const tf = state.tf;
    ctx.lineCap = 'round';
    ctx.lineWidth = 10;
    let prev = milesToPixel(x[0], y[0], tf);
    for (let i = 1; i < n; i++) {
      const cur = milesToPixel(x[i], y[i], tf);
      ctx.strokeStyle = hitColorForId(i - 1);
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(cur[0], cur[1]);
      ctx.stroke();
      prev = cur;
    }
  }

  function hitTestPixel(cssX, cssY) {
    const px = Math.round(cssX), py = Math.round(cssY);
    if (px < 0 || py < 0 || px >= hitCanvas.width || py >= hitCanvas.height) return -1;
    const data = hitCtx.getImageData(px, py, 1, 1).data;
    return idFromPixel(data[0], data[1], data[2]);
  }

  function onMapClick(evt) {
    if (state.animating) return;
    const r = canvasWrap.getBoundingClientRect();
    const id = hitTestPixel(evt.clientX - r.left, evt.clientY - r.top);
    if (id < 0) return;
    const mile = state.points.mile[id];
    // move whichever handle is nearer
    if (Math.abs(mile - state.startMile) <= Math.abs(mile - state.endMile)) {
      state.startMile = mile; startSlider.value = mile;
    } else {
      state.endMile = mile; endSlider.value = mile;
    }
    updateSelectionUI();
  }

  function onMapHover(evt) {
    if (state.animating) { hoverTooltip.hidden = true; return; }
    const r = canvasWrap.getBoundingClientRect();
    const cx = evt.clientX - r.left, cy = evt.clientY - r.top;
    const id = hitTestPixel(cx, cy);
    if (id < 0) { hoverTooltip.hidden = true; return; }
    const p = state.points.raw[id];
    hoverTooltip.hidden = false;
    hoverTooltip.style.left = cx + 'px';
    hoverTooltip.style.top = cy + 'px';
    hoverTooltip.textContent = `Mile ${p.mile.toFixed(2)} · ${p.borough}`;
  }

  // ---------- ruler gradient ----------
  function buildRulerGradient() {
    const total = state.data.meta.totalMiles;
    const stops = state.data.segments.map((s) => {
      const c = segColor(s);
      const p0 = (s.startMile / total) * 100;
      const p1 = (s.endMile / total) * 100;
      return `${c} ${p0}%, ${c} ${p1}%`;
    });
    rulerTrack.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  }

  // ---------- selection UI ----------
  function selectionBounds() {
    const a = state.startMile, b = state.endMile;
    return [Math.min(a, b), Math.max(a, b)];
  }

  function updateSelectionUI() {
    const [lo, hi] = selectionBounds();
    const dist = hi - lo;
    statStart.textContent = `Mile ${lo.toFixed(2)}`;
    statEnd.textContent = `Mile ${hi.toFixed(2)}`;
    statDistance.textContent = `${dist.toFixed(2)} mi`;

    const i0 = pointAtMile(lo), i1 = pointAtMile(hi);
    const boroughs = new Set();
    for (let i = i0; i <= i1; i++) boroughs.add(state.points.raw[i].borough);
    statBorough.textContent = [...boroughs].join(', ') || '—';

    if (dist > MIN_MILES) {
      validationMsg.textContent = `✓ Ready to ride — ${dist.toFixed(2)} miles selected.`;
      validationMsg.classList.add('ok');
      animateBtn.disabled = false;
    } else {
      validationMsg.textContent = `Select a stretch longer than ${MIN_MILES} miles (currently ${dist.toFixed(2)} mi).`;
      validationMsg.classList.remove('ok');
      animateBtn.disabled = true;
    }
    drawOverlay();
  }

  function drawOverlay() {
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, state.rect.width, state.rect.height);
    if (!state.tf) return;
    const [lo, hi] = selectionBounds();
    const i0 = pointAtMile(lo), i1 = pointAtMile(hi);
    const { x, y } = state.points;
    const tf = state.tf;

    ctx.strokeStyle = cssVar('--series-selection') || '#1baf7a';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let first = true;
    for (let i = i0; i <= i1; i++) {
      const [px, py] = milesToPixel(x[i], y[i], tf);
      if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();

    for (const [idx, label, color] of [[i0, 'S', '#0ca30c'], [i1, 'E', '#d03b3b']]) {
      const [px, py] = milesToPixel(x[idx], y[idx], tf);
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, py);
    }
  }

  function resetSelection() {
    startSlider.value = 1.0;
    endSlider.value = 4.0;
    state.startMile = 1.0;
    state.endMile = 4.0;
    updateSelectionUI();
  }

  // ---------- live regression (mirrors the Python pipeline) ----------
  function computeLiveFit(i0, i1) {
    const { x, y } = state.points;
    const n = i1 - i0 + 1;
    const k = Math.max(3, Math.min(8, Math.floor(n / 10)));
    let cx = 0, cy = 0, ex = 0, ey = 0;
    for (let i = 0; i < k; i++) { cx += x[i0 + i]; cy += y[i0 + i]; }
    for (let i = 0; i < k; i++) { ex += x[i1 - i]; ey += y[i1 - i]; }
    cx /= k; cy /= k; ex /= k; ey /= k;
    const theta = Math.atan2(ey - cy, ex - cx);
    const ct = Math.cos(-theta), st = Math.sin(-theta);
    const u = new Float64Array(n), v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const xc = x[i0 + i] - cx, yc = y[i0 + i] - cy;
      u[i] = xc * ct - yc * st;
      v[i] = xc * st + yc * ct;
    }
    const lin = polyfit1(u, v);
    const quad = polyfit2(u, v);
    return { u, v, theta, originX: cx, originY: cy, n, lin, quad };
  }

  function polyfit1(u, v) {
    const n = u.length;
    let sU = 0, sV = 0, sUU = 0, sUV = 0;
    for (let i = 0; i < n; i++) { sU += u[i]; sV += v[i]; sUU += u[i] * u[i]; sUV += u[i] * v[i]; }
    const denom = n * sUU - sU * sU;
    const m = Math.abs(denom) > 1e-12 ? (n * sUV - sU * sV) / denom : 0;
    const b = (sV - m * sU) / n;
    const pred = u.map((ui) => m * ui + b);
    const { rmse } = fitQuality(v, pred);
    // The Pearson correlation coefficient r between u and v -- the standard,
    // signed measure of linear association (this *is* r, not R^2 = r^2).
    const r = pearsonR(u, v);
    return { m, b, r, rmse };
  }

  function pearsonR(xs, ys) {
    const n = xs.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const denom = Math.sqrt(sxx * syy);
    return denom > 1e-12 ? sxy / denom : 0;
  }

  function polyfit2(u, v) {
    const n = u.length;
    let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
    for (let i = 0; i < n; i++) {
      const ui = u[i], u2 = ui * ui, vi = v[i];
      S1 += ui; S2 += u2; S3 += u2 * ui; S4 += u2 * u2;
      T0 += vi; T1 += ui * vi; T2 += u2 * vi;
    }
    // [S4 S3 S2][a]   [T2]
    // [S3 S2 S1][b] = [T1]
    // [S2 S1 S0][c]   [T0]
    const A = [[S4, S3, S2], [S3, S2, S1], [S2, S1, S0]];
    const rhs = [T2, T1, T0];
    const [a, b, c] = solve3x3(A, rhs);
    const pred = u.map((ui) => a * ui * ui + b * ui + c);
    const { r2, rmse } = fitQuality(v, pred);
    // Pearson r is only strictly defined for a LINEAR association, so for a
    // quadratic fit we report the "multiple correlation coefficient" instead:
    // r = correlation(actual, predicted), which is always >= 0 and satisfies
    // r^2 == the same variance-explained fraction R^2 would have given, for
    // any least-squares fit (linear or not) -- the standard generalization of
    // "r" beyond simple linear regression.
    const r = Math.sqrt(Math.max(0, r2));
    return { a, b, c, r, rmse };
  }

  function det3(m) {
    return (
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    );
  }
  function solve3x3(A, rhs) {
    const D = det3(A);
    if (Math.abs(D) < 1e-15) return [0, 0, rhs[2] / (A[2][2] || 1)];
    const out = [];
    for (let col = 0; col < 3; col++) {
      const Ac = A.map((row) => row.slice());
      for (let row = 0; row < 3; row++) Ac[row][col] = rhs[row];
      out.push(det3(Ac) / D);
    }
    return out;
  }

  function fitQuality(actual, pred) {
    const n = actual.length;
    let mean = 0; for (let i = 0; i < n; i++) mean += actual[i]; mean /= n;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      ssRes += (actual[i] - pred[i]) ** 2;
      ssTot += (actual[i] - mean) ** 2;
    }
    const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 1;
    const rmse = Math.sqrt(ssRes / n);
    return { r2, rmse };
  }

  function bearingCompass(thetaRad) {
    const degMath = (thetaRad * 180) / Math.PI;
    const compass = ((90 - degMath) % 360 + 360) % 360;
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const ix = Math.floor((compass + 11.25) / 22.5) % 16;
    return { compass, dir: dirs[ix] };
  }

  function localToLatLon(xMi, yMi) {
    const p = state.data.meta.projection;
    return [p.originLat + yMi / p.milesPerDegreeLat, p.originLon + xMi / p.milesPerDegreeLon];
  }

  function dominantType(lo, hi) {
    let lenLinear = 0, lenQuad = 0;
    for (const s of state.data.segments) {
      const overlap = Math.min(hi, s.endMile) - Math.max(lo, s.startMile);
      if (overlap > 0) {
        if (s.type === 'linear') lenLinear += overlap; else lenQuad += overlap;
      }
    }
    return lenQuad > lenLinear ? 'quadratic' : 'linear';
  }

  // ---------- bike animation ----------
  function startRide() {
    const [lo, hi] = selectionBounds();
    const i0 = pointAtMile(lo), i1 = pointAtMile(hi);
    state.lastSelection = { lo, hi, i0, i1 };
    state.domType = dominantType(lo, hi);
    state.lastLiveFit = computeLiveFit(i0, i1);

    state.animating = true;
    animateBtn.disabled = true;
    resetBtn.disabled = true;

    const dist = hi - lo;
    const duration = Math.min(7000, Math.max(2200, dist * 700));
    const start = performance.now();
    const { x, y, mile } = state.points;
    const tf = state.tf;
    const ctx = overlayCanvas.getContext('2d');

    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const targetMile = lo + t * dist;
      const idx = Math.min(Math.max(pointAtMile(targetMile), i0), i1);

      ctx.clearRect(0, 0, state.rect.width, state.rect.height);
      // traveled trail
      ctx.strokeStyle = cssVar('--series-selection') || '#1baf7a';
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      let first = true;
      for (let i = i0; i <= idx; i++) {
        const [px, py] = milesToPixel(x[i], y[i], tf);
        if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
      }
      ctx.stroke();
      // remaining path, faint
      ctx.strokeStyle = cssVar('--text-muted') || '#999';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 3;
      ctx.beginPath();
      first = true;
      for (let i = idx; i <= i1; i++) {
        const [px, py] = milesToPixel(x[i], y[i], tf);
        if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      const [bx, by] = milesToPixel(x[idx], y[idx], tf);
      const lookIdx = Math.min(idx + 1, i1);
      const [nx, ny] = milesToPixel(x[lookIdx], y[lookIdx], tf);
      const heading = Math.atan2(ny - by, nx - bx);
      drawBikeIcon(ctx, bx, by, heading, cssVar('--good') || '#0ca30c');

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        state.animating = false;
        animateBtn.disabled = false;
        resetBtn.disabled = false;
        drawOverlay();
        openNoticeModal();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- modal flow: notice -> quiz -> equation ----------
  const noticeModal = el('noticeModal');
  const quizModal = el('quizModal');
  const equationModal = el('equationModal');
  const noticeQuestions = el('noticeQuestions');
  const quizFeedback = el('quizFeedback');
  const quizContinueBtn = el('quizContinueBtn');

  function wireModals() {
    el('noticeModal').addEventListener('close', () => {}); // handled via submit
    document.querySelector('#noticeModal form').addEventListener('submit', (e) => {
      e.preventDefault();
      const notice = state.notice;
      notice.answers[notice.index] = el('reflectionInput').value;
      if (notice.index < notice.questions.length - 1) {
        notice.index++;
        renderNoticeStep();
      } else {
        noticeModal.close();
        openQuizModal();
      }
    });

    document.querySelectorAll('#quizModal .btn-choice').forEach((btn) => {
      btn.addEventListener('click', () => onQuizChoice(btn));
    });
    quizContinueBtn.addEventListener('click', () => {
      quizModal.close();
      openEquationModal();
    });

    el('equationCloseBtn').addEventListener('click', () => equationModal.close());
    el('tryAnotherBtn').addEventListener('click', () => equationModal.close());
  }

  // Always exactly 4 questions, asked one popup at a time.
  function socraticQuestions(sel, domType, boroughs, crossesBridge) {
    const qs = [];
    qs.push('Watch the path the bicycle just traced. Does it point the same direction the whole way, or does the direction keep changing?');
    qs.push(`If you stretched a straight piece of string from mile ${sel.lo.toFixed(1)} to mile ${sel.hi.toFixed(1)}, would the real route stay right on top of the string, or would it drift away from it?`);
    if (crossesBridge) {
      qs.push(`This stretch crosses ${crossesBridge}. Do bridge ramps usually curve to gain or lose height, or do they run straight?`);
    } else {
      qs.push(`You rode through ${boroughs}. Does the shape of the road seem related to being on a bridge ramp, a park loop, or a city street grid?`);
    }
    if (domType === 'quadratic') {
      qs.push('A curve that bends the same way the whole time (never switching from bending left to bending right) is often modeled by a parabola. Does that match what you saw?');
    } else {
      qs.push('A path with (almost) zero sideways drift, mile after mile, is the signature of one specific function family. Which one?');
    }
    return qs;
  }

  function openNoticeModal() {
    const sel = state.lastSelection;
    const boroughs = statBorough.textContent;
    let crossesBridge = null;
    for (const s of state.data.segments) {
      if (s.bridge && s.startMile < sel.hi && s.endMile > sel.lo) { crossesBridge = s.bridge; break; }
    }
    const questions = socraticQuestions(sel, state.domType, boroughs, crossesBridge);
    state.notice = { questions, index: 0, answers: new Array(questions.length).fill('') };
    quizFeedback.hidden = true;
    quizContinueBtn.hidden = true;
    document.querySelectorAll('#quizModal .btn-choice').forEach((b) => b.classList.remove('correct', 'incorrect'));
    renderNoticeStep();
    noticeModal.showModal();
  }

  function renderNoticeStep() {
    const { questions, index, answers } = state.notice;
    const total = questions.length;
    el('noticeProgress').textContent = `Question ${index + 1} of ${total}`;
    noticeQuestions.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = questions[index];
    noticeQuestions.appendChild(p);
    el('reflectionInput').value = answers[index] || '';
    const isLast = index === total - 1;
    el('noticeContinueBtn').textContent = isLast ? 'Continue activity →' : 'Next →';
  }

  function openQuizModal() {
    quizModal.showModal();
  }

  function onQuizChoice(btn) {
    const choice = btn.dataset.choice;
    const correct = choice === state.domType;
    document.querySelectorAll('#quizModal .btn-choice').forEach((b) => {
      b.classList.remove('correct', 'incorrect');
      if (b.dataset.choice === state.domType) b.classList.add('correct');
      else if (b === btn) b.classList.add('incorrect');
    });
    quizFeedback.hidden = false;
    if (correct) {
      quizFeedback.textContent = state.domType === 'linear'
        ? '✅ Right — this stretch holds a nearly constant direction, which is exactly what a linear function y = mx + b models.'
        : '✅ Right — this stretch bends steadily in one direction, which is what a quadratic function y = ax² + bx + c captures.';
    } else {
      quizFeedback.textContent = state.domType === 'linear'
        ? '❌ Not quite — most of this stretch actually holds a nearly constant direction (little sideways drift), which is the signature of a linear function, not a quadratic one.'
        : '❌ Not quite — most of this stretch keeps bending steadily in one direction rather than holding a constant heading, which is the signature of a quadratic function, not a linear one.';
    }
    quizContinueBtn.hidden = false;
  }

  function openEquationModal() {
    const fit = state.lastLiveFit;
    const sel = state.lastSelection;
    const type = state.domType;
    const { dir, compass } = bearingCompass(fit.theta);
    const [originLat, originLon] = localToLatLon(fit.originX, fit.originY);

    const eqDisplay = el('equationDisplay');
    const eqMeta = el('equationMeta');
    const eqExplain = el('equationExplanation');
    const eqVariables = el('equationVariables');
    const title = el('equationTitle');

    const uMin = Math.min(...fit.u), uMax = Math.max(...fit.u);

    if (type === 'linear') {
      const { m, b, r, rmse } = fit.lin;
      title.textContent = `Linear Equation — Mile ${sel.lo.toFixed(2)} to ${sel.hi.toFixed(2)}`;
      eqDisplay.innerHTML = `y = ${m.toFixed(4)}x ${signedTerm(b)}`;
      eqMeta.innerHTML = `<span><b>r</b> = ${r.toFixed(3)}</span><span><b>Typical deviation</b> ≈ ${(rmse * 5280).toFixed(1)} ft</span><span><b>Points used</b> = ${fit.n}</span>`;
      const { built, variables } = explainLinear(sel, fit.n, m, b, r, rmse * 5280, dir, compass, originLat, originLon);
      eqExplain.textContent = built;
      eqVariables.textContent = variables;
    } else {
      const { a, b, c, r, rmse } = fit.quad;
      title.textContent = `Quadratic Equation — Mile ${sel.lo.toFixed(2)} to ${sel.hi.toFixed(2)}`;
      eqDisplay.innerHTML = `y = ${a.toFixed(4)}x² ${signedTerm(b)}x ${signedTerm(c)}`;
      eqMeta.innerHTML = `<span><b>r</b> = ${r.toFixed(3)}</span><span><b>Typical deviation</b> ≈ ${(rmse * 5280).toFixed(1)} ft</span><span><b>Points used</b> = ${fit.n}</span>`;
      const { built, variables } = explainQuadratic(sel, fit.n, a, b, c, r, rmse * 5280, dir, compass, originLat, originLon, uMin, uMax);
      eqExplain.textContent = built;
      eqVariables.textContent = variables;
    }

    equationModal.showModal();
  }

  function signedTerm(v) { return (v >= 0 ? '+ ' : '- ') + Math.abs(v).toFixed(4); }

  function explainLinear(sel, n, m, b, r, rmseFt, dir, compass, originLat, originLon) {
    const driftFt = Math.abs(m) * 5280;
    const strength = Math.abs(r) >= 0.9 ? 'very strong' : Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.4 ? 'moderate' : 'weak';
    const built = `You highlighted mile ${sel.lo.toFixed(2)} to mile ${sel.hi.toFixed(2)} of the route (${n} recorded GPS points). `
      + `To build this equation we converted every GPS point in your stretch from latitude/longitude into flat x-y coordinates measured in miles, `
      + `then rotated that coordinate grid so a new x-axis points along this stretch's own direction of travel: compass heading ${compass.toFixed(0)}° (${dir}), `
      + `starting from the point at (${originLat.toFixed(5)}°, ${originLon.toFixed(5)}°). In that rotated frame, a least-squares linear regression of `
      + `sideways position y against distance-traveled x gives y = ${m.toFixed(4)}x ${signedTerm(b)}. `;
    const variables = `The slope m = ${m.toFixed(4)} means the path drifts about `
      + `${driftFt.toFixed(1)} feet ${m > 0 ? 'left' : 'right'} of straight-ahead for every mile ridden — close to zero, the hallmark of a straight road. `
      + `The intercept b is forced close to 0 because the x-axis passes through your stretch's own starting point. The correlation coefficient `
      + `r = ${r.toFixed(3)} measures how tightly x and y line up on a straight line (r ranges from -1 to 1, with 0 meaning no linear pattern at all); `
      + `a magnitude this close to ${Math.abs(r) >= 0.7 ? '1' : '0'} is a ${strength} straight-line relationship. The real GPS track wanders from this line `
      + `by only about ${rmseFt.toFixed(1)} feet on average — roughly the size of normal GPS measurement error.`;
    return { built, variables };
  }

  function explainQuadratic(sel, n, a, b, c, r, rmseFt, dir, compass, originLat, originLon, uMin, uMax) {
    const vertexU = Math.abs(a) > 1e-9 ? -b / (2 * a) : null;
    let vertexTxt = '';
    if (vertexU !== null && vertexU >= uMin && vertexU <= uMax) {
      vertexTxt = ` The vertex of this parabola falls at x = ${vertexU.toFixed(3)} miles into your stretch — the point of sharpest turning — confirming the bend is centered inside your selection.`;
    }
    const built = `You highlighted mile ${sel.lo.toFixed(2)} to mile ${sel.hi.toFixed(2)} of the route (${n} recorded GPS points), a stretch dominated by curving road. `
      + `We projected its GPS points into local x-y miles and rotated the frame to point along the chord connecting your stretch's start and end `
      + `(compass heading ${compass.toFixed(0)}°, ${dir}), with the origin at (${originLat.toFixed(5)}°, ${originLon.toFixed(5)}°). A least-squares quadratic `
      + `regression of sideways position y against distance-traveled x gives y = ${a.toFixed(4)}x² ${signedTerm(b)}x ${signedTerm(c)}. `;
    const variables = `The leading coefficient `
      + `a = ${a.toFixed(4)} controls how sharply the road bends — its sign (${a < 0 ? 'negative' : 'positive'}) tells us the road bows to the ${a < 0 ? 'left' : 'right'} `
      + `of the straight-line chord.${vertexTxt} A straight line's correlation coefficient r doesn't strictly apply to a curve, so here r instead measures `
      + `how closely this parabola's predicted path tracks the real one (r = ${r.toFixed(3)}, always between 0 and 1 for this kind of comparison) — `
      + `it explains about ${(r * r * 100).toFixed(0)}% of the sideways variation in the path, with roughly ${rmseFt.toFixed(0)} feet of typical deviation `
      + `— real road geometry a single parabola can't fully capture, such as a compound curve, accounts for the rest.`;
    return { built, variables };
  }
})();
