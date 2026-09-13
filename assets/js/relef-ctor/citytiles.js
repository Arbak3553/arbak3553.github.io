// Тайловый источник города: self-hosted PMTiles (Protomaps basemap, OSM).
// Даёт то, что Overpass не отдаст никогда — КОНТУРЫ ЗДАНИЙ (с этажностью),
// плюс воду полигонами, дороги с классами и парки — из одного локального
// файла range-запросами, без зеркал («8 / 3 / 1.5 км», Арбак 20.08).
// Вне городов из манифеста конструктор живёт на старом Overpass-пути.
import { PMTiles, VectorTile, Pbf } from '../vendor/citytiles-deps.js';
import { projector, samplerOf, MASK_PX } from './water.js';

export const TILE_CITIES = [
  { id: 'msk', name: 'Москва', bbox: [37.30, 55.55, 37.90, 55.95], url: '/assets/tiles/msk.pmtiles' },
  { id: 'spb', name: 'Санкт-Петербург', bbox: [30.05, 59.80, 30.55, 60.10], url: '/assets/tiles/spb.pmtiles' },
];
const insts = new Map();

export function cityTilesFor(lat, lon) {
  for (const c of TILE_CITIES)
    if (lon >= c.bbox[0] && lat >= c.bbox[1] && lon <= c.bbox[2] && lat <= c.bbox[3]) return c;
  return null;
}
function pmOf(c) {
  if (!insts.has(c.id)) insts.set(c.id, new PMTiles(c.url));
  return insts.get(c.id);
}

// зум подбирается по окну: ~2-4 тайла на кадр; z15 несёт полную детальность
// зданий, z13 хватает магистралям восьмикилометрового окна
function zFor(lat, windowM) {
  const C = 40075016.686 * Math.cos(lat * Math.PI / 180);
  return Math.max(11, Math.min(15, Math.round(Math.log2(C * 2.5 / windowM))));
}

const lon2tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2ty = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
function tilePt(z, tx, ty, x, y, extent) {
  const n = 2 ** z;
  const X = (tx + x / extent) / n, Y = (ty + y / extent) / n;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) * 180 / Math.PI, lon: X * 360 - 180 };
}

