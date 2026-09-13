// Кеш ответов городских слоёв в localStorage: зеркала Overpass троттлят
// повторные тяжёлые запросы (429/504 пачками — поймано 18.08), а кеш в Map
// умирает с вкладкой. Элементы ужимаются до полей, которые читают
// lineMask/webMask, координаты — до 1e-5 (~1 м): полный ответ Москвы в сыром
// виде не влезает в квоту.
const LS_PREF = 'relefCity:';
const LS_MAX = 8;
const LS_TTL = 7 * 864e5;

export function slim(els) {
  return els.map(e => {
    const s = { type: e.type, id: e.id };
    if (e.members) s.members = e.members.map(m => ({ type: m.type, ref: m.ref, role: m.role }));
    if (e.geometry) s.geometry = e.geometry.map(g => ({
      lat: Math.round(g.lat * 1e5) / 1e5, lon: Math.round(g.lon * 1e5) / 1e5 }));
    if (e.tags) {
      const t = {};
      for (const k of ['waterway', 'natural', 'water', 'highway', 'railway', 'leisure', 'landuse']) if (e.tags[k]) t[k] = e.tags[k];
      if (Object.keys(t).length) s.tags = t;
    }
    return s;
  });
}

// gzip поверх localStorage: полная уличная сеть миллионника (~3 МБ JSON)
// не влезала в квоту и НЕ переживала перезагрузку — город каждый раз ждал
// сеть («очень сильно медленно грузится», 20.08). Гео-JSON жмётся в 6-10
// раз; префикс значения различает сырой и сжатый форматы.
const b64 = buf => {
  const u = new Uint8Array(buf);
  let s2 = '';
  for (let i = 0; i < u.length; i += 0x8000) s2 += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s2);
};
const unb64 = str => {
  const bin = atob(str);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
async function gzip(str) {
  const cs = new CompressionStream('gzip');
  const blob = new Blob([new TextEncoder().encode(str)]);
  return b64(await new Response(blob.stream().pipeThrough(cs)).arrayBuffer());
}
async function gunzip(b) {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([unb64(b)]);
  return await new Response(blob.stream().pipeThrough(ds)).text();
}

export async function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREF + key);
    if (!raw) return null;
    const body = raw.startsWith('z:') ? await gunzip(raw.slice(2)) : raw;
    const { t, els } = JSON.parse(body);
    return Date.now() - t > LS_TTL ? null : els;
  } catch (err) { return null; }
}

export async function lsPut(key, els) {
  let body = JSON.stringify({ t: Date.now(), els });
  try { body = 'z:' + await gzip(body); } catch (err) { /* нет CompressionStream — сырым */ }
  // после сжатия страховка от совсем безразмерного
  if (body.length > 3000000) return;
  const put = () => localStorage.setItem(LS_PREF + key, body);
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREF)) keys.push(k);
    }
    keys.sort((a, b) => {
      try { return JSON.parse(localStorage.getItem(a)).t - JSON.parse(localStorage.getItem(b)).t; }
      catch (err) { return 0; }
    });
    while (keys.length >= LS_MAX) localStorage.removeItem(keys.shift());
    try { put(); }
    catch (err) {                     // квота: выселяем старейших и пробуем ещё раз
      while (keys.length) {
        localStorage.removeItem(keys.shift());
        try { put(); return; } catch (err2) { /* всё ещё тесно */ }
      }
    }
  } catch (err) { /* приватный режим — живём без кеша */ }
}
