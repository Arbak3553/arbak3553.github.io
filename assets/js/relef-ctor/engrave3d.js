// Engraving preview: the text rendered onto the piece itself — a strip on the
// inner band surface for rings, the coin back for earrings. Preview-only
// meshes (marked skipExport): real engraving is done after casting.
import * as THREE from 'three';

function textTexture(text, w, h, basePx, mirror) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (mirror) { c.translate(w, 0); c.scale(-1, 1); }
  let px = basePx;
  c.font = `600 ${px}px Inter, sans-serif`;
  while (px > 18 && c.measureText(text).width > w * 0.92) {
    px -= 4;
    c.font = `600 ${px}px Inter, sans-serif`;
  }
  c.fillStyle = '#3a3a3a';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

// Strip on the inner band surface (bore axis = build-space Y), arc centered at
// the bottom of the ring, mirrored because it is viewed from inside the bore.
export function ringEngraveMesh(text, innerR, bandW) {
  // narrow arc so the text stays inside the visible bottom of the band
  const arc = Math.PI * 0.48;
  const g = new THREE.CylinderGeometry(innerR, innerR, bandW, 96, 1, true, Math.PI - arc / 2, arc);
  const h = Math.max(64, Math.round(1024 * bandW / (innerR * arc)));
  const tex = textTexture(text, 1024, h, Math.round(h * 0.62), true);
  // DoubleSide so the strip never vanishes; mirrored so it reads correctly
  // when looking into the bore from the camera side
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  return new THREE.Mesh(g, m);
}

// Flat text on the earring coin back (earring space: the back faces -z at z=0).
export function coinEngraveMesh(text, R) {
  const g = new THREE.CircleGeometry(R * 0.82, 48);
  g.rotateY(Math.PI);
  g.translate(0, 0, -0.03);
  const tex = textTexture(text, 512, 512, 46, false);
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  return new THREE.Mesh(g, m);
}
