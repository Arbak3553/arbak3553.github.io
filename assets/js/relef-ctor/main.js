// REL'EF constructor: single-scroll settings panel (model, place, relief,
// shoulders, band, engraving, size, order) with a live three.js preview.
// Port of the project's latest /design page (TS ring engine + mosaic hot path);
// sections not applicable to the chosen form are hidden entirely (formUI).
import * as THREE from 'three';
import { OrbitControls } from '../jsm/controls/OrbitControls.js';
import { studioEnv } from './studio-env.js';
import { RGBELoader } from '../jsm/loaders/RGBELoader.js';
import { makeSampler, processHM, rotator, meshVolume } from './math.js';
import { buildSignet, mapFootprint } from './signet.js';
import { buildDisc, buildWireBand, buildBandCollar, discEmbed, DISC_W } from './disc.js';
import { initMap } from './map.js';
import { loadMosaic, cropOrigin, cropWindow, windowSpec, metersPerPx } from './mosaic.js';
import { fetchRoads, buildRoadsSignet, buildRoadsOpenDisc } from './roads.js';
import { fetchWater, fetchArteries, fetchWebStreets, waterMask, arteryMask, webMask, cityCached } from './water.js';
import { fetchParks, parksMask } from './greenery.js';
import { cityTilesFor, fetchCityLayers, buildingsMask } from './citytiles.js';
import { downloadSTL, stlForOrder, warmupManifold } from './stl.js';
import { buildEarring, EAR_W } from './earring.js';
import { buildPendant, PEND_W } from './pendant.js';
import { orderText, jewelerText, sendViaTelegram, sendViaMail, placeNameOf, engraveLine, ENGRAVE_PRICE, PRICES, priceOf, fmtRub, SHOULDER_LABEL, BAND_LABEL, dimsOf } from './order.js';
import { ringEngraveMesh, coinEngraveMesh } from './engrave3d.js';

const $ = id => document.getElementById(id);

// roads/openwork mode is parked (Arbak, 27.07): engine and loader stay, flip to bring UI back
const ROADS_ENABLED = false;

const MTN_PRESETS = [
  { name: 'Эльбрус', lat: 43.3499, lon: 42.4453 },
  // twin-peak frame: centered between Greater (5165 m) and Little (3896 m) Ararat,
  // 11 km apart; z11.8 spans ~15.5 km so both cones land on the piece, and
  // bearing 34 puts the summit axis along the signet sweep (saddle reads in profile)
  { name: 'Арарат', lat: 39.6740, lon: 44.3510, mz: 11.8, br: 34 },
  { name: 'Домбай', lat: 43.2917, lon: 41.6247 },
  { name: 'Казбек', lat: 42.6950, lon: 44.5183 },
  { name: 'Белуха', lat: 49.8078, lon: 86.5906 },
  { name: 'Фишт', lat: 43.9536, lon: 39.9042 },
];
const SEA_PRESETS = [
  { name: 'Ай-Петри', lat: 44.4517, lon: 34.0600 },
  { name: 'Ольхон', lat: 53.2000, lon: 107.3500 },
  { name: 'Фиолент', lat: 44.5100, lon: 33.4800 },
  { name: 'Куршская коса', lat: 55.1500, lon: 20.8500 },
];
const FORM_LABEL = { disc: 'Диск', signet: 'Печатка', earrings: 'Серьги', pendant: 'Подвеска' };
const WEIGHT_LABEL = { subtle: 'S', classic: 'M', statement: 'L' };
const CLOSURE_LABEL = { stud: 'пусеты', leverback: 'английский замок', hook: 'крючки' };
const MOUNT_LABEL = { two: 'два ушка', one: 'одно ушко' };
const DETAIL_PASSES = { low: 2, medium: 1, high: 0 };
const SIZES_MM = Array.from({ length: 15 }, (_, i) => 15 + i * 0.5);
const CHAIN_CM = [40, 45, 50, 55];

/* ================= state ================= */
// MVP product is the disc (frozen scope); the signet stays available
const state = {
  form: 'disc', weight: 'classic', closure: 'leverback', pendMount: 'two',
  heightPct: 50, detail: 'high', basePct: 35, surface: 'terrain',
  shoulder: 'classic', band: 'classic',
  engrave: 'coords', engraveText: '',
  sizeMm: 18, chainCm: 45,
  finish: 'gloss',   // отделка металла: глянец по умолчанию, сатин опцией
};
const view = { lat: 43.3499, lon: 42.4453, mz: 12, bearing: 0 };

/* restore from share link (same keys as the site's /design hash);
   short links like #f=pendant (shop cards) carry the form without a location */
try {
  const q = new URLSearchParams(location.hash.slice(1));
  if ([...q.keys()].length) {
    const f = q.get('f'), w = q.get('w'), d = q.get('d'), sh = q.get('sh'), b = q.get('b');
    if (f === 'disc' || f === 'signet' || f === 'earrings' || f === 'pendant') state.form = f;
    const cl = q.get('cl');
    if (cl === 'stud' || cl === 'leverback' || cl === 'hook') state.closure = cl;
    const pm = q.get('pm');
    if (pm === 'two' || pm === 'one') state.pendMount = pm;
    if (q.get('fin') === 'satin') state.finish = 'satin';
    const en = q.get('e');
    if (en === 'coords' || en === 'custom' || en === 'none') state.engrave = en;
    state.engraveText = (q.get('et') || '').slice(0, 40);
    if (w === 'subtle' || w === 'classic' || w === 'statement') state.weight = w;
    state.heightPct = Math.max(0, Math.min(100, +(q.get('h') || 50)));
    if (d === 'low' || d === 'medium' || d === 'high') state.detail = d;
    state.basePct = Math.max(0, Math.min(70, +(q.get('bp') || 35)));
    const sf = q.get('sf');
    if (sf === 'terrain' || sf === 'city' || (ROADS_ENABLED && sf === 'roads')) state.surface = sf;
    if (sh === 'straight' || sh === 'classic' || sh === 'curved') state.shoulder = sh;
    if (b === 'flat' || b === 'classic' || b === 'd-shaped') state.band = b;
    const s = +(q.get('s') || 18);
    if (SIZES_MM.includes(s)) state.sizeMm = s;
    const cc = +(q.get('cc') || 45);
    if (CHAIN_CM.includes(cc)) state.chainCm = cc;
    if (q.has('lat')) {
      view.lat = +q.get('lat'); view.lon = +q.get('lon');
      view.mz = +(q.get('z') || 12); view.bearing = +(q.get('br') || 0);
    }
  }
} catch (e) { console.warn('bad share link', e); }

