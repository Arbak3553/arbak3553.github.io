// Signet v9 geometry: band widens into the face, terrain grows out of the ring.
// Faithful port of the project's reference pipeline (relf MASTER-DOC 7.6g).
import * as THREE from './three.js';   // worker-safe (see disc.js)
import { quadBez, bezYforX, smooth1d } from './math.js';

const PHI = (1 + Math.sqrt(5)) / 2;
const BAND_PROF = { flat: [0.99, 0.99, 0.01], classic: [1.0, 0.5, 0.0], 'd-shaped': [0.1, 0.1, 0.01] };
const SHOULDER_BEZ = [0.9, 0.0, 1.0, 1.0];
const BANDW_BEZ = { classic: [1.0, 0.0, 0.9, 0.9], straight: [0.5, 0.0, 1.0, 1.0], curved: [0.9, 0.0, 0.9, 0.1] };
export const WEIGHT_FACE = { subtle: 0.42, classic: 0.5, statement: 0.62 };
// classic face axial-width trim vs the reference square face (Arbak, 27.07.2026)
export const CLASSIC_TRIM = 0.85;
const BLEND_RANGE = 0.2, BLEND_POWER = 2;
const jfun = x => {
  const t = (x - (1 - BLEND_RANGE)) / BLEND_RANGE;
  return t <= 0 ? 0 : (t >= 1 ? 1 : Math.pow(t, BLEND_POWER));
};
export { PHI };

// Footprint of the sampled relief on the map, in fractions of the frame side
// (view aid for the map). Mirrors the sampling math: disc reads a circle of
// diameter zoom=0.55; the signet face bbox is normalized into zoom=0.6.
export function mapFootprint(form, weight, sizeMm) {
  if (form !== 'signet') return { kind: 'circle', d: 0.55 };   // disc and earring coin
  const R_I = sizeMm / 2, T = sizeMm * PHI ** -5, R_O = R_I + T;
  const W = PHI ** -3 * ((R_O + R_I) / 2);
  const FACE_F = WEIGHT_FACE[weight] || 0.5;
  const FACE_LEN = FACE_F * R_O;
  const halfX = weight === 'subtle' ? W : FACE_LEN * (weight === 'classic' ? CLASSIC_TRIM : 1);
  const halfZ = FACE_LEN;
  const span = Math.max(halfX, halfZ);
  return { kind: 'rect', w: halfX / span * 0.6, h: halfZ / span * 0.6 };
}

