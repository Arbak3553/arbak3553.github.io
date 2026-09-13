// Pendant: the terrain coin sewn into the necklace — two cast side loops on
// the rim (10 and 2 o'clock), the paperclip chain is bought fitting shown for
// preview only. Built in "pendant space" (coin facing the camera, chain up)
// and rotated into the stage's build space at the end.
import * as THREE from './three.js';   // worker-safe (see disc.js)
import { buildDisc, discEmbed } from './disc.js';
import { meshVolume } from './math.js';

// coin sizes per model weight: a notch above the earring coins (12/14/17mm)
// Диаметры 12 / 14 / 16 мм. L был 17 (R 8.5) и расходился с лестницей цен, где
// 10 900 посчитаны на Ø16 — расхождение висело с 05.08. Решение 14.08: ужимаем
// геометрию, а не поднимаем цену. Лестница выведена из юнит-экономики, 17 мм были
// просто константой; металла разница ~13%, а кулон — входной SKU, ему дешевле
// полезнее. Менять безопасно: заказов ноль, воспроизводить по share-ссылкам нечего.
export const PEND_W = {
  subtle:    { R: 6.0, T: 1.1 },
  classic:   { R: 7.0, T: 1.25 },
  statement: { R: 8.0, T: 1.4 },
};

const LOOP_ANG = 55 * Math.PI / 180;    // side loops at 10 and 2 o'clock
const CHAIN_ANG = 36 * Math.PI / 180;   // sewn-in chain rises steeper than the loops
const BAIL_ANG = 34 * Math.PI / 180;    // bail chain rises in a sharp V
const LOOP_HOLE = 0.8, LOOP_WIRE = 0.35;
const LINK_LEN = 3.1, LINK_W = 1.2, LINK_WIRE = 0.26, LINK_LAP = 0.7;
const N_LINKS = 13;

// cast tab loop on the coin rim, flat in the coin plane (same language as the
// earring's loop) — the chain link threads through it and closes with a jump ring
function sideLoop(R, T, ang) {
  const g = new THREE.TorusGeometry(LOOP_HOLE, LOOP_WIRE, 20, 56);
  g.translate(0, R + 0.55, T / 2);
  g.rotateZ(-ang);
  return g;
}

// single cast bail at 12 o'clock, standing perpendicular to the coin: it
// threads the JOINT where the two end links of the chain interlock
function bailLoop(R, T) {
  const g = new THREE.TorusGeometry(1.0, 0.38, 20, 56);
  g.rotateY(Math.PI / 2);
  g.translate(0, R + 0.85, T / 2);
  return g;
}

// one paperclip link: a stadium contour swept with round wire, long axis = x
function chainLink() {
  const s = (LINK_LEN - LINK_W) / 2, r = LINK_W / 2;
  const pts = [];
  const N = 12;   // points per semicircle, endpoints excluded (closed curve)
  for (let i = 0; i < N; i++) {
    const a = -Math.PI / 2 + Math.PI * i / (N - 1);
    pts.push(new THREE.Vector3(s + r * Math.cos(a), r * Math.sin(a), 0));
  }
  for (let i = 0; i < N; i++) {
    const a = Math.PI / 2 + Math.PI * i / (N - 1);
    pts.push(new THREE.Vector3(-s + r * Math.cos(a), r * Math.sin(a), 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  return new THREE.TubeGeometry(curve, 80, LINK_WIRE, 14, true);
}

// preview chain strand from an origin point up along the neckline; links
// alternate 90 degrees around their long axis like a real paperclip chain
function chainStrand(x0, y0, T, side, d0, phase = 0, ang = CHAIN_ANG) {
  const dx = side * Math.sin(ang), dy = Math.cos(ang);
  const az = Math.atan2(dy, dx);
  const step = LINK_LEN - LINK_LAP;
  const links = [];
  for (let i = 0; i < N_LINKS; i++) {
    const g = chainLink();
    if ((i + phase) % 2) g.rotateX(Math.PI / 2);
    g.rotateZ(az);
    const d = d0 + LINK_LEN / 2 + step * i;
    g.translate(x0 + dx * d, y0 + dy * d, T / 2);
    links.push(g);
  }
  return links;
}

// opts: { wk, mount, fH, basePct, hsample, rot } -> { geoms, vol, castCount }
// mount 'two': sewn into the chain via two side loops; 'one': single top bail.
// The first castCount geoms are the CASTABLE part (coin + loops); the chain
// is bought fitting shown for preview only, attached at assembly.
export function buildPendant(opts) {
  const { wk, mount, fH, basePct, hsample, rot, lod } = opts;
  const dims = PEND_W[wk] || PEND_W.classic;
  // zBandTop chosen so the coin bottom sits at z=0 (same trick as the earring)
  const coin = buildDisc({ zoom: 0.55, fH: fH * 0.85, basePct, zBandTop: discEmbed(wk), wk, hsample, rot, dims, lod, city: opts.city, close: opts.close, water: opts.water, roadMajor: opts.roadMajor, roadWeb: opts.roadWeb, parks: opts.parks, builds: opts.builds });
  const parts = [coin];
  if (mount === 'one') parts.push(bailLoop(dims.R, dims.T));
  else parts.push(sideLoop(dims.R, dims.T, LOOP_ANG), sideLoop(dims.R, dims.T, -LOOP_ANG));
  const castCount = parts.length;
  let vol = 0;
  for (const g of parts) vol += meshVolume(g);
  if (mount === 'one') {
    // the chain's two end links interlock right inside the bail — the joint
    // between them IS the lowest point, exactly where the bail grabs
    const y0 = dims.R + 0.85;
    parts.push(...chainStrand(0, y0, dims.T, 1, -0.5, 0, BAIL_ANG));
    parts.push(...chainStrand(0, y0, dims.T, -1, -0.5, 1, BAIL_ANG));
  } else {
    for (const s of [1, -1]) {
      const x0 = s * Math.sin(LOOP_ANG) * (dims.R + 0.55);
      const y0 = Math.cos(LOOP_ANG) * (dims.R + 0.55);
      // first link edge-on: it visibly threads THROUGH the flat side loop
      parts.push(...chainStrand(x0, y0, dims.T, s, LOOP_HOLE - LINK_LAP / 2, 1));
    }
  }
  // pendant space -> stage build space: coin faces the camera, chain up
  for (const g of parts) g.rotateX(Math.PI / 2);
  return { geoms: parts, vol, castCount };
}
