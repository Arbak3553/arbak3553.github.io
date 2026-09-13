// Вода из OSM для городского режима.
//
// Зачем режим вообще: высотами город не делается. Замер по тайлам — у Эльбруса
// 0% плоских пикселей, у Москвы 1,8%, перепад в городе десятки метров против
// двух километров у горы. Движок нормирует рельеф на полный бюджет высоты и
// потому УСИЛИВАЕТ шум до масштаба гор. Сверху узнаётся не высота, а вода:
// излучина реки и сетка каналов — это то, как мы знаем города по картам.
//
// Overpass дёргается ИЗ БРАУЗЕРА: терминальные запросы туда режутся по 406
// (MASTER-DOC §7.6h). Российское зеркало первым — overpass-api.de из РФ часто
// недоступен, и висящий первый эндпоинт съедал весь бюджет ожидания.
import { slim, lsGet, lsPut } from './citycache.js';

const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Растр маски. 1024: пиксель ~0.027 мм изделия — тоньше городской ячейки
// меша втрое, дальше растить бессмысленно: 1536 лишь добавлял 25-50 мс
// на слой при чтении растра (замерено 20.08), детализацию даёт МЕШ.
export const MASK_PX = 1024;

/** Минимальный штрих, мм. Тоньше не прольётся и не будет виден.
 *  На окне 6 км это ~214 м — почти точная ширина Москвы-реки, поэтому
 *  на рабочих окнах генерализация получается близкой к натуре. */
export const MIN_STROKE_MM = 0.5;

const cache = new Map();

export function bboxOf(lat, lon, windowM) {
  const d = windowM / 2 / 111320;
  const dLon = d / Math.cos(lat * Math.PI / 180);
  return [lat - d, lon - dLon, lat + d, lon + dLon].join(',');
}

// Гонка зеркал ПАРАЛЛЕЛЬНО, первый здоровый ответ побеждает. Последовательный
// обход (как было) складывал таймауты: висящее первое зеркало съедало 30-40 с
// до того, как второе вообще пробовалось — ровно те «30 секунд до карты на
// кольце» (Арбак 19.08). Пустой ответ с remark = лимит зеркала под HTTP 200.
export async function ask(query, tmoMs = 27000) {
  const attempt = async url => {
    const r = await fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(tmoMs),
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (!j || !j.elements) throw new Error('bad payload');
    if (!j.elements.length && j.remark) throw new Error('mirror limit');
    return j.elements;
  };
  try { return await Promise.any(ENDPOINTS.map(attempt)); }
  catch (err) { return null; }       // null = не дозвонились, ≠ пустой ответ
}

// Квантование ключа кеша + запас площади. Ключ по сырым координатам делал
// НОВЫЙ сетевой запрос на каждый сдвиг рамки в ~110 м; теперь центр
// квантуется шагом 0.15 окна, bbox считается ОТ ЦЕНТРА ЯЧЕЙКИ с запасом
// x1.25 (актуальный центр отстоит от ячеечного максимум на полшага 0.075,
// покрытие гарантировано с полем) — любой центр внутри ячейки покрыт,
// микро-подгонка рамки в сеть не ходит, а повторный запрос ячейки байт в
// байт совпадает с прошлым и greб зеркальным кешем. lineMask/webMask
// проецируют элементы по АБСОЛЮТНЫМ координатам текущего центра, поэтому
// переиспользование ничего не смещает.
export const PAD = 1.25;
export function quantSpec(lat, lon, windowM) {
  const stepLat = windowM * 0.15 / 111320;
  const stepLon = stepLat / Math.cos(lat * Math.PI / 180);
  const iy = Math.round(lat / stepLat), ix = Math.round(lon / stepLon);
  return { key: `${iy}/${ix}/${Math.round(windowM)}`, qlat: iy * stepLat, qlon: ix * stepLon };
}
function quantKey(lat, lon, windowM) { return quantSpec(lat, lon, windowM).key; }

