// Roads-outline surface (parked feature, flag in main.js): the street network of
// the selected window extruded onto a flat face. Port of the site's roads engine +
// Overpass loader; ribbons are built in FACE-MM space so road widths obey the
// casting invariant (walls >= 0.8mm) instead of scaling with the map.
import * as THREE from 'three';
import { mergeGeometries } from '../jsm/utils/BufferGeometryUtils.js';
import { FRAME, ll2t, metersPerPx } from './mosaic.js';

const HALF_W = { major: 0.5, mid: 0.45, minor: 0.4 };
const MIN_AREA_MM2 = 0.05;
const MAX_PRISMS = 3000;

// map-frame fraction -> screen fraction under bearing (y-down)
export function screenOf(bearing, fx, fy) {
  const c = Math.cos(bearing), s = Math.sin(bearing);
  return [fx * c - fy * s, fx * s + fy * c];
}

function shoelace(pts) {
  let a2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a2) / 2;
}

function ribbon(pts, halfW) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    const [x0, y0] = pts[Math.max(i - 1, 0)];
    const [x2, y2] = pts[Math.min(i + 1, pts.length - 1)];
    let dx = x2 - x0, dy = y2 - y0;
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    L.push(new THREE.Vector2(x - dy * halfW, y + dx * halfW));
    R.push(new THREE.Vector2(x + dy * halfW, y - dx * halfW));
  }
  return L.concat(R.reverse());
}

// Liang-Barsky clip of one segment against a rect
function clipSeg(ax, ay, bx, by, x0, x1, y0, y1) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const edge = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (edge(-dx, ax - x0) && edge(dx, x1 - ax) && edge(-dy, ay - y0) && edge(dy, y1 - ay)) {
    return t0 <= t1 ? [t0, t1] : null;
  }
  return null;
}

function clipPolyRect(pts, x0, x1, y0, y1) {
  const out = [];
  let run = [];
  const flush = () => { if (run.length >= 2) out.push(run); run = []; };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const t = clipSeg(ax, ay, bx, by, x0, x1, y0, y1);
    if (!t) { flush(); continue; }
    const [ta, tb] = t;
    const pa = [ax + (bx - ax) * ta, ay + (by - ay) * ta];
    const pb = [ax + (bx - ax) * tb, ay + (by - ay) * tb];
    if (run.length === 0 || ta > 0) { flush(); run = [pa]; }
    run.push(pb);
    if (tb < 1) flush();
  }
  flush();
  return out;
}

function clipPolyCircle(pts, R) {
  const out = [];
  let run = [];
  const flush = () => { if (run.length >= 2) out.push(run); run = []; };
  const R2 = R * R;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const a = dx * dx + dy * dy;
    if (a === 0) continue;
    const b = 2 * (ax * dx + ay * dy);
    const c = ax * ax + ay * ay - R2;
    const disc = b * b - 4 * a * c;
    if (disc < 0) { flush(); continue; }
    const sq = Math.sqrt(disc);
    const ta = Math.max(0, (-b - sq) / (2 * a)), tb = Math.min(1, (-b + sq) / (2 * a));
    if (ta > tb) { flush(); continue; }
    const pa = [ax + dx * ta, ay + dy * ta];
    const pb = [ax + dx * tb, ay + dy * tb];
    if (run.length === 0 || ta > 0) { flush(); run = [pa]; }
    run.push(pb);
    if (tb < 1) flush();
  }
  flush();
  return out;
}

const extrudePrism = (shapePts, depth) =>
  new THREE.ExtrudeGeometry(new THREE.Shape(shapePts), { depth, bevelEnabled: false, curveSegments: 4 });

function buildPrisms(pieces, depth) {
  const geoms = [];
  let vol = 0;
  for (const p of pieces) {
    if (geoms.length >= MAX_PRISMS) break;
    const poly = ribbon(p.pts, HALF_W[p.cls]);
    if (shoelace(poly) < MIN_AREA_MM2) continue;
    geoms.push(extrudePrism(poly, depth));
    vol += shoelace(poly) * depth;
  }
  return { geoms, vol };
}

/** Street lattice inside the signet's bezel: floor is recessed, streets rise from
 *  it and finish flush with the bezel edge plus `extra`. */
export function buildRoadsSignet(fi, roads, bearing, extra) {
  const mxx = fi.mnx + fi.span * (1 - 2 * fi.padx);
  const mxz = fi.mnz + fi.span * (1 - 2 * fi.padz);
  const inset = 0.02;   // touch the bezel walls
  const pieces = [];
  for (const r of roads) {
    const mm = r.pts.map(([fx, fy]) => {
      const [sx, sy] = screenOf(bearing, fx, fy);
      const u = 0.5 + sx / 0.6, v = 0.5 - sy / 0.6;
      return [(u - fi.padx) * fi.span + fi.mnx, -((v - fi.padz) * fi.span + fi.mnz)];
    });
    for (const piece of clipPolyRect(mm, fi.mnx + inset, mxx - inset, -mxz + inset, -fi.mnz - inset)) {
      pieces.push({ pts: piece, cls: r.cls });
    }
  }
  const { geoms, vol } = buildPrisms(pieces, fi.recess + extra);
  if (!geoms.length) return { mesh: null, vol: 0 };
  for (const g of geoms) {
    g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, fi.R_O - fi.recess, 0, 1, 0, 0, 0, 0, 0, 1));
    g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  }
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  merged.computeVertexNormals();
  return { mesh: merged, vol };
}