const tileCache = new Map();
async function getVT(c, z, x, y) {
  const key = `${c.id}/${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const p = pmOf(c).getZxy(z, x, y)
    .then(resp => (resp && resp.data ? new VectorTile(new Pbf(new Uint8Array(resp.data))) : null))
    .catch(() => { tileCache.delete(key); return null; });
  tileCache.set(key, p);
  return p;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// kind/kind_detail -> наши теги; мусор металла (тропинки, сервисы, метро
// под землёй, фонтаны) отсекается здесь же
function roadTags(p) {
  if (p.kind === 'rail') {
    if (p.kind_detail && p.kind_detail !== 'rail') return null;   // метро/трам/фуникулёр
    if ((p.layer || 0) < 0) return null;                          // тоннели
    return { railway: 'rail' };
  }
  if (p.kind === 'path') {
    // аллеи и пешеходные улицы — ткань ближних окон; переходы и тротуары — мусор
    if (p.kind_detail === 'crossing' || p.kind_detail === 'sidewalk' || p.kind_detail === 'steps') return null;
    return { highway: 'path' };
  }
  if (p.kind === 'highway') return { highway: p.kind_detail || 'motorway' };
  if (p.kind === 'major_road') return { highway: p.kind_detail || 'primary' };
  if (p.kind === 'minor_road') {
    if (p.kind_detail === 'parking_aisle') return null;
    if (p.kind_detail === 'service' || p.kind_detail === 'driveway') return { highway: 'service' };
    return { highway: p.kind_detail || 'residential' };
  }
  return null;
}
const PARK_KINDS = new Set(['park', 'garden', 'wood', 'forest', 'nature_reserve', 'meadow']);

/** Все слои города одним заходом: { water, roads, parks, builds } в формате
 *  псевдо-OSM элементов — существующие маски едят их без изменений. */
export async function fetchCityLayers(lat, lon, windowM) {
  const c = cityTilesFor(lat, lon);
  if (!c) return null;
  const z = zFor(lat, windowM);
  const half = windowM * 0.625;   // тот же запас x1.25, что у ячеек Overpass
  const dLat = half / 111320, dLon = dLat / Math.cos(lat * Math.PI / 180);
  const x0 = Math.floor(lon2tx(lon - dLon, z)), x1 = Math.floor(lon2tx(lon + dLon, z));
  const y0 = Math.floor(lat2ty(lat + dLat, z)), y1 = Math.floor(lat2ty(lat - dLat, z));
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
    jobs.push(getVT(c, z, tx, ty).then(vt => ({ vt, tx, ty })));
  const tiles = (await Promise.all(jobs)).filter(t => t.vt);
  if (!tiles.length) return null;

  const water = [], roads = [], parks = [], builds = [];
  const geomOf = (f, tx, ty) => {
    const extent = f.extent || 4096;
    return f.loadGeometry().map(ring => ring.map(pt => tilePt(z, tx, ty, pt.x, pt.y, extent)));
  };
  const pushRings = (f, tx, ty, out, tags) => {
    const rings = geomOf(f, tx, ty);
    if (!rings.length) return;
    const areas = f.loadGeometry().map(signedArea);
    let iMax = 0;
    for (let i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[iMax])) iMax = i;
    const outerSign = Math.sign(areas[iMax] || 1);
    rings.forEach((ring, i) => {
      if (ring.length < 4) return;
      const hole = Math.sign(areas[i] || outerSign) !== outerSign;
      out.push({ type: 'way', geometry: ring, tags: hole ? { ...tags, _hole: 1 } : tags });
    });
  };

  for (const { vt, tx, ty } of tiles) {
    const L = vt.layers;
    if (L.water) for (let i = 0; i < L.water.length; i++) {
      const f = L.water.feature(i), p = f.properties;
      if (f.type === 3) {
        if (p.kind === 'fountain') continue;
        pushRings(f, tx, ty, water, { natural: 'water' });
      } else if (f.type === 2 && p.kind === 'river' && (p.layer || 0) >= 0) {
        for (const line of geomOf(f, tx, ty)) water.push({ type: 'way', geometry: line, tags: { waterway: 'river' } });
      }
    }
    if (L.roads) for (let i = 0; i < L.roads.length; i++) {
      const f = L.roads.feature(i);
      if (f.type !== 2) continue;
      const tags = roadTags(f.properties);
      if (!tags) continue;
      for (const line of geomOf(f, tx, ty)) roads.push({ type: 'way', geometry: line, tags });
    }
    if (L.landuse) for (let i = 0; i < L.landuse.length; i++) {
      const f = L.landuse.feature(i);
      if (f.type === 3 && PARK_KINDS.has(f.properties.kind))
        pushRings(f, tx, ty, parks, { leisure: 'park' });
    }
    if (L.buildings) for (let i = 0; i < L.buildings.length; i++) {
      const f = L.buildings.feature(i), p = f.properties;
      if (f.type !== 3 || p.kind !== 'building') continue;
      pushRings(f, tx, ty, builds, { building: 'yes', h: p.height || 10 });
    }
  }
  // дырки рисуются ПОСЛЕ тел — маскам достаточно порядка массива
  const holesLast = a => [...a.filter(e => !e.tags._hole), ...a.filter(e => e.tags._hole)];
  return { water: holesLast(water), roads, parks: holesLast(parks), builds: holesLast(builds), z };
}

/** Маска застройки: заливка контуров зданий с ЭТАЖНОСТЬЮ в яркости —
 *  высотка поднимется выше пятиэтажки. Дырки-дворы вычитаются. */
export function buildingsMask(els, lat, lon, windowM, { zoom, discMm }) {
  if (!els || !els.length) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = MASK_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, MASK_PX, MASK_PX);
  const toPx = projector(lat, lon, windowM);
  for (const e of els) {
    if (!e.geometry || e.geometry.length < 4) continue;
    if (e.tags._hole) ctx.fillStyle = '#000';
    else {
      // 0.6 базы + этажность: 10 м (три этажа) -> 0.65, 60 м и выше -> 1.0
      const v = Math.max(0.6, Math.min(1, 0.6 + (e.tags.h || 10) / 150));
      const b = Math.round(v * 255);
      ctx.fillStyle = `rgb(${b},${b},${b})`;
    }
    ctx.beginPath();
    const [x0, y0] = toPx(e.geometry[0].lat, e.geometry[0].lon);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < e.geometry.length; i++) {
      const [x, y] = toPx(e.geometry[i].lat, e.geometry[i].lon);
      ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }
  return samplerOf(ctx, 1);
}