/* ================= three.js stage ================= */
const wrap = $('ctor-canvas');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.24;
wrap.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xfbfbf7);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
camera.position.set(34.5, 19.2, 41.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2.5, 0);
controls.enableDamping = true;
controls.autoRotate = true; controls.autoRotateSpeed = 1.1;
controls.addEventListener('start', () => controls.autoRotate = false);
const pmrem = new THREE.PMREMGenerator(renderer);
// студийные софтбоксы — мгновенный старт и фолбэк, пока грузится панорама
// («реально отполированный», Арбак 20.08); см. studio-env.js
scene.environment = pmrem.fromScene(studioEnv(), 0.035).texture;
// Темы сцены меняют ТОЛЬКО фон и UI витрины; отражения в металле ЕДИНЫ —
// тёплая мастерская («в тёмной теме такое же отражение, как в светлой»,
// Арбак 20.08): дневной свет держит серебро серебром, дерево и картины
// греют блики, а тёмный фон лишь добавляет вес.
const STAGE_THEMES = { light: 0xfbfbf7, dark: 0x18191c };
// сцена следует ТЕМЕ САЙТА (data-theme ставит бут-скрипт в head, тумблер в
// шапке шлёт relef-theme) — свой переключатель у сцены упразднён
let stageTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
window.addEventListener('relef-theme', e => applyStageTheme(e.detail === 'dark' ? 'dark' : 'light'));
// Гибридное окружение: панорама мастерской по горизонту (мир в шинке) +
// журнальные полосы света в зените. Лицо монеты смотрит ВВЕРХ и отражает
// потолок, а у фотопанорамы он пустой — шапка выходила глухой серой
// («шапка не отражает окружающий мир», Арбак 20.08).
new RGBELoader().load('/assets/hdr/room-light-1k.hdr', tex => {
  const env = new THREE.Scene();
  // ЛОВУШКА РЕЗКОСТИ (поймано 20.08, «отражение заблюренное»): текстуре на
  // сфере нужен ШТАТНЫЙ UV-маппинг — equirect-режим ломает сэмплинг на меше;
  // и никакой сигмы в fromScene: 0.03 мягчила процедурные софтбоксы, а фото
  // размывала целиком.
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 64, 48),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })));
  const strip = (w, d, intensity, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(intensity) }));
    m.position.set(0, 11, z);
    m.rotation.x = Math.PI / 2;
    env.add(m);
  };
  strip(24, 2.6, 4.5, 0.2);    // ключевая полоса
  strip(24, 1.4, 0.15, 2.6);   // тёмный интервал — контраст на лице
  strip(24, 2.2, 1.6, 4.8);
  strip(24, 2.0, 0.9, -2.8);
  scene.environment = pmrem.fromScene(env).texture;
  tex.dispose();
}, undefined, () => { /* офлайн/404 — остаёмся на процедурной студии */ });
function applyStageTheme(theme) {
  stageTheme = theme;
  scene.background = new THREE.Color(STAGE_THEMES[theme]);
  document.querySelector('.ctor-stage').classList.toggle('dark', theme === 'dark');
}
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1); keyLight.position.set(30, 40, 20); scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.7); rimLight.position.set(-35, 20, -30); scene.add(rimLight);
// uniform finish (Arbak, 27.07.2026): the piece is cast from one billet of 925 —
// the relief must not read as a different, whiter alloy than the band.
// Глянец: шинка-зеркало (0.05), рельеф чуть глуше (0.11). Сатин: матовая
// штриховка полировщика — та же пара с ростом шероховатости, блеск гаснет,
// формы читаются мягкими градиентами.
const MATS = {
  band:   new THREE.MeshPhysicalMaterial({ color: 0xf6f8fa, metalness: 1, roughness: 0.05, envMapIntensity: 1.15 }),
  relief: new THREE.MeshPhysicalMaterial({ color: 0xf4f7f9, metalness: 1, roughness: 0.11, envMapIntensity: 1.05 }),
};
// Сатин калиброван качелями (20.08): 0.30 читался мёртвым гипсом, 0.10 не
// отличался от глянца на живом окружении — 0.20/0.24 матовеет честно, но
// металл продолжает дышать градиентами.
const FINISHES = {
  // рельеф в глянце почти как шинка («шапка не очень глянцево», 20.08) —
  // разница осталась ровно на то, чтобы гравировка читалась
  gloss: { band: 0.05, relief: 0.07, envB: 1.15, envR: 1.1 },
  satin: { band: 0.20, relief: 0.24, envB: 1.0, envR: 0.95 },
};
function applyFinish() {
  const f = FINISHES[state.finish] || FINISHES.gloss;
  MATS.band.roughness = f.band; MATS.relief.roughness = f.relief;
  MATS.band.envMapIntensity = f.envB; MATS.relief.envMapIntensity = f.envR;
}
applyFinish();
applyStageTheme(stageTheme);
const ringGroup = new THREE.Group();
ringGroup.rotation.x = -Math.PI / 2;
scene.add(ringGroup);
// debug hook for the console (static site, no secrets here)
window.__relefCtor = { ringGroup, camera, controls, renderer, scene,
  // городские слои для стендов: сколько элементов доехало из OSM,
  // и ручка повтора — зеркала Overpass временами отбивают всю пачку
  cityInfo: () => {
    const geo = state.surface === 'city' ? cityGeoKey() : '';
    return { water: (waterEls || []).length, arteries: (arteryEls || []).length, web: (cityRoads || []).length,
      parks: (parksEls || []).length, builds: (buildsEls || []).length,
      // applied = прописка слоя совпадает с текущим окном (маска реально режется)
      applied: { water: waterGeo === geo && !!geo, arteries: arteryGeo === geo && !!geo, web: webGeo === geo && !!geo,
        parks: parksGeo === geo && !!geo, builds: buildsGeo === geo && !!geo } };
  },
  refetchCity: () => refetchWater() };
// mapApi доезжает ниже (initMap) — стендам нужен доступ к goTo/setBearing
function sizeStage() {
  const r = wrap.getBoundingClientRect();
  renderer.setSize(r.width, r.height);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
addEventListener('resize', sizeStage); sizeStage();
// Самописец кадра: пишет то, что видит ПОЛЬЗОВАТЕЛЬ, — стендовые fps-замеры
// в превью-панели врут (документ hidden, rAF заморожен, таймеры по 1 с).
// __relefCtor.stats() отдаёт медиану/хвост кадровых времён и счётчики пересборок.
const frameDt = new Float32Array(240);
let frameN = 0, framePrev = 0, longTasks = 0, longWorst = 0, rebuilds = 0, rebuildMsSum = 0;
try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) { longTasks++; if (e.duration > longWorst) longWorst = e.duration; }
  }).observe({ entryTypes: ['longtask'] });
} catch (err) { /* Safari без longtask — живём без него */ }
window.__relefCtor.stats = () => {
  const n = Math.min(frameN, frameDt.length);
  const a = [...frameDt.slice(0, n)].sort((x, y) => x - y);
  const q = p => n ? +a[Math.min(n - 1, Math.floor(p * n))].toFixed(1) : 0;
  const s = { frames: frameN, dtMed: q(0.5), dtP90: q(0.9), dtMax: n ? +a[n - 1].toFixed(1) : 0,
    longTasks, longWorst: Math.round(longWorst), rebuilds, rebuildMsAvg: rebuilds ? Math.round(rebuildMsSum / rebuilds) : 0 };
  frameN = 0; longTasks = 0; longWorst = 0; rebuilds = 0; rebuildMsSum = 0;   // окно замера сбрасывается чтением
  return s;
};
(function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  if (framePrev) frameDt[frameN++ % frameDt.length] = now - framePrev;
  framePrev = now;
  controls.update();
  renderer.render(scene, camera);
})();

/* ================= heightmap: mosaic hot path ================= */
let mosaic = null, raw = null, proc = null;
// стартовая болванка: плоские высоты, чтобы металл появился в первые же
// кадры («0 задержки»); настоящий рельеф заместит её по приходу тайлов
const PLACEHOLDER_PROC = { w: 2, h: 2, data: new Float32Array(4) };
let token = 0, hotLast = 0, hotTimer = null, cityPrefetchT = null;
// live drags run a coarse grid + coarse mesh (LOD); the released view rebuilds full
let fastMode = false;
const FAST_GRID = 240, FULL_GRID = 640, FAST_LOD = 0.5;
const HOT_MS = 25;
let roads = null, roadsToken = 0;
// сырые элементы OSM и построенная из них маска; маска зависит от размера
// изделия, поэтому пересобирается при смене формы/веса, а не при каждом кадре
let waterEls = null, waterToken = 0, waterFn = null, waterKey = '';
let arteryEls = null, arteryFn = null, cityRoads = null, webFn = null;
// прописка слоёв: гео-ключ окна, под которое каждый слой загружен
let waterGeo = '', arteryGeo = '', webGeo = '';
let parksEls = null, parksFn = null, parksGeo = '';
let buildsEls = null, buildsFn = null, buildsGeo = '';
// Паутина улиц включается только на близких окнах: когда ДИСК читает шире
// ~7.5 км, промежутки между улицами меньше литейного штриха и сеть сливается
// в кашу (проверено на Москве, покрытие диска 10 км). Порог сравнивается с
// ПОЛНЫМ окном рамки: диск читает 0.55 окна, поэтому 7.5 / 0.55 ≈ 13.5 км.
// Каркас из артерий живёт на любом масштабе.
const WEB_MAX_WINDOW_M = 13500;

// Паутина: полная уличная сеть своим конвейером (fetchWebStreets — абсолютные
// координаты, ячеечный кеш, гонка зеркал, деградация до каркаса). null не
// затирает прежние элементы; полный провал ретраится дважды с шагом 8 с —
// раньше провал паутины не ретраился вовсе (Питер стоял пустым, 19.08).
function fetchWeb(t, geo, windowM, attempt = 0) {
  fetchWebStreets(view.lat, view.lon, windowM).then(els => {
    if (t !== waterToken) return;
    if (els && els.length) { cityRoads = els; webGeo = geo; scheduleLayerRebuild(); }
    else if (attempt < 2) setTimeout(() => { if (t === waterToken) fetchWeb(t, geo, windowM, attempt + 1); }, 8000);
  }).catch(() => {});
}
let lastGrams = 0;
let castGeoms = null;   // earrings: castable part only (coin + loop); null = export all

/* ---- build worker: монетные формы собираются вне главного потока ---- */
// Пересборка (45-250 мс) блокировала кадры рендера и карту. Диск, подвеска и
// серьги строятся в воркере; печатка и режим дорог — по-прежнему синхронно
// (лёгкие и редкие). При любой ошибке воркера — тихий откат на sync-путь.
let ctorWorker = null, buildGen = 0, buildBusy = false, buildDirty = false, sentMasksKey = '';
const pendingMeta = new Map();
try {
  ctorWorker = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
  ctorWorker.onerror = () => { ctorWorker = null; sentMasksKey = ''; rebuild(); };
  ctorWorker.onmessage = e => {
    if (!e.data || e.data.type !== 'built') return;
    buildBusy = false;
    const meta = pendingMeta.get(e.data.gen);
    pendingMeta.delete(e.data.gen);
    if (e.data.gen === buildGen && meta) applyBuilt(e.data, meta);
    pumpBuild();   // пока строили, могло навалиться новое состояние
  };
} catch (err) { ctorWorker = null; }

function rebuild() {
  if (!proc) return;
  const viaWorker = ctorWorker && (state.form === 'pendant' || state.form === 'earrings'
    || ((state.form === 'disc' || state.form === 'signet') && state.surface !== 'roads'));
  if (!viaWorker) { rebuildSync(); return; }
  buildDirty = true;
  pumpBuild();
}

// Мгновенный отклик на ЛЮБОЕ взаимодействие: лёгкий меш строится сразу,
// полный догоняет фоном через 260 мс тишины — слайдеры и переключатели
// больше не ждут полной плотности («0 задержки», Арбак 20.08).
let fullTimer = null;
function interact() {
  fastMode = true;
  rebuild();
  clearTimeout(fullTimer);
  fullTimer = setTimeout(() => { fastMode = false; rebuild(); }, 260);
}

