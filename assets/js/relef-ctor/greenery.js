// Зелень города: парки, сады, леса из OSM — в маске зернь-паттерн, в металле
// матовое сатинированное пятно против полированных кварталов («реальная
// карта на диске», Арбак 20.08). Свой модуль: water.js на лимите размера.
import { slim, lsGet, lsPut } from './citycache.js';
import { ask, quantSpec, bboxOf, projector, samplerOf, MASK_PX, PAD } from './water.js';

const cache = new Map();

/** Парки и зелень: реальные полигоны OSM, в маске — зернь-пунктир (паттерн
 *  точек), в металле читается матовым сатинированным пятном против
 *  полированных кварталов. Реляции (Измайлово, Сокольники) — скелетом,
 *  как у воды. */
export async function fetchParks(lat, lon, windowM) {
  const q = quantSpec(lat, lon, windowM);
  const key = `g:${q.key}`;   // g:, не p: — старый жирный запрос кешировался под p:
  if (cache.has(key)) return cache.get(key);
  const stored = await lsGet(key);
  if (stored) { const p = Promise.resolve(stored); cache.set(key, p); return p; }
  const bbox = bboxOf(q.qlat, q.qlon, windowM * PAD);
  // БЕЗ landuse=grass/meadow: дворовые газоны Москвы — тысячи полигонов,
  // зеркала режут ответ по размеру, и слой не доезжал вовсе (прод, 20.08).
  // Зелень изделия — это ПАРКИ и ЛЕСА, не газоны.
  const full = `[out:json][timeout:25];`
    + `(way["leisure"~"^(park|garden)$"](${bbox});`
    + `way["landuse"="forest"](${bbox});`
    + `way["natural"="wood"](${bbox}););`
    + `out geom 3000;`
    + `relation["leisure"~"^(park|garden)$"](${bbox})->.r;`
    + `.r out body;`
    + `way(r.r)(${bbox});out geom 1500;`;
  const lite = `[out:json][timeout:20];`
    + `way["leisure"="park"](${bbox});out geom 1200;`;
  const p = ask(full)
    .then(async els => {
      if (els) { const s = slim(els); lsPut(key, s); return s; }
      const l = await ask(lite);                     // деградация: только парки
      if (!l) { cache.delete(key); return null; }    // неудачу не кешируем
      return slim(l);
    });
  cache.set(key, p);
  return p;
}

export function parksMask(elements, lat, lon, windowM, { zoom, discMm }) {
  if (!elements || !elements.length) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = MASK_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, MASK_PX, MASK_PX);
  const toPx = projector(lat, lon, windowM);
  // Зернь: шаг — КОНСТАНТА РАСТРА (~3.4 px), а не мм изделия. Шаг в мм на
  // мелком диске становился крупнее ячейки меша, и AA читал точки
  // по отдельности — парки шли «лишаём» вместо мата (S-диск, 20.08).
  // Константа растра держит зерно мельче ячейки на всех размерах.
  const step = Math.max(3, Math.round(MASK_PX * 0.0033));
  const pat = document.createElement('canvas');
  pat.width = pat.height = step;
  const pc = pat.getContext('2d');
  pc.fillStyle = '#fff';
  pc.beginPath();
  pc.arc(step / 2, step / 2, Math.max(1, step * 0.26), 0, 2 * Math.PI);
  pc.fill();
  ctx.fillStyle = ctx.createPattern(pat, 'repeat');
  const grain = ctx.fillStyle;
  const fillRing = (pts, hole) => {
    ctx.fillStyle = hole ? '#000' : grain;
    ctx.beginPath();
    const [x0, y0] = toPx(pts[0][0], pts[0][1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = toPx(pts[i][0], pts[i][1]);
      ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  };
  // склейка внешних колец реляций по совпадающим концам — тот же приём,
  // что у воды в lineMask
  const wayById = new Map();
  const memberIds = new Set();
  for (const e of elements) {
    if (e.type === 'relation' && e.members)
      for (const m of e.members) if (m.type === 'way') memberIds.add(m.ref);
    if (e.type === 'way' && e.geometry && e.geometry.length > 1)
      wayById.set(e.id, e.geometry.map(g => [g.lat, g.lon]));
  }
  const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  for (const e of elements) {
    if (e.type !== 'relation' || !e.members) continue;
    const segs = e.members
      .filter(m => m.type === 'way' && m.role !== 'inner' && wayById.has(m.ref))
      .map(m => wayById.get(m.ref).slice());
    while (segs.length) {
      const ring = segs.shift().slice();
      let grew = true;
      while (grew && !eq(ring[0], ring[ring.length - 1])) {
        grew = false;
        for (let i = 0; i < segs.length; i++) {
          const sg = segs[i], tail = ring[ring.length - 1];
          if (eq(sg[0], tail)) { ring.push(...sg.slice(1)); segs.splice(i, 1); grew = true; break; }
          if (eq(sg[sg.length - 1], tail)) { ring.push(...sg.slice(0, -1).reverse()); segs.splice(i, 1); grew = true; break; }
        }
      }
      if (ring.length > 3 && eq(ring[0], ring[ring.length - 1])) fillRing(ring, false);
    }
  }
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 3) continue;
    if (memberIds.has(e.id) && !(e.tags && (e.tags.leisure || e.tags.landuse || e.tags.natural))) continue;
    fillRing(e.geometry.map(g => [g.lat, g.lon]), !!(e.tags && e.tags._hole));
  }
  return samplerOf(ctx, 1);
}