/** Оба городских слоя уже в кеше (Map или localStorage)? Тогда загрузка
 *  мгновенная и вежливый стаггер зеркал не нужен — main перезапрашивает
 *  всё разом одной пересборкой. */
export function cityCached(lat, lon, windowM) {
  const suf = quantKey(lat, lon, windowM);
  // наличие ЗАПИСИ (без распаковки): решение о горячем пути синхронное
  const hasLs = k => { try { return !!localStorage.getItem('relefCity:' + k); } catch (err) { return false; } };
  const has = k => cache.has(k) || hasLs(k);
  return has(`w:${suf}`) && has(`a:${suf}`);
}

/** Русла и каналы в окне. Пруды (natural=water) НЕ берём: на городском окне
 *  они дают сотни пятен и превращают маску в кашу — проверено на Москве. */
export async function fetchWater(lat, lon, windowM) {
  const q = quantSpec(lat, lon, windowM);
  const key = `w:${q.key}`;
  if (cache.has(key)) return cache.get(key);
  const stored = await lsGet(key);
  if (stored) { const p = Promise.resolve(stored); cache.set(key, p); return p; }
  const bbox = bboxOf(q.qlat, q.qlon, windowM * PAD);
  // Реляции воды НЕЛЬЗЯ запрашивать через `out geom` напрямую: «Москва-река» —
  // одна реляция на сотни километров, ответ с геометрией ВСЕХ участников зеркало
  // не отдаёт (поймано: вода пропадала при живых кольцах). Поэтому скелет реляций
  // (роли + ссылки) отдельно, а геометрия участников — обрезанная по bbox;
  // склейка колец по id на клиенте в waterMask.
  const p = ask(`[out:json][timeout:25];`
    + `(way["waterway"~"^(river|canal)$"](${bbox});`
    + `way["natural"="water"]["water"~"^(river|canal|lake)$"](${bbox}););`
    + `out geom 3000;`
    + `relation["natural"="water"]["water"~"^(river|canal|lake)$"](${bbox})->.r;`
    + `.r out body;`
    + `way(r.r)(${bbox});out geom 2000;`)
    .then(els => {
      if (!els) { cache.delete(key); return els; }   // неудачу не кешируем
      const s = slim(els);
      lsPut(key, s);
      return s;
    });
  cache.set(key, p);
  return p;
}



/** Проекция абсолютных координат в пиксели маски ТЕКУЩЕГО окна. Элементы
 *  кешируются ячейками с запасом площади и переиспользуются при сдвигах —
 *  проекция по текущему центру гарантирует, что линии никогда не смещаются. */
export function projector(lat, lon, windowM) {
  const R = 6378137;
  const merc = (la, lo) => [
    R * lo * Math.PI / 180,
    R * Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)),
  ];
  const [cx, cy] = merc(lat, lon);
  const half = windowM / Math.cos(lat * Math.PI / 180) / 2;
  return (la, lo) => {
    const [x, y] = merc(la, lo);
    return [(x - cx) / (2 * half) * MASK_PX + MASK_PX / 2,
            MASK_PX / 2 - (y - cy) / (2 * half) * MASK_PX];
  };
}

/** Общий растеризатор линий -> сэмплер mask(u,v) в 0..1, в тех же u,v, что и
 *  высоты. strokeMm задаёт ширину рисования: реальная ширина русла/дороги на
 *  изделии почти всегда тоньше литейного предела, поэтому линия идёт
 *  фиксированным штрихом. */