// один рейс за раз: свежая генерация всегда перекрывает недостроенную,
// устаревший результат выбрасывается по gen
function pumpBuild() {
  if (!buildDirty || buildBusy || !ctorWorker || !proc) return;
  buildDirty = false; buildBusy = true;
  const gen = ++buildGen;
  const lod = fastMode ? FAST_LOD : 1;
  const cityMap = state.surface === 'city';
  const amp = cityMap ? 0.12 : 1;
  const fH = 1 + 4 * state.heightPct / 100;
  let p, dm = 0;
  if (state.form === 'earrings') {
    p = { wk: state.weight, closure: state.closure, fH, basePct: state.basePct / 100 };
  } else if (state.form === 'pendant') {
    dm = 2 * (PEND_W[state.weight] || PEND_W.classic).R;
    const { zt: zt2, cw: cw2 } = windowSpec(view.mz);
    p = { wk: state.weight, mount: state.pendMount, fH: fH * amp, basePct: state.basePct / 100, city: cityMap,
      close: cityMap && cw2 * metersPerPx(view.lat, zt2) <= 2600 * dm / 15.2 };
  } else if (state.form === 'signet') {
    p = { size: state.sizeMm, wk: state.weight, fH, band: state.band, shoulder: state.shoulder };
  } else {
    const { minor } = DISC_W[state.weight] || DISC_W.classic;
    dm = 2 * (DISC_W[state.weight] || DISC_W.classic).R;
    // zTop шинки без постройки тора: major + minor = size/2 + 2*minor
    const { zt: zt3, cw: cw3 } = windowSpec(view.mz);
    p = { wk: state.weight, fH: fH * amp, basePct: state.basePct / 100, city: cityMap,
      close: cityMap && cw3 * metersPerPx(view.lat, zt3) <= 2600 * dm / 15.2,
      zBandTop: state.sizeMm / 2 + 2 * minor };
  }
  // маски уезжают при смене РЕВИЗИИ содержимого (maskRev): ключ окна не
  // меняется, когда слои доезжают в то же окно, — гейт по ключу оставлял
  // воркер с пустыми масками первой отправки (город без линий, поймано на
  // живом показе 18.08). Вне города — гасятся, иначе воркер резал бы прошлый
  // город в горный рельеф.
  if (cityMap && state.form !== 'earrings' && state.form !== 'signet') {
    const cm = cityMasks(dm);
    if (`${maskRev}` !== sentMasksKey) {
      const any = cm.water || cm.major || cm.web;
      ctorWorker.postMessage({ type: 'masks', rev: maskRev, px: any ? any.px : 0,
        water: cm.water ? cm.water.data : null,
        artery: cm.major ? cm.major.data : null,
        web: cm.web ? cm.web.data : null,
        parks: cm.parks ? cm.parks.data : null,
        builds: cm.builds ? cm.builds.data : null });
      sentMasksKey = `${maskRev}`;
    }
  } else if (sentMasksKey !== 'off') {
    ctorWorker.postMessage({ type: 'masks', rev: 'off', px: 0, water: null, artery: null, web: null, parks: null, builds: null });
    sentMasksKey = 'off';
  }
  pendingMeta.set(gen, { form: state.form, weight: state.weight, sizeMm: state.sizeMm, fH, lod, fast: fastMode });
  ctorWorker.postMessage({ type: 'build', gen, lod, bearing: view.bearing, form: state.form, p,
    heightsRev, heights: { data: proc.data, w: proc.w, h: proc.h } });
}

function applyBuilt(r, meta) {
  while (ringGroup.children.length) {
    const m = ringGroup.children.pop();
    m.geometry.dispose();
    if (m.userData.skipExport && m.material) {
      if (m.material.map) m.material.map.dispose();
      m.material.dispose();
    }
  }
  const addMesh = g => ringGroup.add(new THREE.Mesh(g, g.groups.length === 2 ? [MATS.band, MATS.relief] : MATS.band));
  const geoms = r.parts.map(part => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(part.norm, 3));
    g.setIndex(new THREE.BufferAttribute(part.idx, 1));
    for (const gr of part.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    return g;
  });
  geoms.forEach(addMesh);
  let vol = r.vol;
  castGeoms = null;
  if (meta.form === 'disc') {
    const wire = buildWireBand(meta.sizeMm, meta.weight);
    addMesh(wire.geom);
    vol += meshVolume(wire.geom);
    const collar = buildBandCollar(meta.sizeMm, meta.weight);
    addMesh(collar);
    vol += collar.userData.addVol;
  } else if (meta.form !== 'signet') {
    castGeoms = geoms.slice(0, r.castCount);
  }
  const e = engraveLine(state, view);
  if (e) {
    const coinR = meta.form === 'earrings' ? (EAR_W[meta.weight] || EAR_W.classic).R
                : meta.form === 'pendant' ? (PEND_W[meta.weight] || PEND_W.classic).R : 0;
    const em = coinR
      ? coinEngraveMesh(e.text, coinR)
      : ringEngraveMesh(e.text, meta.sizeMm / 2 - 0.015, meta.form === 'signet' ? 3.2 : 0.9);
    if (coinR) em.geometry.rotateX(Math.PI / 2);
    em.userData.skipExport = true;
    ringGroup.add(em);
  }
  if (!meta.fast) lastGrams = vol * 10.49 / 1000;
  $('ctor-grams').textContent = lastGrams ? lastGrams.toFixed(1) + ' г' + (meta.form === 'earrings' ? ' (пара)' : '') : '—';
  $('ctor-hmm').textContent = meta.fH.toFixed(1);
  window.__relefCtor.perf = { worker: true, total: r.ms, fast: meta.fast, lod: meta.lod };
  rebuilds++; rebuildMsSum += r.ms;
}

function rebuildSync() {
  if (!proc) return;
  const perf = { t0: performance.now() };   // стендовая телеметрия, см. __relefCtor.perf
  const lod = fastMode ? FAST_LOD : 1;
  const sample = makeSampler(proc.data, proc.w, proc.h);
  const rot = rotator(view.bearing);
  const city = state.surface === 'roads';
  // городской режим: высоты приглушаются до фоновой волны, иначе шум равнины
  // нормируется на полный бюджет и забивает воду
  const cityMap = state.surface === 'city';
  // 0.12, а не 0.3: на равнине даже приглушённый рельеф спорит с водой.
  // Плита должна читаться полированной, вода — единственным рисунком.
  const amp = cityMap ? 0.12 : 1;
  const fH = 1 + 4 * state.heightPct / 100;
  const roadH = 0.3 + 0.9 * state.heightPct / 100;
  const list = city ? (roads || []) : [];
  while (ringGroup.children.length) {
    const m = ringGroup.children.pop();
    m.geometry.dispose();
    if (m.userData.skipExport && m.material) {
      if (m.material.map) m.material.map.dispose();
      m.material.dispose();
    }
  }
  const addMesh = g => ringGroup.add(new THREE.Mesh(g, g.groups.length === 2 ? [MATS.band, MATS.relief] : MATS.band));
  let vol = 0;
  castGeoms = null;
  if (state.form === 'earrings') {
    const ear = buildEarring({ wk: state.weight, closure: state.closure, fH, basePct: state.basePct / 100, hsample: sample, rot, lod });
    ear.geoms.forEach(addMesh);
    castGeoms = ear.geoms.slice(0, ear.castCount);
    vol = ear.vol * 2;                 // a pair
  } else if (state.form === 'pendant') {
    const pdm = 2 * (PEND_W[state.weight] || PEND_W.classic).R;
    const pcm = cityMasks(pdm);
    const closeP = cityMap && (windowSpec(view.mz).cw * metersPerPx(view.lat, windowSpec(view.mz).zt)) <= 2600 * pdm / 15.2;
    const p = buildPendant({ wk: state.weight, mount: state.pendMount, fH: fH * amp, basePct: state.basePct / 100, hsample: sample, rot, lod, city: cityMap, close: closeP, water: pcm.water, roadMajor: pcm.major, roadWeb: pcm.web, parks: pcm.parks, builds: pcm.builds });
    p.geoms.forEach(addMesh);
    castGeoms = p.geoms.slice(0, p.castCount);
    vol = p.vol;                       // cast part only, the chain is bought
  } else if (state.form === 'disc') {
    const wire = buildWireBand(state.sizeMm, state.weight);
    if (city) {
      const { R, T } = DISC_W[state.weight] || DISC_W.classic;
      const extra = Math.max(0, roadH - 0.3);
      const open = buildRoadsOpenDisc(R, wire.zTop - discEmbed(state.weight), T, list, view.bearing, extra);
      addMesh(open.mesh); addMesh(wire.geom);
      vol = open.vol + meshVolume(wire.geom);
    } else {
      const dm = 2 * (DISC_W[state.weight] || DISC_W.classic).R;
      const tm = performance.now();
      const cm = cityMasks(dm);
      const closeD = cityMap && (windowSpec(view.mz).cw * metersPerPx(view.lat, windowSpec(view.mz).zt)) <= 2600 * dm / 15.2;
      perf.masks = performance.now() - tm;
      const disc = buildDisc({ zoom: 0.55, fH: fH * amp, basePct: state.basePct / 100, zBandTop: wire.zTop, wk: state.weight, hsample: sample, rot, lod, city: cityMap, close: closeD, water: cm.water, roadMajor: cm.major, roadWeb: cm.web, parks: cm.parks, builds: cm.builds });
      perf.disc = performance.now() - tm - perf.masks;
      addMesh(disc); addMesh(wire.geom);
      const collar = buildBandCollar(state.sizeMm, state.weight);
      addMesh(collar);
      vol = meshVolume(disc) + meshVolume(wire.geom) + collar.userData.addVol;
      perf.vol = performance.now() - tm - perf.masks - perf.disc;
    }
  } else {
    const g = buildSignet({ size: state.sizeMm, zoom: 0.6, fH, weight: state.weight, band: state.band, shoulder: state.shoulder, city, hsample: sample, rot, lod });
    // печатка — ЕДИНЫЙ материал: это один слитный меш, и на зеркальной
    // полировке граница групп band/relief читалась швом поперёк шинки
    // («видно граница от шинки до верха», Арбак 20.08); у диска эту границу
    // прячет бортик монеты, здесь ей прятаться негде
    ringGroup.add(new THREE.Mesh(g, MATS.band));
    vol = meshVolume(g);
    if (city) {
      const extra = Math.max(0, roadH - 0.3);
      const r = buildRoadsSignet(g.userData.face, list, view.bearing, extra);
      if (r.mesh) { addMesh(r.mesh); vol += r.vol; }
    }
  }
  // engraving preview: text on the piece itself (not exported, not cast)
  const e = engraveLine(state, view);
  if (e) {
    // hug the metal: a wide radial gap reads as the text floating off the
    // band with a parallax slide while the ring rotates
    const coinR = state.form === 'earrings' ? (EAR_W[state.weight] || EAR_W.classic).R
                : state.form === 'pendant' ? (PEND_W[state.weight] || PEND_W.classic).R : 0;
    const em = coinR
      ? coinEngraveMesh(e.text, coinR)
      : ringEngraveMesh(e.text, state.sizeMm / 2 - 0.015, state.form === 'signet' ? 3.2 : 0.9);
    if (coinR) em.geometry.rotateX(Math.PI / 2);
    em.userData.skipExport = true;
    ringGroup.add(em);
  }
  // the coarse drag mesh underreports volume — keep the last full-quality weight
  if (!fastMode) lastGrams = vol * 10.49 / 1000;
  $('ctor-grams').textContent = lastGrams ? lastGrams.toFixed(1) + ' г' + (state.form === 'earrings' ? ' (пара)' : '') : '—';
  $('ctor-hmm').textContent = (city ? roadH : fH).toFixed(1);
  updateCityHint();
  perf.total = performance.now() - perf.t0;
  perf.fast = fastMode; perf.lod = lod;
  window.__relefCtor.perf = perf;
  rebuilds++; rebuildMsSum += perf.total;
}

