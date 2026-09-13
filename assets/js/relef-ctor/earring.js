// Earring: the terrain coin (same pipeline as the disc ring) plus a selectable
// fastening — stud pin, leverback loop or a french hook. Built in "earring
// space" (coin facing the camera, fastening on top) and rotated into the
// stage's build space at the end. Weight is per PAIR, handled by the caller.
import * as THREE from './three.js';   // worker-safe (see disc.js)
import { buildDisc, discEmbed } from './disc.js';
import { meshVolume } from './math.js';

// coin sizes per model weight: catalog language (studs 10mm, discs 12mm, statement 14mm)
export const EAR_W = {
  subtle:    { R: 5.0, T: 1.0 },
  classic:   { R: 6.0, T: 1.2 },
  statement: { R: 7.0, T: 1.4 },
};

const WIRE = 0.42;   // fastening wire radius, mm (>=0.8mm casting wall)

// cast loop on the coin rim: the only thing the foundry needs for a hanging
// fastening — the bought fitting threads through it and gets soldered
function earLoop(R, T) {
  // Минимальная стенка 0.8 мм (инвариант MASTER-DOC §8) — ушко держит всю серьгу,
  // недолив здесь означает, что изделие отваливается с уха. Радиус трубки жёстко
  // стоял 0.35 (0.70 мм) мимо объявленного WIRE, а 14 сегментов срезали ещё:
  // вписанный 14-угольник даёт 0.35·cos(π/14)·2 = 0.682 мм. Поймано замером STL.
  // Сегментов 24: 0.42·cos(π/24)·2 = 0.836 мм, запас к инварианту сохраняется.
  const ring = new THREE.TorusGeometry(0.85, WIRE, 32, 56);
  ring.translate(0, R + 0.65, T / 2);
  return ring;
}

function studPin() {
  // pin backwards from the coin center + a small welding pad + butterfly back
  const pin = new THREE.CylinderGeometry(0.45, 0.45, 9, 24);
  pin.rotateX(Math.PI / 2);            // axis -> z
  pin.translate(0, 0, -4.5);
  const pad = new THREE.CylinderGeometry(1.5, 1.5, 0.6, 32);
  pad.rotateX(Math.PI / 2);
  pad.translate(0, 0, -0.3);
  return [pin, pad, ...butterflyBack(-5.6)];
}

// bought friction clutch on the pin: central tube + two curled wings
function butterflyBack(z) {
  const tube = new THREE.CylinderGeometry(0.62, 0.62, 1.4, 20);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, 0, z);
  const parts = [tube];
  for (const s of [1, -1]) {
    const wing = new THREE.TorusGeometry(0.85, 0.22, 16, 44);
    wing.rotateY(Math.PI / 2);
    wing.rotateZ(s * 0.35);
    wing.translate(s * 0.95, 0, z);
    parts.push(wing);
  }
  return parts;
}

function bandSweep(curve, width, thick, steps) {
  // flat metal band swept along a closed planar curve (x = band width axis)
  const pos = [], idx = [];
  const X = new THREE.Vector3(1, 0, 0);
  const n = new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    n.crossVectors(tan, X).normalize();
    for (const [sx, sn] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(p.x + sx * width / 2, p.y + n.y * sn * thick / 2, p.z + n.z * sn * thick / 2);
    }
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 4, b = ((i + 1) % steps) * 4;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      idx.push(a + k, b + k, b + k1, a + k, b + k1, a + k1);
    }
  }
  // enforce outward winding via signed volume
  let sv = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    sv += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
        - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (sv < 0) for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function leverbackLoop(R) {
  // one smooth flat band closed into the leverback contour, leaning back,
  // plus the hinge pin; the bottom of the band threads through the cast loop
  const B = R + 0.6;
  const pts = [
    new THREE.Vector3(0, B + 0.3, 0.75),
    new THREE.Vector3(0, B + 3.6, 1.15),
    new THREE.Vector3(0, B + 6.6, 0.85),
    new THREE.Vector3(0, B + 8.1, -0.5),
    new THREE.Vector3(0, B + 6.3, -1.9),
    new THREE.Vector3(0, B + 2.9, -2.35),
    new THREE.Vector3(0, B + 0.6, -1.5),
    new THREE.Vector3(0, B + 0.0, -0.3),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, true);
  const band = bandSweep(curve, 1.25, 0.5, 128);
  const hinge = new THREE.CylinderGeometry(0.42, 0.42, 1.9, 16);
  hinge.rotateZ(Math.PI / 2);
  hinge.translate(0, B + 0.7, -1.6);
  return [band, hinge];
}

function frenchHook(R) {
  // an elegant french hook: thin wire rising from the loop into a high smooth
  // arc over the ear, tail flowing out with a small decorative ball end
  const pts = [
    new THREE.Vector3(0, R + 0.15, 0.55),
    new THREE.Vector3(0, R + 2.8, 0.85),
    new THREE.Vector3(0, R + 5.2, 0.35),
    new THREE.Vector3(0, R + 6.4, -1.4),
    new THREE.Vector3(0, R + 5.6, -3.3),
    new THREE.Vector3(0, R + 3.6, -4.5),
    new THREE.Vector3(0, R + 1.8, -5.0),
    new THREE.Vector3(0, R + 0.6, -5.8),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = new THREE.TubeGeometry(curve, 96, 0.34, 16, false);
  const cap0 = new THREE.SphereGeometry(0.34, 12, 8); cap0.translate(0, R + 0.15, 0.55);
  const ball = new THREE.SphereGeometry(0.5, 14, 10); ball.translate(0, R + 0.6, -5.8);
  return [tube, cap0, ball];
}

// opts: { wk, closure, fH, basePct, hsample, rot } -> { geoms, vol, castCount }
// (ONE earring). The first castCount geoms are the CASTABLE part (coin + loop);
// the rest is bought fitting shown for preview only, soldered in production.
export function buildEarring(opts) {
  const { wk, closure, fH, basePct, hsample, rot, lod } = opts;
  const dims = EAR_W[wk] || EAR_W.classic;
  // zBandTop chosen so the coin bottom sits at z=0 (no ring band underneath)
  const coin = buildDisc({ zoom: 0.55, fH: fH * 0.8, basePct, zBandTop: discEmbed(wk), wk, hsample, rot, dims, lod });
  const parts = [coin];
  let castCount = 1;
  if (closure === 'stud') {
    parts.push(...studPin());          // pin is soldered to the coin back, no loop
  } else {
    parts.push(earLoop(dims.R, dims.T));
    castCount = 2;
    if (closure === 'hook') parts.push(...frenchHook(dims.R));
    else parts.push(...leverbackLoop(dims.R));
  }
  let vol = 0;
  for (const g of parts) vol += meshVolume(g);
  // earring space -> stage build space: coin faces the camera, fastening up
  for (const g of parts) g.rotateX(Math.PI / 2);
  return { geoms: parts, vol, castCount };
}