function lineMask(elements, lat, lon, windowM, { zoom, discMm, strokeMm, blur = 1 }) {
  if (!elements || !elements.length) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = MASK_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MASK_PX, MASK_PX);
  const toPx = projector(lat, lon, windowM);

  // Ширина штриха в пикселях маски: диаметр изделия покрывает zoom-долю окна,
  // поэтому она не зависит от размера окна — только от изделия и растра.
  const strokePx = MASK_PX * strokeMm * zoom / discMm;

  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = strokePx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const trace = pts => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  };
  // Крупные реки (Нева, Москва-река) — мультиполигоны: русло описано РЕЛЯЦИЕЙ
  // из кусков берега. Скелет реляции несёт роли и ссылки, геометрия кусков
  // приезжает отдельными путями, обрезанными по bbox. Склеиваем внешние куски
  // по совпадающим концам; замкнувшиеся кольца заливаем — река получает
  // НАСТОЯЩУЮ ширину, а не штрих по осевой. Оборванное рамкой не заливаем.
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
    if (e.type === 'relation' && e.members) {
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
        if (ring.length > 3 && eq(ring[0], ring[ring.length - 1])) {
          trace(ring.map(([la, lo]) => toPx(la, lo)));
          ctx.closePath(); ctx.fill();
        }
      }
    }
  }
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
    // берега из реляций не штрихуем сами по себе: их дело — замыкать заливку;
    // одиночный кусок берега толстой линией рисовал бы ложную «вторую реку»
    if (memberIds.has(e.id) && !(e.tags && (e.tags.waterway || e.tags.natural))) continue;
    trace(e.geometry.map(g => toPx(g.lat, g.lon)));
    if (e.tags && e.tags._hole) {           // остров: тайловые полигоны несут дырки
      ctx.fillStyle = '#000';
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff';
      continue;
    }
    if (e.tags && e.tags.natural === 'water') { ctx.closePath(); ctx.fill(); }
    ctx.stroke();
  }

  return samplerOf(ctx, blur);
}

/** Канва -> сэмплер: размытие (фаски канавки — вертикальная стенка плохо
 *  проливается и скалывается) + билинейная выборка (ближайший сосед давал
 *  рваные края линий и лишние микрограни в STL).
 *  Размытие — GPU-фильтром канвы: JS-циклы по 1М флоатов жгли ~80 мс на
 *  каждую пересборку масок («сильно лагает», 18.08); blur(N px) той же
 *  ширины стоит миллисекунды. Fallback на JS остаётся для канв без filter. */
export function samplerOf(ctx, blurPasses) {
  if (blurPasses > 0 && typeof ctx.filter === 'string') {
    const cv2 = document.createElement('canvas');
    cv2.width = cv2.height = MASK_PX;
    const c2 = cv2.getContext('2d', { willReadFrequently: true });
    c2.fillStyle = '#000'; c2.fillRect(0, 0, MASK_PX, MASK_PX);
    // сигма бокс-размытия из N проходов радиуса 1 ~ sqrt(2N/3) px
    c2.filter = `blur(${Math.sqrt(2 * blurPasses / 3).toFixed(2)}px)`;
    c2.drawImage(ctx.canvas, 0, 0);
    ctx = c2; blurPasses = 0;
  }
  const px = ctx.getImageData(0, 0, MASK_PX, MASK_PX).data;
  const a = new Float32Array(MASK_PX * MASK_PX);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4] / 255;
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < blurPasses; pass++) {
    for (let y = 0; y < MASK_PX; y++) for (let x = 0; x < MASK_PX; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(MASK_PX - 1, x + 1);
      b[y * MASK_PX + x] = (a[y * MASK_PX + x0] + a[y * MASK_PX + x] + a[y * MASK_PX + x1]) / 3;
    }
    for (let x = 0; x < MASK_PX; x++) for (let y = 0; y < MASK_PX; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(MASK_PX - 1, y + 1);
      a[y * MASK_PX + x] = (b[y0 * MASK_PX + x] + b[y * MASK_PX + x] + b[y1 * MASK_PX + x]) / 3;
    }
  }
  const fn = (u, v) => {
    const fx = Math.min(MASK_PX - 1.001, Math.max(0, u * (MASK_PX - 1)));
    const fy = Math.min(MASK_PX - 1.001, Math.max(0, v * (MASK_PX - 1)));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const i = y0 * MASK_PX + x0;
    return a[i] * (1 - tx) * (1 - ty) + a[i + 1] * tx * (1 - ty)
         + a[i + MASK_PX] * (1 - tx) * ty + a[i + MASK_PX + 1] * tx * ty;
  };
  // сырой растр наружу: build-worker сэмплит маску у себя, замыкание туда не передать
  fn.data = a; fn.px = MASK_PX;
  return fn;
}