// Terrarium несёт ~30 м на отсчёт. Пока сетка изделия читает рельеф чаще этого,
// нерезкая маска в processHM возвращает потерянные детали. Как только на отсчёт
// приходится заметно больше 30 м (широкий охват — остров, полуостров, регион),
// та же маска раздувает перепад между соседними ячейками DEM в иглу: на литье
// это непроливаемое остриё, на серьге — крючок для волос. Поэтому заострение
// гаснет, а сглаживание растёт по мере того, как метров на отсчёт становится
// больше. На горных кадрах (Эльбрус, Арарат) отношение <1 и поведение прежнее.
const DEM_M = 30;
// Сила деталей по уровню «Детализация»: sharpen — тонкая полоса, structure —
// средняя (морщины скал). На «Высокой» жмём заметно злее прежних 0.7/0:
// сравнение с конкурентным рендером (20.08) показало, что наши склоны
// выходили обмылками — данные DEM это несут, мы их растрачивали.
const DETAIL_STRENGTH = {
  low:    { sharpen: 0.35, structure: 0.25 },
  medium: { sharpen: 0.75, structure: 0.55 },
  high:   { sharpen: 1.15, structure: 0.85 },
};
function reliefFilter(gridW) {
  const { zt, cw } = windowSpec(view.mz);
  const perSample = cw * metersPerPx(view.lat, zt) / gridW;
  const over = perSample / DEM_M;
  const base = DETAIL_PASSES[state.detail];
  const s = DETAIL_STRENGTH[state.detail];
  if (over <= 1) return { passes: base, sharpen: s.sharpen, structure: s.structure };
  // шире DEM: заострение гаснет, иначе перепады соседних ячеек 30-метрового
  // источника раздуваются в нелитейные иглы (см. комментарий к DEM_M)
  const oct = Math.log2(over);
  const damp = Math.max(0, 1 - oct / 4);
  return {
    passes: base + Math.min(8, Math.round(oct)),
    sharpen: s.sharpen * damp,
    structure: s.structure * damp,
  };
}

let heightsRev = 0;   // ревизия высот — ключ воркерного кеша сборок
function reprocess() {
  if (!raw) return;
  const f = reliefFilter(raw.w);
  // в драге — без структурной полосы (три лишних блюр-прохода на каждый
  // хот-тик); полная скалистость возвращается релизной пересборкой
  const sharpen = fastMode ? Math.min(f.sharpen, 0.6) : f.sharpen;
  const structure = fastMode ? 0 : f.structure;
  proc = { w: raw.w, h: raw.h, data: processHM(raw.data, raw.w, raw.h, f.passes, sharpen, structure) };
  heightsRev++;
  rebuild();
}

/** Zero-network path: re-crop the window from the in-memory mosaic. */
function tryHot(onStale) {
  if (!mosaic) return false;
  const { zt, cw } = windowSpec(view.mz);
  if (zt !== mosaic.zt) return false;
  const o = cropOrigin(mosaic, view.lat, view.lon, cw);
  raw = cropWindow(mosaic, o.x0, o.y0, cw, fastMode ? FAST_GRID : FULL_GRID);
  reprocess();
  if (o.stale && onStale) onStale();
  return true;
}

async function refetch() {
  const t = ++token;
  const { zt, cw } = windowSpec(view.mz);
  try {
    const m = await loadMosaic(view.lat, view.lon, zt, cw);
    if (t !== token) return;
    mosaic = m;
    tryHot();
  } catch (e) { /* tiles unreachable — keep the last relief */ }
}

// Гео-ключ текущего окна. Слои носят прописку окна, под которое загружены,
// и маска строится ТОЛЬКО при совпадении прописки с текущим окном: иначе при
// перетаскивании карты старые элементы растеризовались бы по чужому окну
// (линии прошлого места «наложением» на новом), причём на КАЖДЫЙ кадр драга —
// три канвы 1024 с размытием клали fps в пол (поймано Арбаком 18.08).
function cityGeoKey() {
  const { zt, cw } = windowSpec(view.mz);
  const windowM = cw * metersPerPx(view.lat, zt);
  return `${view.lat.toFixed(4)}/${view.lon.toFixed(4)}/${Math.round(windowM)}`;
}

// Пересборка по прибытии слоёв — коалесцентная: вода и артерии из кеша
// резолвятся в соседних микротасках, и каждая тащила бы свою полную
// пересборку (245 мс x2 = полсекунды фриза на отпускании карты).
let layerRebuildT = 0;
function scheduleLayerRebuild() {
  if (layerRebuildT) return;
  layerRebuildT = setTimeout(() => {
    layerRebuildT = 0;
    waterKey = '';           // маски пересобрать под свежие слои
    rebuild();
  }, 30);
}

