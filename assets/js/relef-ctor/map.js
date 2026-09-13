// Map picker: client-rendered hillshade + contours from terrarium tiles with a
// CARTO label overlay, fractional zoom, sampled-area footprint overlay, drag /
// wheel-zoom / right-drag rotation. Port of the site's MapCanvas (rev. 27.07).
import { FRAME, ll2t, t2ll, metersPerPx, contourInterval, terrTile, SEA_LEVEL_M } from './mosaic.js';

// view: shared mutable {lat,lon,mz,bearing}; hooks: {onMove(phase), footprint()}
// phase 'move' = hot path (re-crop the in-memory mosaic), 'end' = release/zoom/jump.
export function initMap(canvas, view, hooks) {
  const mctx = canvas.getContext('2d');
  const shadeCache = new Map();
  const labelCache = new Map();
  let basemap = 'terrain';
  const maxZ = () => (basemap === 'streets' ? 17 : 14);

  // hypsometric tint: muted elevation bands in the site's palette (standard
  // cartographic technique; hillshade and contours stay on top for depth)
  const HYPSO = [
    [0, 223, 230, 226], [200, 205, 214, 194], [500, 216, 214, 184],
    [1000, 217, 201, 168], [2000, 207, 174, 148], [3500, 185, 141, 126], [5000, 239, 236, 231],
  ];
  function hypsoColor(e) {
    if (e <= 0) return [214, 222, 223];
    let lo = HYPSO[0], hi = HYPSO[HYPSO.length - 1];
    for (let i = 0; i < HYPSO.length - 1; i++) {
      if (e >= HYPSO[i][0] && e < HYPSO[i + 1][0]) { lo = HYPSO[i]; hi = HYPSO[i + 1]; break; }
    }
    const t = Math.min(1, (e - lo[0]) / Math.max(hi[0] - lo[0], 1));
    return [lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t, lo[3] + (hi[3] - lo[3]) * t];
  }

  function shadeTile(z, x, y) {
    const n = 2 ** z; x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const hypso = basemap === 'hypso';
    const k = `${hypso ? 'h' : 'm'}/${z}/${x}/${y}`;
    if (shadeCache.has(k)) return shadeCache.get(k);
    shadeCache.set(k, null);
    terrTile(z, x, y).then(img => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0);
      const px = c.getImageData(0, 0, 256, 256).data;
      const e = new Float32Array(256 * 256);
      for (let i = 0; i < 256 * 256; i++) {
        const raw = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        e[i] = raw < SEA_LEVEL_M ? SEA_LEVEL_M : raw;
      }
      // water mask: sea level plus dead-flat neighbourhoods — terrarium flattens
      // inland water (Baikal reads as exactly 449 m across half a tile) while real
      // terrain never is; measured 0% false positives on mountain tiles
      const water = new Uint8Array(256 * 256);
      for (let yy = 0; yy < 256; yy++) for (let xx = 0; xx < 256; xx++) {
        const i = yy * 256 + xx, v = e[i];
        if (v <= SEA_LEVEL_M) { water[i] = 1; continue; }
        if (xx === 0 || yy === 0 || xx === 255 || yy === 255) continue;
        let flat = true;
        for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(e[(yy + dy) * 256 + xx + dx] - v) > 0.01) { flat = false; break; }
        }
        if (flat) water[i] = 1;
      }
      const outImg = c.createImageData(256, 256);
      const o = outImg.data, ci = contourInterval(z);
      for (let yy = 0; yy < 256; yy++) for (let xx = 0; xx < 256; xx++) {
        const i = yy * 256 + xx;
        const ex = e[yy * 256 + Math.min(xx + 1, 255)], ey = e[Math.min(yy + 1, 255) * 256 + xx];
        const dx = ex - e[i], dy = ey - e[i];
        let sh = 0.5 + (dx + dy) * 0.028;                 // NW light
        sh = Math.max(0, Math.min(1, sh));
        const contour = e[i] > 0 && !water[i] && (Math.floor(e[i] / ci) !== Math.floor(ex / ci) || Math.floor(e[i] / ci) !== Math.floor(ey / ci));
        if (water[i]) {
          o[i * 4] = 156; o[i * 4 + 1] = 188; o[i * 4 + 2] = 209;   // muted blue, both basemaps
        } else if (hypso) {
          const [r, g, b] = hypsoColor(e[i]);
          const l = (0.72 + 0.42 * sh) * (contour ? 0.86 : 1);
          o[i * 4] = Math.min(255, r * l); o[i * 4 + 1] = Math.min(255, g * l); o[i * 4 + 2] = Math.min(255, b * l);
        } else {
          let v = 196 + 56 * sh;
          if (contour) v *= 0.80;                          // contour line
          o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v;
        }
        o[i * 4 + 3] = 255;
      }
      c.putImageData(outImg, 0, 0);
      shadeCache.set(k, cv); draw();
    }).catch(() => {});
    return null;
  }

  function rasterTile(style, z, x, y) {
    const n = 2 ** z; x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const k = `${style}/${z}/${x}/${y}`;
    const cached = labelCache.get(k);
    if (cached) return cached.complete && cached.naturalWidth ? cached : null;
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = draw; im.onerror = () => {};
    im.src = style === 'osm'
      ? `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
      : `https://basemaps.cartocdn.com/${style}/${z}/${x}/${y}.png`;
    labelCache.set(k, im); return im.complete ? im : null;
  }

  function drawScalebar() {
    const el = document.querySelector('[data-ctor-scalebar]');
    if (!el) return;
    const mpp = metersPerPx(view.lat, view.mz);
    const targets = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
    let best = targets[0];
    for (const t of targets) if (t / mpp <= 110) best = t;
    el.style.width = Math.round(best / mpp) + 'px';
    el.textContent = best >= 1000 ? (best / 1000) + ' км' : best + ' м';
  }

  // Коалесценция отрисовки: pointermove стреляет до 120 Гц, и синхронный
  // draw() на каждое событие жёг до целого ядра одними тайлами, толкаясь с
  // rAF-рендером кольца («лаги когда карту перетягиваешь», 20.08). Горячие
  // пути просят кадр — рисуем не чаще одного раза за кадр.
  let drawQueued = false;
  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    mctx.fillStyle = '#EDEDED';
    mctx.fillRect(0, 0, W, H);
    // fractional zoom: render integer-level tiles scaled by the remainder
    const tz = Math.round(view.mz);
    const zsc = 2 ** (view.mz - tz);
    const [cx, cy] = ll2t(view.lat, view.lon, tz);
    const ccx = cx * 256, ccy = cy * 256;
    const D = Math.hypot(W, H) / 2 / zsc;                 // cover the rotated, scaled viewport
    const tx0 = Math.floor((ccx - D) / 256), tx1 = Math.ceil((ccx + D) / 256);
    const ty0 = Math.floor((ccy - D) / 256), ty1 = Math.ceil((ccy + D) / 256);
    mctx.save();
    mctx.translate(W / 2, H / 2);
    mctx.rotate(view.bearing);
    mctx.scale(zsc, zsc);
    if (basemap === 'streets') {
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const im = rasterTile('osm', tz, tx, ty);
        if (im) mctx.drawImage(im, tx * 256 - ccx, ty * 256 - ccy);
      }
    } else {
      // подписи CARTO убраны: сервис стал требовать ключ и отдавал плитки
      // «API KEY REQUIRED» прямо в карту (21.08); hillshade самодостаточен
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const sc = shadeTile(tz, tx, ty);
        if (sc) mctx.drawImage(sc, tx * 256 - ccx, ty * 256 - ccy);
      }
    }
    mctx.restore();
    // sampled-area footprint: dim the outside, stroke the true shape
    const f = hooks.footprint() || { kind: 'rect', w: 1, h: 1 };
    const fw = (f.kind === 'circle' ? f.d : f.w) * FRAME;
    const fh = (f.kind === 'circle' ? f.d : f.h) * FRAME;
    mctx.save();
    mctx.beginPath();
    mctx.rect(0, 0, W, H);
    if (f.kind === 'circle') mctx.arc(W / 2, H / 2, fw / 2, 0, 2 * Math.PI, true);
    else mctx.rect((W - fw) / 2, (H - fh) / 2, fw, fh);
    mctx.fillStyle = 'rgba(255,255,255,0.45)';
    mctx.fill('evenodd');
    mctx.restore();
    mctx.strokeStyle = '#000';
    mctx.lineWidth = 3;
    mctx.beginPath();
    if (f.kind === 'circle') mctx.arc(W / 2, H / 2, fw / 2, 0, 2 * Math.PI);
    else mctx.rect((W - fw) / 2, (H - fh) / 2, fw, fh);
    mctx.stroke();
    drawScalebar();
    const needle = document.querySelector('[data-ctor-needle]');
    if (needle) needle.style.transform = `rotate(${view.bearing}rad)`;
  }

  // screen offset -> map offset under current bearing (y-down)
  const bearingRotScreen = (a, b) => {
    const c = Math.cos(view.bearing), s = Math.sin(view.bearing);
    return [a * c + b * s, -a * s + b * c];
  };
  let dragging = false, rotating = false, lx = 0, ly = 0;
  const mscale = () => canvas.width / canvas.getBoundingClientRect().width;
  const startDrag = (x, y, rot) => { if (rot) rotating = true; else dragging = true; lx = x; ly = y; };
  const moveDrag = (x, y) => {
    if (rotating) {
      view.bearing += (x - lx) * 0.008;
      lx = x; ly = y;
      scheduleDraw(); hooks.onMove('move');
      return;
    }
    if (!dragging) return;
    const s = mscale();
    const [cx, cy] = ll2t(view.lat, view.lon, view.mz);
    const [mx, my] = bearingRotScreen((x - lx) * s, (y - ly) * s);
    [view.lat, view.lon] = t2ll(cx - mx / 256, cy - my / 256, view.mz);
    lx = x; ly = y;
    scheduleDraw(); hooks.onMove('move');
  };
  const endDrag = () => {
    if (dragging || rotating) hooks.onMove('end');
    dragging = false; rotating = false;
  };
  canvas.addEventListener('mousedown', e => {
    startDrag(e.clientX, e.clientY, e.button === 2 || e.ctrlKey || e.metaKey);
    e.preventDefault();
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
  addEventListener('mouseup', endDrag);
  /* Pinch. The touch path used to read e.touches[0] only, so a second finger
     was silently dropped and the map had no zoom at all on a phone — the wheel
     and the +/- buttons were the only ways in. Distance drives the zoom, the
     midpoint drags like one finger would. Bearing is left to the slider: a
     rotation deadzone fighting the pinch does more harm than it fixes. */
  let pinch = null;
  const fingerGap = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const fingerMid = (a, b) => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length >= 2) {
      dragging = rotating = false;
      const [a, b] = e.touches;
      pinch = { gap: fingerGap(a, b), mz: view.mz };
      [lx, ly] = fingerMid(a, b);
      return;
    }
    pinch = null;
    const t = e.touches[0];
    if (t) startDrag(t.clientX, t.clientY, false);
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (pinch && e.touches.length >= 2) {
      const [a, b] = e.touches;
      const gap = fingerGap(a, b);
      if (gap > 0 && pinch.gap > 0) {
        view.mz = Math.max(4, Math.min(maxZ(), pinch.mz + Math.log2(gap / pinch.gap)));
      }
      const [mx, my] = fingerMid(a, b);
      const s = mscale();
      const [cx, cy] = ll2t(view.lat, view.lon, view.mz);
      const [dx, dy] = bearingRotScreen((mx - lx) * s, (my - ly) * s);
      [view.lat, view.lon] = t2ll(cx - dx / 256, cy - dy / 256, view.mz);
      lx = mx; ly = my;
      scheduleDraw(); hooks.onMove('move');
      e.preventDefault();
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    moveDrag(t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    if (pinch) {
      if (e.touches.length >= 2) return;
      pinch = null;
      hooks.onMove('end');
      // lifting one finger of two hands the map back to a plain drag
      const t = e.touches[0];
      if (t) startDrag(t.clientX, t.clientY, false);
      return;
    }
    endDrag();
  });
  canvas.addEventListener('touchcancel', () => { pinch = null; endDrag(); });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // smooth fractional zoom: small continuous steps instead of whole levels
    const dz = Math.max(-0.5, Math.min(0.5, -e.deltaY * 0.002));
    view.mz = Math.max(4, Math.min(maxZ(), view.mz + dz));
    scheduleDraw(); hooks.onMove('move');
  }, { passive: false });

  let zoomAnim = 0;
  const zoomBy = d => {
    // glide the zoom buttons over 250ms instead of snapping a whole level
    const from = view.mz, to = Math.max(4, Math.min(maxZ(), from + d));
    cancelAnimationFrame(zoomAnim);
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 250);
      view.mz = from + (to - from) * (1 - (1 - k) ** 3);
      draw();
      hooks.onMove(k < 1 ? 'move' : 'end');
      if (k < 1) zoomAnim = requestAnimationFrame(step);
    };
    zoomAnim = requestAnimationFrame(step);
  };
  let rotAnim = 0;
  const rotateBy = d => {
    // glide the rotate buttons over 200ms
    const from = view.bearing, to = from + d;
    cancelAnimationFrame(rotAnim);
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 200);
      view.bearing = from + (to - from) * (1 - (1 - k) ** 3);
      draw();
      hooks.onMove(k < 1 ? 'move' : 'end');
      if (k < 1) rotAnim = requestAnimationFrame(step);
    };
    rotAnim = requestAnimationFrame(step);
  };

  return {
    draw,
    zoomIn() { zoomBy(1); },
    zoomOut() { zoomBy(-1); },
    rotateLeft() { rotateBy(-Math.PI / 12); },
    rotateRight() { rotateBy(Math.PI / 12); },
    resetBearing() { view.bearing = 0; draw(); hooks.onMove('move'); },
    setBearing(b) { view.bearing = b; scheduleDraw(); hooks.onMove('move'); },
    goTo(lat, lon, mz, bearing) {
      view.lat = lat; view.lon = lon;
      if (mz !== undefined) view.mz = mz;
      if (bearing !== undefined) view.bearing = bearing;
      draw(); hooks.onMove('end');
    },
    setBasemap(b) {
      basemap = b;
      if (basemap !== 'streets' && view.mz > 14) { view.mz = 14; hooks.onMove('end'); }
      draw();
    },
  };
}