/** Вода: полный литейный штрих. Фаска двойная — канавка 0.5 мм самая глубокая,
 *  вертикальную стенку такой высоты литьё не прольёт. */
export function waterMask(elements, lat, lon, windowM, opts) {
  return lineMask(elements, lat, lon, windowM, { ...opts, strokeMm: MIN_STROKE_MM, blur: 2 });
}

/** Артерии: кольца и главные радиусы. route=road РЕЛЯЦИИ + motorway|trunk.
 *  Садовое кольцо в OSM — 15 улиц с разными именами, его собирает ТОЛЬКО
 *  реляция (2094267); в центре Москвы trunk/motorway ноль (замер 17.08).
 *  Это КАРКАС рисунка — он остаётся на любом масштабе, в отличие от паутины. */
export async function fetchArteries(lat, lon, windowM) {
  const q = quantSpec(lat, lon, windowM);
  const key = `a:${q.key}`;
  if (cache.has(key)) return cache.get(key);
  const stored = await lsGet(key);
  if (stored) { const p = Promise.resolve(stored); cache.set(key, p); return p; }
  const bbox = bboxOf(q.qlat, q.qlon, windowM * PAD);
  const p = ask(`[out:json][timeout:25];`
    + `way["highway"~"^(motorway|trunk)$"](${bbox})->.a;`
    + `relation["type"="route"]["route"="road"](${bbox});`
    + `way(r)(${bbox})->.b;`
    + `(.a; .b;);out geom 4000;`)
    .then(els => {
      if (!els) { cache.delete(key); return els; }   // неудачу не кешируем
      const s = slim(els);
      lsPut(key, s);
      return s;
    });
  cache.set(key, p);
  return p;
}

export const ARTERY_STROKE_MM = 0.30;
export function arteryMask(elements, lat, lon, windowM, opts) {
  // адаптив: на близких окнах магистраль своей реальной ширины (~34 м)
  const real = 34 * opts.discMm / (0.55 * windowM);
  const strokeMm = Math.max(ARTERY_STROKE_MM, real);
  // канавка мелкая — хватает одного прохода фаски, линия остаётся резкой
  return lineMask(elements, lat, lon, windowM, { ...opts, strokeMm, blur: 1 });
}

/** Дорожные маски из путей fetchRoads (roads.js). Тот загрузчик уже гоняет
 *  зеркала наперегонки, кеширует в localStorage и режет сеть по тирам, а пути
 *  отдаёт В ДОЛЯХ РАМКИ — это то же пространство, в котором сэмплится карта
 *  высот, никакой проекции не нужно. Два слоя с разным языком линий:
 *  major (magistrali) — читаемая линия, web (secondary/tertiary) — тонкая
 *  гравировка-паутина. residential сюда не попадает: fetchRoads ниже z13 сам
 *  режет тир до medium — на городском окне это спасает от каши. */
/** Полная уличная сеть для паутины. Раньше её тянул roads.js: пути в ДОЛЯХ
 *  РАМКИ запроса — переиспользовать со сдвигом нельзя, ключ шагал по 110 м,
 *  и каждый сдвиг рамки гнал самый тяжёлый запрос заново (7.6 с в замере,
 *  «нужно live», Арбак 19.08). Теперь паутина ездит тем же конвейером, что
 *  вода и артерии: абсолютные координаты, квантованная ячейка с запасом
 *  x1.4, параллельная гонка зеркал, localStorage. */