function refetchWater(attempt = 0) {
  if (state.surface !== 'city') return;
  const t = ++waterToken;
  const geo = cityGeoKey();
  const { zt, cw } = windowSpec(view.mz);
  const windowM = cw * metersPerPx(view.lat, zt);
  // ТАЙЛОВЫЙ город (Москва, Питер): все слои — вода полигонами, дороги,
  // парки и ЗДАНИЯ — из локального PMTiles одним заходом, без зеркал
  if (cityTilesFor(view.lat, view.lon)) {
    if (waterGeo === geo && buildsGeo === geo) return;   // уже применено
    fetchCityLayers(view.lat, view.lon, windowM).then(r => {
      if (t !== waterToken || !r) return;
      waterEls = r.water; waterGeo = geo;
      arteryEls = r.roads.filter(e => /^(motorway|trunk)/.test(e.tags.highway || ''));
      arteryGeo = geo;
      cityRoads = r.roads; webGeo = geo;
      parksEls = r.parks; parksGeo = geo;
      buildsEls = r.builds; buildsGeo = geo;
      scheduleLayerRebuild();
    }).catch(() => {});
    return;
  }
  // Горячий путь: оба слоя в кеше (обычный случай — вернулись на то же окно
  // после драга, или страница перезагружена). Зеркала не трогаем, стаггер не
  // нужен, все слои встают ОДНОЙ пересборкой — без трёх рывков по полторы
  // секунды («очень сильно лагает», Арбак 18.08).
  if (cityCached(view.lat, view.lon, windowM)) {
    // всё уже применено к этому окну — пересобирать нечего (возврат на то же
    // место после драга давал вторую полную пересборку вхолостую)
    if (waterGeo === geo && arteryGeo === geo
        && (webGeo === geo || windowM > WEB_MAX_WINDOW_M)) return;
    const pw = fetchWater(view.lat, view.lon, windowM)
      .then(els => { if (t === waterToken && els) { waterGeo = geo; waterEls = els; } });
    const pa = fetchArteries(view.lat, view.lon, windowM)
      .then(els => { if (t === waterToken && els) { arteryGeo = geo; arteryEls = els; } });
    const pp = fetchParks(view.lat, view.lon, windowM)
      .then(els => { if (t === waterToken && els) { parksGeo = geo; parksEls = els; } })
      .catch(() => {});
    Promise.allSettled([pw, pa, pp]).then(() => {
      if (t !== waterToken) return;
      scheduleLayerRebuild();
    });
    // паутина отдельно: у fetchRoads свой кеш, но при промахе он ходит в сеть —
    // воду и артерии его ожидание задерживать не должно
    if (windowM <= WEB_MAX_WINDOW_M) fetchWeb(t, geo, windowM);
    return;
  }
  // Зеркала Overpass капризны: два одновременных POST с одного адреса зеркало
  // может отбить (поймано живьём — кольца доехали, река нет), поэтому артерии
  // уходят с отступом 0.7 с (ask теперь гонит зеркала параллельно, длинный
  // стаггер только тянул время до линий). null = все зеркала отбились: старые
  // элементы НЕ затираем — лучше рисунок прошлого окна, чем молча пропавшие
  // линии — и ОДИН раз пробуем снова через 8 с (кеш неудачу не хранит).
  let failed = false;
  fetchWater(view.lat, view.lon, windowM).then(els => {
    if (t !== waterToken) return;
    if (!els) failed = true;
    if (els) { waterGeo = geo; waterEls = els; scheduleLayerRebuild(); }
  }).catch(() => { failed = true; });
  setTimeout(() => {
    if (t !== waterToken) return;
    fetchArteries(view.lat, view.lon, windowM).then(els => {
      if (t !== waterToken) return;
      if (!els) failed = true;
      if (els) { arteryGeo = geo; arteryEls = els; scheduleLayerRebuild(); }
      if (failed && attempt < 1) setTimeout(() => { if (t === waterToken) refetchWater(attempt + 1); }, 8000);
    }).catch(() => {});
  }, 700);
  const goParks = attempt2 => {
    fetchParks(view.lat, view.lon, windowM).then(els => {
      if (t !== waterToken) return;
      if (els && els.length) { parksGeo = geo; parksEls = els; scheduleLayerRebuild(); }
      else if (attempt2 < 1) setTimeout(() => { if (t === waterToken) goParks(attempt2 + 1); }, 8000);
    }).catch(() => {});
  };
  setTimeout(() => { if (t === waterToken) goParks(0); }, 2100);
  // Паутина улиц — штатным дорожным загрузчиком (roads.js: гонка зеркал,
  // localStorage-кеш, тиры; ниже z13 сам режет до medium). Только на близких
  // окнах — см. WEB_MAX_WINDOW_M.
  if (windowM <= WEB_MAX_WINDOW_M) {
    setTimeout(() => { if (t === waterToken) fetchWeb(t, geo, windowM); }, 1400);
  }
}

/** Маска воды под текущее изделие. Ключ включает размер, иначе при смене формы
 *  штрих остался бы от прежнего диаметра и вода поехала бы по ширине.
 *  Слой попадает в маску только с совпадающей пропиской (см. cityGeoKey):
 *  во время драга прописка расходится с окном на каждом кадре, маски пустеют
 *  и канвы не растеризуются вовсе — линии возвращаются на отпускании. */
let maskRev = 0;   // ревизия СОДЕРЖИМОГО масок: ключ окна не меняется, когда
                   // слои доезжают в то же окно, — воркер различает по ревизии
function cityMasks(discMm) {
  if (state.surface !== 'city') return { water: null, major: null, web: null };
  const geo = cityGeoKey();
  const { zt, cw } = windowSpec(view.mz);
  const windowM = cw * metersPerPx(view.lat, zt);
  const key = `${geo}/${discMm}`;
  if (key !== waterKey) {
    waterFn = (waterGeo === geo && waterEls && waterEls.length)
      ? waterMask(waterEls, view.lat, view.lon, windowM, { zoom: 0.55, discMm }) : null;
    arteryFn = (arteryGeo === geo && arteryEls && arteryEls.length)
      ? arteryMask(arteryEls, view.lat, view.lon, windowM, { zoom: 0.55, discMm }) : null;
    // порог паутины масштабируется ДИАМЕТРОМ монеты: на S (11.2 мм) те же
    // штрихи относительно жирнее, и просветы улиц схлопываются раньше —
    // «каша, ничего не понятно» на S при окне, где L ещё читается (20.08)
    const webMax = WEB_MAX_WINDOW_M * discMm / 15.2;
    webFn = (webGeo === geo && windowM <= webMax)
      ? webMask(cityRoads, view.lat, view.lon, windowM, { zoom: 0.55, discMm }) : null;
    parksFn = (parksGeo === geo && parksEls && parksEls.length)
      ? parksMask(parksEls, view.lat, view.lon, windowM, { zoom: 0.55, discMm }) : null;
    // здания: только на близких окнах — дальше их подъём мельче фаски
    const buildsMax = 6000 * discMm / 15.2;
    buildsFn = (buildsGeo === geo && buildsEls && buildsEls.length && windowM <= buildsMax)
      ? buildingsMask(buildsEls, view.lat, view.lon, windowM, { zoom: 0.55, discMm }) : null;
    waterKey = key;
    maskRev++;
  }
  return { water: waterFn, major: arteryFn, web: webFn, parks: parksFn, builds: buildsFn };
}

function refetchRoads() {
  if (state.surface !== 'roads') return;
  const t = ++roadsToken;
  setRoadsStatus('loading');
  fetchRoads(view.lat, view.lon, view.mz, state.detail)
    .then(list => {
      if (t !== roadsToken) return;
      roads = list;
      setRoadsStatus(list.length ? 'ready' : 'empty');
      rebuild();
    })
    .catch(() => { if (t === roadsToken) setRoadsStatus(roads && roads.length ? 'ready' : 'error'); });
}
function setRoadsStatus(s) {
  const el = $('ctor-roads-status');
  const msg = {
    loading: 'Загружаем дороги…',
    empty: 'В рамке нет дорог — сдвиньте или приблизьте карту',
    error: 'Дороги не загрузились — подвиньте карту, попробуем ещё раз',
  }[s];
  el.hidden = !msg;
  if (msg) el.textContent = msg;
}

let placeName = null, placeTimer = null;
function refreshPlaceName() {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(async () => {
    const lat = view.lat, lon = view.lon;
    const name = await placeNameOf(lat, lon);
    if (Math.abs(lat - view.lat) > 1e-6 || Math.abs(lon - view.lon) > 1e-6) return;   // view moved on
    placeName = name;
    $('ctor-place').textContent = name ? `${name} · ${view.lat.toFixed(3)}°, ${view.lon.toFixed(3)}°`
                                       : `${view.lat.toFixed(3)}°, ${view.lon.toFixed(3)}°`;
  }, 700);
}

function onView(phase) {
  $('ctor-bearing-val').textContent = Math.round(((view.bearing * 180 / Math.PI) % 360 + 360) % 360) + '°';
  $('ctor-bearing').value = Math.round(((view.bearing * 180 / Math.PI) % 360 + 360) % 360);
  scheduleHash();
  if (phase === 'end') { refreshPlaceName(); updateEngravePreview(); updateCityHint(); }
  if (phase === 'move') {
    fastMode = true;
    // Предзапрос города на паузе драга: пользователь примеривается к кадру
    // ~секунду до отпускания, и слои успевают в полёт (или в кеш) ДО release —
    // «ждать 30 секунд, чтобы карта появилась» (Арбак 19.08). Токены отсекают
    // применение к чужому окну, кеш переживает недолёт.
    clearTimeout(cityPrefetchT);
    if (state.surface === 'city') cityPrefetchT = setTimeout(() => refetchWater(), 600);
    const run = () => {
      hotLast = performance.now();
      hotTimer = null;
      if (!tryHot(refetch)) refetch();
    };
    if (hotTimer) return;
    // Город: горячая пересборка стоит 45-70 мс, а HOT_MS=25 ставил её спина к
    // спине — главный поток забивался целиком и карта вставала («сильно
    // лагает», 18.08). Линии в драге всё равно отцеплены, монета показывает
    // только фоновую волну — ей хватает нескольких обновлений в секунду.
    const cadence = state.surface === 'city' ? 180 : HOT_MS;
    const wait = cadence - (performance.now() - hotLast);
    if (wait <= 0) run();
    else hotTimer = setTimeout(run, wait);
  } else {
    clearTimeout(hotTimer); hotTimer = null;
    clearTimeout(cityPrefetchT); cityPrefetchT = null;
    fastMode = false;
    if (!tryHot(refetch)) refetch();
    refetchRoads();   // gentle: only on drag end / jumps, never during 'move'
    refetchWater();
  }
}