function sectionHalf(W, T, inT, edT, ouT, nOut) {
  const RESg = 0.002;
  const c = [[0.5 * RESg, 0], [W * (1 - inT), 0], [W, 0], [W, T * edT], [W, T], [W * ouT, T], [0.5 * RESg, T]];
  const dense = [];
  for (let k = 0; k < 30; k++) { const t = k / 29; dense.push([(1 - t) * c[0][0] + t * c[1][0], (1 - t) * c[0][1] + t * c[1][1]]); }
  for (let k = 1; k < 90; k++) dense.push(quadBez(c[1], c[2], c[3], k / 89));
  for (let k = 1; k < 90; k++) dense.push(quadBez(c[3], c[4], c[5], k / 89));
  for (let k = 1; k < 30; k++) { const t = k / 29; dense.push([(1 - t) * c[5][0] + t * c[6][0], (1 - t) * c[5][1] + t * c[6][1]]); }
  const lens = [0];
  for (let i = 1; i < dense.length; i++)
    lens.push(lens[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const total = lens[lens.length - 1];
  const out = []; let j = 0;
  for (let k = 0; k < nOut; k++) {
    const target = total * k / (nOut - 1);
    while (j < lens.length - 2 && lens[j + 1] < target) j++;
    const f = (target - lens[j]) / Math.max(lens[j + 1] - lens[j], 1e-12);
    out.push([dense[j][0] * (1 - f) + dense[j + 1][0] * f, dense[j][1] * (1 - f) + dense[j + 1][1] * f]);
  }
  return out;
}

// opts: { size, zoom, fH, weight, band, shoulder, city, hsample, rot, lod? }
// lod < 1 coarsens the mesh for live drags; the released view rebuilds at lod 1
export function buildSignet(opts) {
  const { size, zoom, fH, weight, band, shoulder, city, hsample, rot } = opts;
  const lod = opts.lod || 1;
  const R_I = size / 2, T = size * PHI ** -5, R_O = R_I + T;
  const W = PHI ** -3 * ((R_O + R_I) / 2);
  const FACE_F = WEIGHT_FACE[weight] || 0.5;
  const FACE_LEN = FACE_F * R_O, FACE_T = Math.atan(FACE_F);
  // product decisions (Arbak, 27.07.2026): subtle face is exactly band-wide (AX=1),
  // classic is trimmed axially vs the reference square face, statement widens
  const AX = weight === 'subtle' ? 1 : (FACE_LEN / W) * (weight === 'classic' ? CLASSIC_TRIM : 1);
  const [inT, edT, ouT] = BAND_PROF[band] || BAND_PROF.classic;
  const EDGE_H = T * edT;
  const bw = BANDW_BEZ[shoulder] || BANDW_BEZ.classic;
  const NRr = Math.max(120, Math.round(465 * lod)), NSH = Math.max(32, Math.round(117 * lod));   // x1.5: «максимально детализировано» (20.08)
  const halfS = sectionHalf(W, T, inT, edT, ouT, NSH);
  // Склейка половин профиля БЕЗ дублей на осевых точках: двойные вершины
  // давали несшитую параллель — на зеркальной полировке она бликовала
  // «горизонтальной линией»-строчкой вдоль всей шинки (поймано на макро,
  // 20.08); нулевой ширины кольцо из дублей заодно искрило пунктиром.
  const mir = halfS.slice().reverse().map(p => [-p[0], p[1]]);
  if (halfS.length && Math.abs(halfS[halfS.length - 1][0]) < 1e-6) mir.shift();
  if (halfS.length && Math.abs(halfS[0][0]) < 1e-6) mir.pop();
  const sec = halfS.concat(mir);
  const NSs = sec.length;
  const secMask = sec.map(p => p[1] > EDGE_H ? 1 : 0);

  const angles = [], isFace = [];
  for (let i = 0; i < NRr; i++) {
    const th = (0.5 + i) * 2 * Math.PI / NRr;
    angles.push(th);
    isFace.push(th <= FACE_T || th >= 2 * Math.PI - FACE_T);
  }
  const radS = new Array(NRr).fill(1), axS = new Array(NRr).fill(1);
  for (let i = 0; i < NRr; i++) {
    if (isFace[i]) {
      const t = R_O * Math.tan(angles[i]);
      radS[i] = (Math.hypot(t, R_O) - R_I) / (R_O - R_I);
      axS[i] = AX;
    }
  }
  const decay = (scales, bz) => {
    const idx = []; for (let i = 0; i < NRr / 2; i++) if (!isFace[i]) idx.push(i);
    if (!idx.length) return;
    const r0 = idx[0], r1 = idx[idx.length - 1], l = scales[r0 - 1], n = r1 - r0 + 1;
    for (let k = 0; k < n; k++) {
      const o = (k + 1) / n;
      const c = bezYforX(bz[0], bz[1], bz[2], bz[3], 1 - o) * (l - 1) + 1;
      scales[r0 + k] = c; scales[NRr - 1 - (r0 + k)] = c;
    }
  };
  decay(radS, SHOULDER_BEZ);
  decay(axS, bw);

  const verts = new Float32Array(NRr * NSs * 3);
  const hot = new Uint8Array(NRr * NSs);
  for (let i = 0; i < NRr; i++) {
    const cy = Math.cos(angles[i]), szn = Math.sin(angles[i]);
    for (let j = 0; j < NSs; j++) {
      const w = sec[j][0] * axS[i], rr = R_I + sec[j][1] * radS[i];
      const o = (i * NSs + j) * 3;
      verts[o] = w; verts[o + 1] = rr * cy; verts[o + 2] = rr * szn;
    }
  }
  const faceRows = []; for (let i = 0; i < NRr; i++) if (isFace[i]) faceRows.push(i);
  const faceCols = []; for (let j = 0; j < NSs; j++) if (secMask[j]) faceCols.push(j);
  let mnx = 1 / 0, mxx = -1 / 0, mnz = 1 / 0, mxz = -1 / 0;
  for (const i of faceRows) for (const j of faceCols) {
    const o = (i * NSs + j) * 3, X = verts[o], Z = -verts[o + 2];
    if (X < mnx) mnx = X; if (X > mxx) mxx = X; if (Z < mnz) mnz = Z; if (Z > mxz) mxz = Z;
  }
  const span = Math.max(mxx - mnx, mxz - mnz, 1e-9);
  const padx = (1 - (mxx - mnx) / span) * 0.5, padz = (1 - (mxz - mnz) / span) * 0.5;
  if (!city) {
    const rawE = new Map();
    for (const i of faceRows) for (const j of faceCols) {
      const o = (i * NSs + j) * 3;
      const u = (verts[o] - mnx) / span + padx, v = (-verts[o + 2] - mnz) / span + padz;
      const [ra, rb] = rot((u - 0.5) * zoom, (0.5 - v) * zoom);
      rawE.set(i * NSs + j, hsample(0.5 + ra, 0.5 + rb));
    }
    let emn = 1 / 0, emx = -1 / 0;
    for (const v of rawE.values()) { if (v < emn) emn = v; if (v > emx) emx = v; }
    const ern = Math.max(emx - emn, 1e-9);
    const elev = new Map();
    for (const [k, v] of rawE) elev.set(k, (v - emn) / ern * fH);
    for (const [k, e] of elev) { verts[k * 3 + 1] += e; hot[k] = 1; }
    // carry the face-edge profile down the shoulders so relief flows into the band
    const arcA = faceRows.filter(i => angles[i] <= Math.PI), arcB = faceRows.filter(i => angles[i] > Math.PI);
    const edgeA = Math.max(...arcA), edgeB = Math.min(...arcB);
    const profA = smooth1d(faceCols.map(j => elev.get(edgeA * NSs + j) || 0));
    const profB = smooth1d(faceCols.map(j => elev.get(edgeB * NSs + j) || 0));
    const shA = [], shB = [];
    for (let i = 0; i < NRr; i++) if (!isFace[i]) (angles[i] <= Math.PI ? shA : shB).push(i);
    shB.sort((a, b) => b - a);
    const carry = (rows, prof) => {
      const n = rows.length;
      for (let k = 0; k < n; k++) {
        const jf = jfun(1 - k / Math.max(n - 1, 1));
        if (jf <= 0) break;
        for (let c = 0; c < faceCols.length; c++) {
          const idx = rows[k] * NSs + faceCols[c];
          verts[idx * 3 + 1] += prof[c] * jf;
          if (jf > 0.05) hot[idx] = 1;
        }
      }
    };
    carry(shA, profA); carry(shB, profB);
  }
  // city/roads mode (Arbak, 27.07.2026): sink the face into a bezel — the recessed
  // floor carries the flush street lattice, the step at the face boundary becomes
  // the bezel wall
  const recess = city ? Math.min(1.0, T - 0.5) : 0;
  if (city) {
    for (const i of faceRows) for (const j of faceCols) verts[(i * NSs + j) * 3 + 1] -= recess;
  }

  const idxPol = [], idxRel = [];
  for (let i = 0; i < NRr; i++) {
    const i1 = (i + 1) % NRr;
    for (let j = 0; j < NSs; j++) {
      const j1 = (j + 1) % NSs;
      const A = i * NSs + j, B = i1 * NSs + j, C = i1 * NSs + j1, D = i * NSs + j1;
      ((hot[A] + hot[B] + hot[C] + hot[D]) >= 3 ? idxRel : idxPol).push(A, B, C, A, C, D);
    }
  }
  const allIdx = [...idxPol, ...idxRel];
  // enforce outward winding (signed volume must be positive)
  let svol = 0;
  for (let t = 0; t < allIdx.length; t += 3) {
    const a = allIdx[t] * 3, b = allIdx[t + 1] * 3, c = allIdx[t + 2] * 3;
    svol += (verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
           - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
           + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]));
  }
  if (svol < 0) {
    for (let t = 0; t < allIdx.length; t += 3) {
      const tmp = allIdx[t + 1]; allIdx[t + 1] = allIdx[t + 2]; allIdx[t + 2] = tmp;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(allIdx);
  g.addGroup(0, idxPol.length, 0);
  g.addGroup(idxPol.length, idxRel.length, 1);
  // ring frame (x=width, y=up, z=ring) -> Z-up build space: (X=z, Y=x, Z=y)
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  g.computeVertexNormals();
  g.userData.face = { mnx, span, padx, mnz, padz, R_O, recess };
  return g;
}