/** Openwork disc: the street network IS the coin — ribbons at full thickness
 *  welded into a rim ring, air in between. */
export function buildRoadsOpenDisc(R, zBottom, T, roads, bearing, extra) {
  const rimW = 1.1;
  const Rin = R - rimW;
  const rimShape = new THREE.Shape();
  rimShape.absarc(0, 0, R, 0, 2 * Math.PI, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, Rin, 0, 2 * Math.PI, true);
  rimShape.holes.push(hole);
  const rim = new THREE.ExtrudeGeometry(rimShape, { depth: T, bevelEnabled: false, curveSegments: 96 });
  let vol = Math.PI * (R * R - Rin * Rin) * T;

  const pieces = [];
  for (const r of roads) {
    const mm = r.pts.map(([fx, fy]) => {
      const [sx, sy] = screenOf(bearing, fx, fy);
      return [sx * 2 * R / 0.55, -sy * 2 * R / 0.55];
    });
    // clip to the rim's midline so street ends weld INTO the ring
    for (const piece of clipPolyCircle(mm, R - rimW / 2)) {
      pieces.push({ pts: piece, cls: r.cls });
    }
  }
  const { geoms, vol: pv } = buildPrisms(pieces, T + extra);
  vol += pv;
  const all = [rim, ...geoms];
  const merged = mergeGeometries(all);
  all.forEach(g => g.dispose());
  merged.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, zBottom));
  merged.computeVertexNormals();
  return { mesh: merged, vol };
}

/* ---------------- Overpass road loader ---------------- */
// RF mirror first: overpass-api.de is often slow/blocked from RF networks
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CLS = [
  [/^(motorway|trunk|primary)/, 'major'],
  [/^(secondary|tertiary)/, 'mid'],
];
// low = the recognizable city skeleton, high = every side street
const TIER_RE = {
  low: '^(motorway|trunk|primary|secondary)',
  medium: '^(motorway|trunk|primary|secondary|tertiary)',
  high: '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)',
};
const ORDER = ['low', 'medium', 'high'];
const roadsCache = new Map();

export function fetchRoads(lat, lon, mz, detail) {
  const cap = mz < 13 ? 'medium' : 'high';
  const tier = ORDER[Math.min(ORDER.indexOf(detail), ORDER.indexOf(cap))];
  const key = `${lat.toFixed(3)}/${lon.toFixed(3)}/${Math.round(mz)}/${tier}`;
  const hit = roadsCache.get(key);
  if (hit) return hit;
  const lsKey = 'relefroads:' + key;
  try {
    const c = JSON.parse(localStorage.getItem(lsKey) || 'null');
    if (Array.isArray(c)) {
      const pr = Promise.resolve(c);
      roadsCache.set(key, pr);
      return pr;
    }
  } catch (e) { /* ignore cache */ }

  const mpp = metersPerPx(lat, mz);
  const half = FRAME * mpp / 2 * 0.65;   // the face samples ~0.6 of the frame
  const dLat = half / 111320, dLon = half / (111320 * Math.cos(lat * Math.PI / 180));
  const bbox = `${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}`;
  const q = `[out:json][timeout:25];way["highway"~"${TIER_RE[tier]}"](${bbox});out geom ${tier === 'high' ? 8000 : 5000};`;

  const p = (async () => {
    // race all mirrors, first healthy answer wins
    const attempt = async ep => {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('overpass http ' + r.status);
      const cand = await r.json();
      // Overpass reports limit/timeout errors as HTTP 200 with a remark
      if (!(cand.elements && cand.elements.length) && cand.remark) throw new Error('overpass remark');
      return cand;
    };
    const j = await Promise.any(ENDPOINTS.map(attempt))
      .catch(() => { throw new Error('overpass unavailable'); });
    const [cx, cy] = ll2t(lat, lon, mz);
    const list = [];
    for (const e of (j.elements || [])) {
      if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
      const hw = (e.tags && e.tags.highway) || '';
      const found = CLS.find(([re]) => re.test(hw));
      const cls = found ? found[1] : 'minor';
      const pts = e.geometry.map(g => {
        const [tx, ty] = ll2t(g.lat, g.lon, mz);
        return [+((tx - cx) * 256 / FRAME).toFixed(4), +((ty - cy) * 256 / FRAME).toFixed(4)];
      });
      // keep only what can reach the face at any bearing
      if (pts.some(([x, y]) => Math.abs(x) < 0.45 && Math.abs(y) < 0.45)) list.push({ pts, cls });
    }
    const res = list.slice(0, 6000);
    // never cache an empty result — it may be a transient limit hiccup
    if (res.length) { try { localStorage.setItem(lsKey, JSON.stringify(res)); } catch (e) { /* quota */ } }
    return res;
  })();
  roadsCache.set(key, p);
  p.catch(() => roadsCache.delete(key));
  return p;
}