/* ================= map ================= */
const mapApi = initMap($('ctor-map'), view, {
  onMove: onView,
  footprint: () => mapFootprint(state.form, state.weight, state.sizeMm),
});
window.__relefCtor.mapApi = mapApi;
$('ctor-zin').onclick = mapApi.zoomIn;
$('ctor-zout').onclick = mapApi.zoomOut;
$('ctor-compass').onclick = mapApi.resetBearing;
$('ctor-rotl').onclick = mapApi.rotateLeft;
$('ctor-rotr').onclick = mapApi.rotateRight;
$('ctor-bearing').oninput = e => mapApi.setBearing(+e.target.value * Math.PI / 180);
document.querySelectorAll('#ctor-mapmode button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#ctor-mapmode button').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel');
  mapApi.setBasemap(b.dataset.m);
});

/* preset chips */
const chips = $('ctor-presets');
for (const p of [...MTN_PRESETS, ...SEA_PRESETS]) {
  const b = document.createElement('button');
  b.className = 'ctor-chip';
  b.textContent = p.name;
  b.onclick = () => { mapApi.goTo(p.lat, p.lon, p.mz ?? 12); mapApi.setBearing((p.br ?? 0) * Math.PI / 180); };
  chips.appendChild(b);
}

/* search (Nominatim) */
let searchTimer = null;
$('ctor-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { $('ctor-sugg').style.display = 'none'; return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ru&q=${encodeURIComponent(q)}`);
      const list = await r.json();
      const box = $('ctor-sugg'); box.innerHTML = '';
      list.forEach(it => {
        const d = document.createElement('div');
        d.textContent = it.display_name;
        d.onclick = () => {
          box.style.display = 'none';
          $('ctor-search').value = it.display_name.split(',')[0];
          mapApi.goTo(+it.lat, +it.lon, 12);
        };
        box.appendChild(d);
      });
      box.style.display = list.length ? 'block' : 'none';
    } catch (err) { console.warn('geocode', err); }
  }, 400);
});
addEventListener('click', e => { if (!$('ctor-searchwrap').contains(e.target)) $('ctor-sugg').style.display = 'none'; });

/* ================= share hash ================= */
function hashOf() {
  return new URLSearchParams({
    f: state.form, w: state.weight, cl: state.closure, h: String(state.heightPct), d: state.detail,
    bp: String(state.basePct), sf: state.surface, sh: state.shoulder, b: state.band,
    e: state.engrave, et: state.engraveText, s: String(state.sizeMm), cc: String(state.chainCm), pm: state.pendMount,
    fin: state.finish,
    lat: view.lat.toFixed(5), lon: view.lon.toFixed(5), z: view.mz.toFixed(2), br: view.bearing.toFixed(3),
  }).toString();
}
let hashTimer = null;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, '', '#' + hashOf()), 300);
}
// earrings/pendant: the foundry gets the castable part only (coin + loops);
// the fastening is a bought fitting soldered on after casting
function exportGeoms() {
  return castGeoms || ringGroup.children.filter(m => !m.userData.skipExport).map(m => m.geometry);
}
function stlName() {
  const size = state.form === 'earrings' || state.form === 'pendant' ? 'cast' : `${state.sizeMm}mm`;
  return `relef-${state.form}-${state.weight}-${size}-${view.lat.toFixed(3)}_${view.lon.toFixed(3)}.stl`;
}
$('ctor-stl').onclick = () => {
  const geoms = exportGeoms();
  if (!geoms.length) return;
  downloadSTL(geoms, stlName());
};

$('ctor-share').onclick = async () => {
  window.relefGoal?.('share');
  const url = `${location.origin}${location.pathname}#${hashOf()}`;
  history.replaceState(null, '', '#' + hashOf());
  try { await navigator.clipboard.writeText(url); } catch (e) { console.warn(e); }
  $('ctor-toast').classList.add('show');
  setTimeout(() => $('ctor-toast').classList.remove('show'), 1800);
};

/* ================= controls wiring ================= */
function updateCityHint() {
  const el = $('ctor-buildhint');
  if (!el) return;
  if (state.surface !== 'city') { el.textContent = ''; return; }
  const { zt, cw } = windowSpec(view.mz);
  const windowM = cw * metersPerPx(view.lat, zt);
  const dm = state.form === 'pendant'
    ? 2 * (PEND_W[state.weight] || PEND_W.classic).R
    : 2 * (DISC_W[state.weight] || DISC_W.classic).R;
  const lim = 6000 * dm / 15.2;
  el.textContent = windowM <= lim
    ? `Дома в кадре: да (окно ${(windowM / 1000).toFixed(1)} км).`
    : `Дома появятся при окне до ${(lim / 1000).toFixed(1)} км — сейчас ${(windowM / 1000).toFixed(1)} км, приблизьте карту.`;
}
function updateProdInfo() {
  const fastening = state.form === 'earrings' ? ` · ${CLOSURE_LABEL[state.closure]}`
                  : state.form === 'pendant' ? ` · ${MOUNT_LABEL[state.pendMount]} · цепь ${state.chainCm} см` : '';
  const d = dimsOf(state.form, state.weight, state.sizeMm);
  $('ctor-prodname').textContent = `${FORM_LABEL[state.form]} · ${WEIGHT_LABEL[state.weight]} ${d.short}${fastening} · серебро 925`;
  $('ctor-dims').textContent = d.full.charAt(0).toUpperCase() + d.full.slice(1) + '.';
  updatePayUI();
}
// price follows form, weight and engraving; shown on the CTA and in the pay form
function updatePayUI() {
  const total = fmtRub(priceOf(state, view));
  $('ctor-orderbtn').textContent = `Предзаказ · ${total}`;
  $('ctor-total').textContent = total;
}
function selGroup(wrapId, key, cb) {
  document.querySelectorAll(`#${wrapId} [data-v]`).forEach(b => b.onclick = () => {
    if (b.disabled) return;
    document.querySelectorAll(`#${wrapId} [data-v]`).forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    state[key] = b.dataset.v;
    if (cb) cb();
    scheduleHash();
  });
  document.querySelectorAll(`#${wrapId} [data-v]`).forEach(b =>
    b.classList.toggle('sel', b.dataset.v === state[key]));
}
function formUI() {
  const signet = state.form === 'signet';
  const earrings = state.form === 'earrings';
  const pendant = state.form === 'pendant';
  $('ctor-basewrap').style.display = !signet && state.surface !== 'roads' ? '' : 'none';
  // город живёт на плоском лице: у печатки своя площадка со свипом, у серёг
  // 10-14 мм не хватает даже на одну реку при штрихе 0.5 мм
  $('ctor-surfacewrap').hidden = !(state.form === 'disc' || state.form === 'pendant');
  $('ctor-city-hint').hidden = state.surface !== 'city';
  // sections that make no sense for the chosen form disappear entirely
  $('ctor-sec-shoulder').hidden = !signet;
  $('ctor-sec-band').hidden = !signet;
  $('ctor-sec-size').hidden = earrings;
  $('ctor-closurewrap').hidden = !earrings;
  $('ctor-mountwrap').hidden = !pendant;
  $('ctor-chainwrap').hidden = !pendant;
  $('ctor-sizewrap').hidden = earrings || pendant;
  // every size option carries its real millimetres and its price for this form
  document.querySelectorAll('#ctor-weightsw [data-v]').forEach(b => {
    const v = b.dataset.v;
    b.innerHTML = `${WEIGHT_LABEL[v]}<span class="pill-dim">${dimsOf(state.form, v, state.sizeMm).short}</span>`
                + `<span class="pill-price">${fmtRub(PRICES[state.form][v])}</span>`;
  });
  updateEngravePreview();
  updateProdInfo();
  rebuildDots();
}

/* mobile: sections are horizontal snap slides; dots reflect and drive position */
const stepBody = document.querySelector('.ctor-stepbody');
const dotsWrap = $('ctor-dots');
const visibleSections = () =>
  [...stepBody.querySelectorAll('section[data-step]')].filter(s => !s.hidden);
let slideTarget = null;   // survives rapid clicks while the smooth scroll is mid-flight
stepBody.addEventListener('touchstart', () => { slideTarget = null; }, { passive: true });
stepBody.addEventListener('wheel', () => { slideTarget = null; }, { passive: true });
function goToSlide(i) {
  slideTarget = i;
  const left = i * stepBody.clientWidth;
  stepBody.scrollTo({ left, behavior: 'smooth' });
  // suspended tabs never run the smooth animation — settle hard just in case
  setTimeout(() => { if (slideTarget === i && Math.abs(stepBody.scrollLeft - left) > 4) stepBody.scrollLeft = left; }, 450);
}
const hoistedLabel = s => s.querySelector('.ctor-seclabel');
function rebuildDots() {
  dotsWrap.innerHTML = '';
  visibleSections().forEach((s, i) => {
    const d = document.createElement('button');
    d.className = 'ctor-dot';
    d.onclick = () => goToSlide(i);
    dotsWrap.appendChild(d);
    // mark the label the header now shows, so the slide can drop it
    const l = hoistedLabel(s);
    if (l) l.classList.add('hoisted');
  });
  paintDots();
}
function paintDots() {
  const n = dotsWrap.children.length;
  if (!n) return;
  const idx = Math.min(n - 1, Math.max(0, Math.round(stepBody.scrollLeft / Math.max(1, stepBody.clientWidth))));
  [...dotsWrap.children].forEach((d, i) => {
    d.classList.toggle('on', i === idx);
    d.classList.toggle('done', i < idx);   // where you have been vs where you are
  });
  // the sheet header carries the step, so the slides do not have to
  const sec = visibleSections()[idx];
  const label = sec && hoistedLabel(sec);
  $('ctor-steptitle').textContent =
    label ? label.textContent.trim() : (sec && sec.dataset.title) || '';
  // mobile footer: Далее drives the flow, the pay CTA appears on the last step
  $('ctor-footrow').classList.toggle('atend', idx >= n - 1);
  $('ctor-footrow').classList.toggle('atstart', idx === 0);
}
stepBody.addEventListener('scroll', () => requestAnimationFrame(paintDots), { passive: true });

