// Binary STL export of the current ring: the exact artifact the foundry receives.
// Units are millimeters; triangles come straight from the production geometry.
//
// The builders emit every body as its own shell (the disc is a coin plus a
// band), and the foundry expects ONE solid — the jeweler had to glue model 16
// by hand. So before writing the file the shells are boolean-united through
// manifold3d (WASM, lazy-loaded on first export). If the union fails for any
// reason the export falls back to the raw multi-shell file: a file the
// offline tool (materials/tools/stl-union.py) can still fix beats no file.

const VENDOR = new URL('../vendor/manifold/', import.meta.url);

let manifoldPromise = null;
function loadManifold() {
  if (!manifoldPromise) {
    manifoldPromise = import(new URL('manifold.js', VENDOR).href)
      .then(m => m.default({ locateFile: f => new URL(f, VENDOR).href }))
      .then(w => { w.setup(); return w; });
  }
  return manifoldPromise;
}

// Signed volume of an indexed triangle soup. Deliberately NOT meshVolume()
// from math.js: that one returns Math.abs and masks inverted shells, and the
// sign is exactly what we need here to fix winding before the boolean.
function signedVolume(pos, idx) {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
        - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
  }
  return v;
}

// bodies: [{ pos: Float32Array-like, idx: Uint32Array-like }]
function writeSTL(bodies) {
  let tris = 0;
  for (const b of bodies) tris += b.idx.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = 'rel-ef constructor export (mm)';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const { pos: p, idx: ix } of bodies) {
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
      let q = o + 12;
      for (const vi of [a, b, c]) {
        dv.setFloat32(q, p[vi], true); dv.setFloat32(q + 4, p[vi + 1], true); dv.setFloat32(q + 8, p[vi + 2], true);
        q += 12;
      }
      dv.setUint16(q, 0, true);
      o += 50;
    }
  }
  return new Blob([buf], { type: 'model/stl' });
}

function bodyOf(g) {
  return { pos: g.getAttribute('position').array, idx: g.getIndex().array };
}

// Raw export, one shell per geometry — the pre-union behavior, kept as the
// fallback and for anything that wants the bodies separate.
export function geometriesToSTL(geoms) {
  return writeSTL(geoms.map(bodyOf));
}

// Boolean-unite the shells into one closed solid. Throws when a shell is not
// a manifold (the caller falls back to the raw export).
export async function geometriesToUnionSTL(geoms) {
  const wasm = await loadManifold();
  const parts = [];
  let out = null;
  try {
    for (const g of geoms) {
      const pos = new Float32Array(g.getAttribute('position').array);
      const idx = new Uint32Array(g.getIndex().array);
      // manifold3d wants outward normals; an inverted shell would subtract
      if (signedVolume(pos, idx) < 0) {
        for (let i = 0; i < idx.length; i += 3) {
          const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
        }
      }
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: pos, triVerts: idx });
      mesh.merge();
      parts.push(new wasm.Manifold(mesh));
    }
    out = parts.length === 1 ? parts[0] : wasm.Manifold.union(parts);
    const mesh = out.getMesh();
    const body = { pos: mesh.vertProperties, idx: mesh.triVerts };
    const stats = {
      shellsIn: geoms.length,
      tris: body.idx.length / 3,
      volumeMm3: out.volume(),
      genus: out.genus(),
    };
    return { blob: writeSTL([body]), stats };
  } finally {
    for (const p of parts) { if (p !== out) try { p.delete(); } catch (e) { console.warn('manifold free', e); } }
    if (out) try { out.delete(); } catch (e) { console.warn('manifold free', e); }
  }
}

// STL for the preorder message: union preferred, raw shells if the boolean
// fails — the foundry file rides along with the order text in Telegram.
export async function stlForOrder(geoms) {
  try {
    const r = await geometriesToUnionSTL(geoms);
    return { blob: r.blob, union: true };
  } catch (err) {
    console.warn('order STL union failed, sending raw shells', err);
    return { blob: geometriesToSTL(geoms), union: false };
  }
}

// The WASM is ~600 KB and lazy: warming it up when the order form opens hides
// the load from the submit path.
export function warmupManifold() {
  loadManifold().catch(err => console.warn('manifold warmup', err));
}

export async function downloadSTL(geoms, name) {
  let blob;
  try {
    const res = await geometriesToUnionSTL(geoms);
    blob = res.blob;
    window.__relefStl = { name, union: true, ...res.stats };
  } catch (err) {
    console.warn('STL union failed, exporting raw shells', err);
    blob = geometriesToSTL(geoms);
    window.__relefStl = { name, union: false, shellsIn: geoms.length, error: String(err) };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