export async function fetchWebStreets(lat, lon, windowM) {
  const q = quantSpec(lat, lon, windowM);
  const key = `s:${q.key}`;
  if (cache.has(key)) return cache.get(key);
  const stored = await lsGet(key);
  if (stored) { const p = Promise.resolve(stored); cache.set(key, p); return p; }
  const bbox = bboxOf(q.qlat, q.qlon, windowM * PAD);
  const p = ask(`[out:json][timeout:30];`
    + `(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)"](${bbox});`
    + `way["railway"="rail"]["service"!~"."](${bbox}););`
    + `out geom 16000;`, 32000)
    .then(async els => {
      if (els) { const s = slim(els); lsPut(key, s); return s; }
      // Полный запрос завален (плотнейшие города — Питер — зеркала режут по
      // размеру): деградация до каркаса без жилых. Сессионно, в localStorage
      // НЕ пишем — при следующем визите снова попробуем полный.
      const lite = await ask(`[out:json][timeout:25];`
        + `way["highway"~"^(motorway|trunk|primary|secondary|tertiary)"](${bbox});`
        + `out geom 8000;`);
      if (!lite) { cache.delete(key); return null; }   // неудачу не кешируем
      return slim(lite);
    });
  cache.set(key, p);
  return p;
}

// Паутина: иерархия в ширине штриха, глубина одна. МАСШТАБНО-АДАПТИВНО
// («сверх детали, чтобы карта чётко выбивалась», 21.08): на близких окнах
// улица рисуется своей РЕАЛЬНОЙ шириной (Тверская на окне 1.5 км — это
// 0.45 мм металла), минимальный штрих работает только как литейный пол.
// Дворовые проезды и аллеи (lane) включаются на самых близких окнах.
// Железная дорога — пунктир «шпалами».
export const WEB_STROKE_MM = 0.16;             // литейный пол mid-класса
const WEB_MIN_MM = { major: 0.20, mid: 0.16, minor: 0.11, lane: 0.09, rail: 0.13 };
const WEB_REAL_M = { major: 30, mid: 18, minor: 11, lane: 6, rail: 6 };
const WEB_CLS = e => {
  if (e.tags && e.tags.railway) return 'rail';
  const hw = (e.tags && e.tags.highway) || '';
  if (/^(motorway|trunk|primary)/.test(hw)) return 'major';
  if (/^(secondary|tertiary)/.test(hw)) return 'mid';
  if (hw === 'service' || hw === 'path' || hw === 'track') return 'lane';
  return 'minor';
};
export function webMask(elements, lat, lon, windowM, { zoom, discMm }) {
  if (!elements || !elements.length) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = MASK_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, MASK_PX, MASK_PX);
  ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const toPx = projector(lat, lon, windowM);
  const mmPx = MASK_PX * zoom / discMm;          // пикселей маски на мм изделия
  const mmPerM = discMm / (0.55 * windowM);      // мм изделия на метр города
  const laneOn = windowM <= 2400 * discMm / 15.2;
  // тонкие снизу, толстые сверху — жилая улица не утолщает пересечение с primary
  for (const cls of ['lane', 'minor', 'mid', 'major', 'rail']) {
    if (cls === 'lane' && !laneOn) continue;
    const strokeMm = Math.max(WEB_MIN_MM[cls], WEB_REAL_M[cls] * mmPerM);
    ctx.lineWidth = strokeMm * mmPx;
    ctx.setLineDash(cls === 'rail' ? [0.34 * mmPx, 0.22 * mmPx] : []);
    for (const e of elements) {
      if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
      if (WEB_CLS(e) !== cls) continue;
      ctx.beginPath();
      const [x0, y0] = toPx(e.geometry[0].lat, e.geometry[0].lon);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < e.geometry.length; i++) {
        const [x, y] = toPx(e.geometry[i].lat, e.geometry[i].lon);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  return samplerOf(ctx, 1);   // паутине хватает одного прохода фаски
}