/* mobile: the controls live in a sheet you can drag down to look at the piece.
   Snaps to three heights — collapsed (handle + CTA row, the render gets the
   screen), default, and tall for the long steps. Collapsed never hides the CTA
   row, so there is no state where the next/pay button is out of reach. */
const app = document.querySelector('.ctor-app');
const panel = document.querySelector('.ctor-panel');
const grab = $('ctor-grab');
const isSheet = () => getComputedStyle(grab).display !== 'none';
function snapPoints() {
  const h = app.clientHeight;
  const foot = document.querySelector('.ctor-stepfoot').offsetHeight;
  const info = document.querySelector('.ctor-prodinfo').offsetHeight;
  // collapsed still shows the handle, the summary and the CTA row.
  // 0.66 keeps the render about the size it always was — the point of the sheet
  // is that you can pull it down when you want to look, not a bigger default.
  return [grab.offsetHeight + info + foot, Math.round(h * 0.66), Math.round(h * 0.88)];
}
let settleTimer = 0;
function setSheet(px, instant) {
  // during a drag the class is already on, so do not thrash a reflow per frame
  const already = app.classList.contains('sheet-moving');
  if (instant && !already) app.classList.add('sheet-moving');
  app.style.setProperty('--sheet', px + 'px');
  if (instant) {
    if (!already) { void app.offsetHeight; app.classList.remove('sheet-moving'); }
    return;
  }
  /* A suspended tab never advances the transition, the same trap goToSlide
     guards against — land it by hand if it has not arrived. */
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (Math.abs(panel.offsetHeight - px) < 2) return;
    app.classList.add('sheet-moving');
    void app.offsetHeight;
    app.classList.remove('sheet-moving');
    sizeSoon(true);
  }, 420);
}
/* The canvas is not resized on every drag frame — reallocating the drawing
   buffer at touch rate stutters on a phone, the same reason the map drag has a
   fast path. Throttled while moving, exact once it settles. */
let sizePending = 0;
function sizeSoon(now) {
  if (now) { clearTimeout(sizePending); sizePending = 0; sizeStage(); return; }
  if (!sizePending) sizePending = setTimeout(() => { sizePending = 0; sizeStage(); }, 90);
}
let dragFrom = null;
grab.addEventListener('pointerdown', e => {
  if (!isSheet()) return;
  dragFrom = { y: e.clientY, h: panel.offsetHeight, moved: false };
  grab.setPointerCapture(e.pointerId);
  app.classList.add('sheet-moving');
});
grab.addEventListener('pointermove', e => {
  if (!dragFrom) return;
  const snaps = snapPoints();
  const next = Math.min(snaps[2], Math.max(snaps[0], dragFrom.h - (e.clientY - dragFrom.y)));
  if (Math.abs(e.clientY - dragFrom.y) > 4) dragFrom.moved = true;
  setSheet(next, true);   // the finger is the animation
  sizeSoon(false);
});
function endDrag(e) {
  if (!dragFrom) return;
  const snaps = snapPoints();
  // a tap with no travel toggles instead of snapping back to where it started
  let target;
  if (!dragFrom.moved) {
    target = panel.offsetHeight <= snaps[0] + 8 ? snaps[1] : snaps[0];
  } else {
    const h = panel.offsetHeight;
    target = snaps.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
  }
  dragFrom = null;
  app.classList.remove('sheet-moving');
  setSheet(target);
  if (e) { try { grab.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ } }
}
grab.addEventListener('pointerup', endDrag);
grab.addEventListener('pointercancel', endDrag);
panel.addEventListener('transitionend', e => { if (e.propertyName === 'height') sizeSoon(true); });
addEventListener('resize', () => { if (isSheet()) { setSheet(snapPoints()[1]); sizeSoon(false); } });
// resolve the CSS placeholder to px up front so the first drag has the same
// base the snaps are computed from — no animation on the very first paint
if (isSheet()) { setSheet(snapPoints()[1], true); sizeStage(); }
const curSlide = () => slideTarget ?? Math.round(stepBody.scrollLeft / Math.max(1, stepBody.clientWidth));
$('ctor-nextbtn').onclick = () => goToSlide(Math.min(curSlide() + 1, visibleSections().length - 1));
$('ctor-prevbtn').onclick = () => {
  // stepping back off the checkout slide returns to the design
  if (!$('ctor-orderform').hidden) { $('ctor-orderback').onclick(); return; }
  goToSlide(Math.max(curSlide() - 1, 0));
};
selGroup('ctor-formsw', 'form', () => { formUI(); mapApi.draw(); interact(); });
selGroup('ctor-weightsw', 'weight', () => { updateProdInfo(); mapApi.draw(); interact(); });
selGroup('ctor-closuresw', 'closure', () => { updateProdInfo(); interact(); });
selGroup('ctor-mountsw', 'pendMount', () => { updateProdInfo(); interact(); });
selGroup('ctor-detailsw', 'detail', () => { reprocess(); if (state.surface === 'roads') refetchRoads(); });
selGroup('ctor-surfacesw', 'surface', () => { formUI(); refetchWater(); interact(); updateCityHint(); });
selGroup('ctor-finishsw', 'finish', applyFinish);   // материалы, геометрия не пересобирается
selGroup('ctor-shouldersw', 'shoulder', interact);
selGroup('ctor-bandsw', 'band', interact);

/* engraving */
function updateEngravePreview() {
  $('ctor-engravetext').style.display = state.engrave === 'custom' ? '' : 'none';
  const e = engraveLine(state, view);
  $('ctor-engrave-preview').textContent = e
    ? `Будет выгравировано: «${e.text}» — ${e.where}. +${ENGRAVE_PRICE.toLocaleString('ru-RU')} ₽ к заказу.`
    : 'Без гравировки.';
  updatePayUI();
}
selGroup('ctor-engravesw', 'engrave', () => { updateEngravePreview(); interact(); });
let engraveTimer = null;
$('ctor-engravetext').addEventListener('input', e => {
  state.engraveText = e.target.value.slice(0, 40);
  updateEngravePreview();
  scheduleHash();
  clearTimeout(engraveTimer);
  engraveTimer = setTimeout(rebuild, 350);
});

const relief = $('ctor-relief');
relief.value = state.heightPct;
function paintSlider(el) {
  el.style.background = `linear-gradient(to right, var(--ink) ${el.value / el.max * 100}%, var(--line) ${el.value / el.max * 100}%)`;
}
paintSlider(relief);
relief.oninput = () => { state.heightPct = +relief.value; paintSlider(relief); interact(); scheduleHash(); };

const baseEl = $('ctor-base');
baseEl.value = state.basePct;
paintSlider(baseEl);
baseEl.oninput = () => {
  state.basePct = +baseEl.value;
  $('ctor-base-val').textContent = state.basePct + '%';
  paintSlider(baseEl); interact(); scheduleHash();
};
$('ctor-base-val').textContent = state.basePct + '%';

/* size select */
const sizeSel = $('ctor-size');
SIZES_MM.forEach(s => {
  const o = document.createElement('option');
  o.value = s; o.textContent = s.toFixed(1);
  sizeSel.appendChild(o);
});
sizeSel.value = state.sizeMm;
// nearest EU/UK equivalents for the chosen inner diameter
const EU = []; for (let n = 44; n <= 76; n++) EU.push({ label: String(n), dia: n / Math.PI });
const UKT = []; const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
for (let i = 0; i < 26; i++) {
  UKT.push({ label: L[i], dia: 11.92 + i * 0.405 });
  UKT.push({ label: L[i] + '½', dia: 11.92 + i * 0.405 + 0.2025 });
}
const nearest = (t, dia) => t.reduce((a, b) => Math.abs(b.dia - dia) < Math.abs(a.dia - dia) ? b : a);
function updateSizeInfo() {
  $('ctor-circ').textContent = (state.sizeMm * Math.PI).toFixed(1);
  $('ctor-sizeeq').textContent = `≈ EU ${nearest(EU, state.sizeMm).label} · UK ${nearest(UKT, state.sizeMm).label}`;
}
// the signet face scales with the finger size, so its millimetres follow it
sizeSel.onchange = e => { state.sizeMm = +e.target.value; updateSizeInfo(); updateProdInfo(); interact(); scheduleHash(); };
updateSizeInfo();

/* chain length (pendant): bought fitting, no rebuild needed */
const chainSel = $('ctor-chain');
chainSel.value = state.chainCm;
chainSel.onchange = e => { state.chainCm = +e.target.value; updateProdInfo(); scheduleHash(); };

