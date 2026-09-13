// Heightmap mosaic: a 5x5 terrarium tile mosaic kept in memory so drags re-crop
// the elevation window with ZERO network. Port of the site's heightmap-loader +
// window math (rev. 27.07: pixel-derived anchor keeps the window always centered).

export const FRAME = 460;   // selection frame on the map, px
export const M = 1280;      // mosaic side, px: 5x5 tiles of 256

export function ll2t(lat, lon, z) {
  const n = 2 ** z;
  return [(lon + 180) / 360 * n, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n];
}
export function t2ll(tx, ty, z) {
  const n = 2 ** z;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI, tx / n * 360 - 180];
}
export function metersPerPx(lat, z) { return 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z; }
export const contourInterval = z => z >= 13 ? 50 : z >= 11 ? 100 : z >= 9 ? 200 : 500;

/** Terrain zoom and window size for a map view; supports fractional map zoom. */
export function windowSpec(mz) {
  const zt = Math.max(6, Math.min(15, Math.floor(mz) + 1));
  const cw = Math.min(1000, Math.round(FRAME * 2 ** (zt - mz)));
  return { zt, cw };
}
export const anchorOf = (t, cw) => Math.floor(t - cw / 512);
export const wrapTileX = (x, z) => { const n = 2 ** z; return ((x % n) + n) % n; };
export const tileYInGrid = (y, z) => y >= 0 && y < 2 ** z;

/** Sea level clamp: terrarium tiles carry bathymetry — left raw, the sea floor
 *  casts as ridges while land loses contrast. Water must read as flat ground. */
export const SEA_LEVEL_M = 0;

const terrCache = new Map();
export function terrTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (terrCache.has(k)) return terrCache.get(k);
  const p = new Promise((res, rej) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => res(img); img.onerror = () => rej(new Error('tile ' + k));
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  });
  terrCache.set(k, p); return p;
}

/** Fetch the 5x5 terrarium mosaic centered for a cw-wide window at (lat, lon). */
export async function loadMosaic(lat, lon, zt, cw) {
  const [xt, yt] = ll2t(lat, lon, zt);
  const tx0 = anchorOf(xt, cw), ty0 = anchorOf(yt, cw);
  const cv = document.createElement('canvas');
  cv.width = cv.height = M;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  await Promise.all([0, 1, 2, 3, 4].flatMap(dy => [0, 1, 2, 3, 4].map(dx => {
    if (!tileYInGrid(ty0 + dy, zt)) return undefined;   // past the mercator cut-off
    return terrTile(zt, wrapTileX(tx0 + dx, zt), ty0 + dy)
      .then(img => ctx.drawImage(img, dx * 256, dy * 256)).catch(() => {});
  })));
  return { px: ctx.getImageData(0, 0, M, M), tx0, ty0, zt };
}

/** Crop origin of the cw*cw window centered on (lat, lon); `stale` flags that the
 *  view drifted onto a different anchor — refetch in the background to recenter. */
export function cropOrigin(m, lat, lon, cw) {
  const [xt, yt] = ll2t(lat, lon, m.zt);
  const x0 = Math.max(0, Math.min(M - cw, Math.round((xt - m.tx0) * 256 - cw / 2)));
  const y0 = Math.max(0, Math.min(M - cw, Math.round((yt - m.ty0) * 256 - cw / 2)));
  const stale = anchorOf(xt, cw) !== m.tx0 || anchorOf(yt, cw) !== m.ty0;
  return { x0, y0, stale };
}

/** Zero-network window crop out of the in-memory mosaic (terrarium decode + sea clamp).
 *  maxSide caps the returned grid: a 920px window costs ~10ms to decode and ~45ms to
 *  smooth, while the geometry samples it a few hundred times across — during drags a
 *  coarser grid is indistinguishable and an order of magnitude cheaper. */
export function cropWindow(m, x0, y0, cw, maxSide = Infinity) {
  const px = m.px.data, W = m.px.width;
  const step = Math.max(1, Math.ceil(cw / maxSide));
  const n = Math.ceil(cw / step);
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = ((y0 + y * step) * W + (x0 + x * step)) * 4;
    const e = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
    data[y * n + x] = e < SEA_LEVEL_M ? SEA_LEVEL_M : e;
  }
  return { w: n, h: n, data };
}
