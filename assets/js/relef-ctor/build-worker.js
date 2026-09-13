// Build worker: собирает геометрию монетных форм (диск, подвеска, серьги)
// вне главного потока — пересборка больше не крадёт кадры у рендера и карты
// («плавность рендеринга», Арбак 18.08). Печатка и режим дорог остаются на
// главном: их пайплайны легче и реже дёргаются.
//
// Протокол:
//  in  {type:'masks', rev, px, water?, artery?, web?}  — растры городских масок
//  in  {type:'build', gen, heights:{data,w,h}, bearing, lod, form, p:{...}}
//  out {type:'built', gen, ms, vol, castCount, parts:[{pos,norm,idx,groups}]}
// Стейл-сборки отсекает main по gen; маски живут тут между сборками, высоты
// приезжают в каждом задании (в драге это сетка 240x240, копия дешёвая).
import { makeSampler, rotator } from './math.js';
import { buildDisc } from './disc.js';
import { buildPendant } from './pendant.js';
import { buildEarring } from './earring.js';
import { buildSignet } from './signet.js';

const masks = { rev: -1, px: 0, water: null, artery: null, web: null, parks: null, builds: null };

// LRU готовых ПОЛНЫХ сборок: переключение форм/размеров туда-обратно при
// неизменных высотах и масках отвечает мгновенно, без пересчёта
// («0 задержки», Арбак 20.08). Ключ несёт ревизии высот и масок; кеш
// хранит собственные копии буферов — отправка всегда клонирует их.
const built = new Map();
const BUILT_MAX = 6;
function cacheKey(m) {
  return `${m.form}|${m.lod}|${m.bearing.toFixed(4)}|${m.heightsRev}|${masks.rev}|${JSON.stringify(m.p)}`;
}
function packCopy(parts) {
  return parts.map(p => ({ pos: p.pos.slice(), norm: p.norm.slice(), idx: p.idx.slice(), groups: p.groups }));
}

// та же билинейная выборка, что в water.js samplerOf
function maskSampler(a, px) {
  if (!a) return null;
  return (u, v) => {
    const fx = Math.min(px - 1.001, Math.max(0, u * (px - 1)));
    const fy = Math.min(px - 1.001, Math.max(0, v * (px - 1)));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const i = y0 * px + x0;
    return a[i] * (1 - tx) * (1 - ty) + a[i + 1] * tx * (1 - ty)
         + a[i + px] * (1 - tx) * ty + a[i + px + 1] * tx * ty;
  };
}

function pack(g) {
  g.computeVertexNormals();
  return {
    pos: g.getAttribute('position').array,
    norm: g.getAttribute('normal').array,
    idx: g.getIndex().array,
    groups: g.groups.map(gr => ({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex })),
  };
}

onmessage = e => {
  const m = e.data;
  if (m.type === 'masks') {
    masks.rev = m.rev; masks.px = m.px;
    masks.water = m.water || null; masks.artery = m.artery || null; masks.web = m.web || null;
    masks.parks = m.parks || null;
    masks.builds = m.builds || null;
    return;
  }
  if (m.type !== 'build') return;
  const t0 = performance.now();
  // полные сборки (lod 1) отвечают из кеша мгновенно
  const key = m.lod === 1 ? cacheKey(m) : null;
  if (key && built.has(key)) {
    const hit = built.get(key);
    built.delete(key); built.set(key, hit);   // LRU-обновление
    postMessage({ type: 'built', gen: m.gen, ms: 0, vol: hit.vol, castCount: hit.castCount, parts: packCopy(hit.parts) });
    return;
  }
  const hsample = makeSampler(m.heights.data, m.heights.w, m.heights.h);
  const rot = rotator(m.bearing);
  const water = maskSampler(masks.water, masks.px);
  const roadMajor = maskSampler(masks.artery, masks.px);
  const roadWeb = maskSampler(masks.web, masks.px);
  const parks = maskSampler(masks.parks, masks.px);
  const builds = maskSampler(masks.builds, masks.px);
  const p = m.p;
  let geoms, vol, castCount;
  if (m.form === 'signet') {
    const g = buildSignet({ size: p.size, zoom: 0.6, fH: p.fH, weight: p.wk, band: p.band,
      shoulder: p.shoulder, city: false, hsample, rot, lod: m.lod });
    geoms = [g]; castCount = 1;
    vol = 0;
    const pos = g.getAttribute('position').array, ix = g.getIndex().array;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      vol += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
            - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
            + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    vol = Math.abs(vol);
  } else if (m.form === 'earrings') {
    const r = buildEarring({ wk: p.wk, closure: p.closure, fH: p.fH, basePct: p.basePct, hsample, rot, lod: m.lod });
    geoms = r.geoms; vol = r.vol * 2; castCount = r.castCount;   // пара
  } else if (m.form === 'pendant') {
    const r = buildPendant({ wk: p.wk, mount: p.mount, fH: p.fH, basePct: p.basePct, hsample, rot, lod: m.lod,
      city: p.city, close: p.close, water, roadMajor, roadWeb, parks, builds });
    geoms = r.geoms; vol = r.vol; castCount = r.castCount;
  } else {
    const g = buildDisc({ zoom: 0.55, fH: p.fH, basePct: p.basePct, zBandTop: p.zBandTop, wk: p.wk,
      hsample, rot, lod: m.lod, city: p.city, close: p.close, water, roadMajor, roadWeb, parks, builds });
    geoms = [g]; castCount = 1;
    // объём диска считает main вместе с шинкой (она строится там)
    vol = 0;
    const pos = g.getAttribute('position').array, ix = g.getIndex().array;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      vol += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
            - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
            + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    vol = Math.abs(vol);
  }
  const parts = geoms.map(pack);
  if (key) {
    built.set(key, { parts: packCopy(parts), vol, castCount });
    if (built.size > BUILT_MAX) built.delete(built.keys().next().value);
  }
  const transfers = [];
  for (const part of parts) { transfers.push(part.pos.buffer, part.norm.buffer, part.idx.buffer); }
  postMessage({ type: 'built', gen: m.gen, ms: Math.round(performance.now() - t0), vol, castCount, parts }, transfers);
};