/* ================= order dispatch (Telegram share sheet or mail client) ================= */
// NE ROVNO-style design summary shown at the top of the checkout slide
// Every value below is escaped: engraveText is typed by the visitor and placeName
// comes from the geocoder, and this markup is re-rendered in the OWNER's browser
// when the admin opens a client design by share-hash — where ADMIN_TOKEN sits in
// localStorage. Unescaped it is a stored-XSS path straight to that token.
const escHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function orderSummaryHTML() {
  const rows = [];
  const add = (k, v) => rows.push(`<div class="os-row"><span>${escHtml(k)}</span><b>${escHtml(v)}</b></div>`);
  add('Модель', `${FORM_LABEL[state.form]} · размер ${WEIGHT_LABEL[state.weight]}`);
  add('Габариты', dimsOf(state.form, state.weight, state.sizeMm).full);
  if (state.form === 'earrings') add('Закрепка', CLOSURE_LABEL[state.closure]);
  if (state.form === 'pendant') { add('Закрепка', MOUNT_LABEL[state.pendMount]); add('Цепь', `${state.chainCm} см`); }
  add('Место', `${placeName ? placeName + ' · ' : ''}${view.lat.toFixed(4)}°, ${view.lon.toFixed(4)}°`);
  add('Рельеф', `${(1 + 4 * state.heightPct / 100).toFixed(1)} мм`);
  if (state.form === 'signet') { add('Плечи', SHOULDER_LABEL[state.shoulder]); add('Шинка', BAND_LABEL[state.band]); }
  const e = engraveLine(state, view);
  add('Надпись', e ? `«${e.text}»` : 'без');
  if (state.form === 'disc' || state.form === 'signet') add('Размер', `${state.sizeMm} (RU)`);
  add('Расчётный вес', `${lastGrams.toFixed(1)} г${state.form === 'earrings' ? ' (пара)' : ''}`);
  return rows.join('');
}
// the checkout shows what actually arrives: the piece and the box it ships in
const SHOT_BY_FORM = { pendant: 'shop-pendant', earrings: 'p-aipetri-earrings', signet: 'p-elbrus-signet', disc: 'p-elbrus-disc' };
$('ctor-orderbtn').onclick = () => {
  window.relefGoal?.('order_open');
  warmupManifold();   // STL уедет вместе с заявкой — греем WASM заранее
  $('ctor-shot-form').src = `/assets/img/relef/${SHOT_BY_FORM[state.form] || SHOT_BY_FORM.disc}.jpg`;
  $('ctor-ordersum').innerHTML = orderSummaryHTML();
  $('ctor-orderbtn').hidden = true;
  $('ctor-sec-order').hidden = false;
  $('ctor-orderform').hidden = false;
  rebuildDots();
  if (matchMedia('(max-width: 809.98px)').matches) goToSlide(visibleSections().length - 1);
  else $('ctor-orderform').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
$('ctor-orderback').onclick = () => {
  $('ctor-orderform').hidden = true;
  $('ctor-sec-order').hidden = true;
  $('ctor-orderbtn').hidden = false;
  rebuildDots();
};
// Заявка сначала пробует серверный endpoint (надёжный путь: ничего не зависит
// от почтового клиента пользователя); без него — фолбэк через mailto/TG-share
// плюс видимый «скопировать текст»: молча потерянных заявок быть не должно.
let lastOrderTextForCopy = '';
function showOrderDone(mode) {
  $('ctor-orderform').hidden = true;
  $('ctor-orderdone').hidden = false;
  $('ctor-orderbtn').hidden = true;
  $('ctor-done-api').hidden = mode !== 'api';
  $('ctor-done-local').hidden = mode !== 'local';
  $('ctor-copyorder').hidden = mode !== 'local';
  $('ctor-done-hint').hidden = mode !== 'local';
}
$('ctor-copyorder').onclick = async () => {
  try { await navigator.clipboard.writeText(lastOrderTextForCopy); } catch (err) { console.warn(err); }
  $('ctor-copyorder').textContent = 'Скопировано';
  setTimeout(() => { $('ctor-copyorder').textContent = 'Скопировать текст заявки'; }, 1800);
};
$('ctor-orderform').addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const shareUrl = `${location.origin}${location.pathname}#${hashOf()}`;
  const contact = (fd.get('contact') || '').toString().trim();
  const text = orderText({
    state, view, grams: lastGrams, placeName, shareUrl,
    name: (fd.get('name') || '').toString().trim(),
    channel: fd.get('channel'), contact,
  });
  lastOrderTextForCopy = text;
  window.relefGoal?.('order_submit');
  const via = e.submitter && e.submitter.dataset.via;
  const fallback = () => {
    if (via === 'tg' && window.RELEF_ORDER_TG) sendViaTelegram(text, shareUrl);
    else sendViaMail(text);
    showOrderDone('local');
  };
  if (window.RELEF_ORDER_ENDPOINT) {
    const btn = e.submitter || $('ctor-orderform').querySelector('.ctor-orderbtn-main');
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    (async () => {
      const fd2 = new FormData();
      fd2.set('text', text);
      fd2.set('contact', contact);
      // наряд для литейки: та же спецификация без имён/цен — подпись STL
      fd2.set('jeweler', jewelerText({ state, view, grams: lastGrams, placeName }));
      // структурные поля для админ-панели (/admin/): статусы и карточка заявки
      fd2.set('name', (fd.get('name') || '').toString().trim());
      fd2.set('form', state.form);
      fd2.set('weight', state.weight);
      fd2.set('price', String(priceOf(state, view)));
      fd2.set('grams', lastGrams.toFixed(1));
      fd2.set('place', placeName || '');
      fd2.set('hash', hashOf());
      // honeypot: заполнено — на воркере заявка тихо отбрасывается
      fd2.set('website', (fd.get('website') || '').toString());
      // 152-ФЗ: факт согласия хранится вместе с заявкой (чекбокс required)
      fd2.set('consent', fd.get('consent') ? new Date().toISOString() : '');
      // STL едет вместе с заявкой: литейный файл готов сразу, без повторного
      // открытия дизайна. Не получилось собрать — заявка уходит без файла.
      try {
        const geoms = exportGeoms();
        if (geoms.length) {
          const { blob } = await stlForOrder(geoms);
          if (blob.size < 15 * 1024 * 1024) fd2.set('stl', blob, stlName());
        }
      } catch (err) { console.warn('order STL attach failed', err); }
      try {
        const r = await fetch(window.RELEF_ORDER_ENDPOINT, { method: 'POST', body: fd2 });
        if (!r.ok) throw new Error(`order endpoint HTTP ${r.status}`);
        const res = await r.json().catch(() => ({}));
        showOrderDone('api');
        if (res.n) {
          $('ctor-done-api').textContent =
            `Заявка ${res.n} принята — это ваш номер в очереди. Дизайн и цена зафиксированы; ответим в течение дня, платить пока ничего не нужно.`;
        }
      } catch (err) {
        console.warn('order endpoint failed, falling back', err);
        fallback();
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    })();
  } else fallback();
});

/* ================= boot ================= */
// STL is our production artifact (the foundry file), not a client feature:
// open the constructor once with #dev to latch the button on this browser
{
  const q0 = new URLSearchParams(location.hash.slice(1));
  if (q0.has('dev')) localStorage.setItem('relef.dev', '1');
  if (localStorage.getItem('relef.dev') === '1') $('ctor-stl').hidden = false;
}
if (!ROADS_ENABLED) {
  // сам ажур дорог запаркован, но выбор поверхности нужен городскому режиму
  const rb = document.querySelector('#ctor-surfacesw [data-v="roads"]');
  if (rb) rb.remove();
}
if (state.surface === 'city') refetchWater();
document.querySelectorAll('#ctor-engravesw [data-v]').forEach(b =>
  b.classList.toggle('sel', b.dataset.v === state.engrave));
$('ctor-engravetext').value = state.engraveText;
formUI();
mapApi.draw();
// металл на экране в первые кадры: болванка с плоскими высотами строится
// сразу, настоящий рельеф заместит её, когда доедут тайлы
proc = PLACEHOLDER_PROC;
rebuild();
refetch();
refreshPlaceName();
// Метрика: открытие конструктора + одно событие первого реального касания
// (клик/тап по панели или сцене) — по паре ctor_open/ctor_engaged видно,
// сколько зашедших начали собирать украшение.
window.relefGoal?.('ctor_open');
document.querySelector('.ctor-app')?.addEventListener('pointerdown',
  () => window.relefGoal?.('ctor_engaged'), { capture: true, once: true });
// Админ-удобство: /constructor/?dl=stl#<hash> сам отдаёт литейный файл, как
// только полный меш собран. Только на браузерах с dev-защёлкой — админка
// ставит её при входе, случайный посетитель параметр не активирует.
if (new URLSearchParams(location.search).get('dl') === 'stl'
    && localStorage.getItem('relef.dev') === '1') {
  const t0 = Date.now();
  const dlTimer = setInterval(() => {
    if (lastGrams > 0) {
      clearInterval(dlTimer);
      setTimeout(() => {
        const geoms = exportGeoms();
        if (geoms.length) downloadSTL(geoms, stlName());
        const toast = $('ctor-toast');
        toast.textContent = 'STL скачан — файл для литейки';
        toast.classList.add('show');
        setTimeout(() => { toast.classList.remove('show'); toast.textContent = 'Ссылка скопирована'; }, 2600);
      }, 800);
    } else if (Date.now() - t0 > 60000) clearInterval(dlTimer);
  }, 400);
}
