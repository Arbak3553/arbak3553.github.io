// Disc ring geometry: terrain coin on a wire band (relf disc v2 pipeline).
// './three.js', not bare 'three': the geometry modules also run inside the
// build worker, and module workers do not see the page's import map
import * as THREE from './three.js';
import { ss } from './math.js';

// product decision (Arbak, 27.07.2026): the coin base slimmed from the prototype's
// 1.5/1.9/2.4 — the RELIEF forms the disc's body now, the plate is just a casting
// back (>=0.8mm invariant); the thick straight side wall read as "puck with garnish"
export const DISC_W = {
  subtle:    { R: 5.6, T: 1.0, minor: 0.80 },
  classic:   { R: 6.5, T: 1.2, minor: 0.95 },
  statement: { R: 7.6, T: 1.4, minor: 1.10 },
};

// How far the coin's underside drops below the tube's apex.
//
// The only real ceiling is the plate cover: the apex must stay buried, or it
// surfaces through the coin's face. The old formula also capped at `minor`,
// which looked like a geometric limit but is not one — the tube dives away
// from the coin long before its rim (at R=5.6 the torus centreline is already
// ~2mm below the coin's underside), so a deeper sink just hides more band
// instead of exposing it. That cap was the binding one and it froze the coin
// where it sat; dropping it, plus thinner cover, is what "чуть ниже опустить"
// (Arbak, 06.08.2026) actually needs. Cover is backed by the tube itself, so
// it is not a free-standing wall — the 0.8mm relief invariant does not apply.
//
// Hard floor for any future change: embed <= 2*minor, where the coin's
// underside reaches the band's inner surface, i.e. the finger circle.
const APEX_COVER = 0.15;
export function discEmbed(wk) {
  const { T, minor } = DISC_W[wk] || DISC_W.classic;
  return Math.min(2 * minor, T - APEX_COVER);
}

// Ограничитель уклона рельефа.
//
// Береговая линия в карте высот — настоящий обрыв: океан жёстко приведён к нулю
// (cropWindow), суша начинается со следующего отсчёта. На горном кадре это не
// заметно, а на широком охвате (остров, полуостров, регион) те же ~2 мм подъёма
// приходятся на доли миллиметра диска, и рельеф вырождается в иглы: литьё их не
// проливает, а на серьге они цепляют волосы. Сглаживание данных тут бессильно —
// оно бьётся с амплитудой, а не с крутизной.
//
// Поэтому ограничиваем не данные, а уклон В МИЛЛИМЕТРАХ НА ИЗДЕЛИИ: соседние узлы
// не могут отличаться больше, чем tan(MAX_SLOPE) на расстояние между ними. Правим
// ТОЛЬКО вниз — так игла становится конусом с внятными склонами, объём не растёт,
// а затухание рельефа к бортику остаётся нетронутым. На горных кадрах уклоны
// заведомо мягче порога, и геометрия не меняется вовсе.
// Глубины канавок городского режима, три языка линий («реки углубить, дороги
// видны» — Арбак 17.08). Все ограничены инвариантом «под канавкой >= 0.8 мм
// плиты»: на T=1.4 доступно 0.6, на T=1.2 — 0.4, на T=1.0 — 0.2.
// Вода глубже всех — тёмная лента с настоящей шириной русла из мультиполигона.
// Магистраль мельче воды НАМЕРЕННО: на пересечении её срез проходит НАД дном
// русла — полка поперёк реки, которая читается как мост.
// Паутина улиц — тонкая гравировка, по земле и никогда сквозь воду.
const WATER_DEPTH = 0.5;
const ROAD_DEPTH = 0.18;
const WEB_DEPTH = 0.09;
const PARK_DEPTH = 0.045;  // зернь зелени: матовое пятно, не канавка
const BUILD_H = 0.16;      // подъём застройки; этажность в яркости маски   // 0.06 при мягком профиле давал реальный рез ~0.04 и терялся;
                          // с обострённым профилем и запретом резать воду 0.09 держит иерархию

// Обострение профиля канавки. Размытие маски (фаска литья) размазывало глубину:
// линия тоньше пары пикселей маски не доставала и до половины номинала, а стенки
// выходили пологими — «акварель». Ремап отдаёт полную глубину всему телу линии,
// фаска остаётся только на кромке (~пиксель маски, при 1024 это ~0.03 мм —
// достаточно, чтобы стенка не была строго вертикальной).
const crisp = m => ss(0.10, 0.60, m);

const MAX_SLOPE_DEG = 60;
const MAX_SLOPE = Math.tan(MAX_SLOPE_DEG * Math.PI / 180);
function limitSlope(h, RINGS, SEG, R) {
  const maxRad = MAX_SLOPE * (R / RINGS);
  for (let pass = 0; pass < 16; pass++) {
    let cut = 0;
    const fwd = pass % 2 === 0;                  // чередуем обход: иначе анизотропия
    for (let k = 0; k < RINGS; k++) {
      const i = fwd ? k : RINGS - 1 - k;
      const maxAng = MAX_SLOPE * (2 * Math.PI * (R * (i + 1) / RINGS) / SEG);
      for (let m = 0; m < SEG; m++) {
        const j = fwd ? m : SEG - 1 - m, j1 = (j + 1) % SEG;
        const d = h[i][j] - h[i][j1];
        if (d > maxAng) { h[i][j] = h[i][j1] + maxAng; cut++; }
        else if (-d > maxAng) { h[i][j1] = h[i][j] + maxAng; cut++; }
        if (i + 1 < RINGS) {
          const dr = h[i][j] - h[i + 1][j];
          if (dr > maxRad) { h[i][j] = h[i + 1][j] + maxRad; cut++; }
          else if (-dr > maxRad) { h[i + 1][j] = h[i][j] + maxRad; cut++; }
        }
      }
    }
    if (!cut) break;
  }
}

// normalize the sampled window so the relief always uses the full height budget
function patchNorm(zoom, hsample) {
  let smn = 1 / 0, smx = -1 / 0;
  for (let dy = 0; dy < 48; dy++) for (let dx = 0; dx < 48; dx++) {
    const h = hsample(0.5 + (dx / 47 - 0.5) * zoom, 0.5 + (dy / 47 - 0.5) * zoom);
    if (h < smn) smn = h; if (h > smx) smx = h;
  }
  const srng = Math.max(smx - smn, 1e-6);
  const fn = (u, v) => (hsample(u, v) - smn) / srng;
  fn.rangeM = srng;   // реальный перепад окна в метрах — нужен городскому режиму
  return fn;
}

// Городской фон: миллиметры от АБСОЛЮТНЫХ метров, а не от нормировки.
// patchNorm растягивает любой перепад на полный бюджет — для гор это и есть
// смысл продукта, но город у уровня моря (Питер: ~15 м на всё окно) превращается
// в шум масштаба канавок. Привязка 300 м перепада = полный городской бюджет:
// плоский город сам выходит полированным, холмистый (Нижний, Киев) держит волну.
const CITY_FULL_RANGE_M = 300;

// opts: { zoom, fH, basePct, zBandTop, wk, hsample, rot, dims?, lod? }
// dims overrides the coin size (the earring reuses the coin at its own diameters)
// lod < 1 coarsens the mesh for live drags; the released view rebuilds at lod 1
export function buildDisc(opts) {
  const { zoom, fH, basePct, zBandTop, wk, hsample, rot } = opts;
  const { R, T } = opts.dims || DISC_W[wk] || DISC_W.classic;
  const lod = opts.lod || 1;
  // явный opts.city держит городской фон (и плотность сетки) даже когда маски
  // временно пусты — во время драга слои отцеплены и без флага фон прыгал бы
  // в горную нормировку на каждое перетаскивание
  const cityMode = !!(opts.city || opts.water || opts.roadMajor || opts.roadWeb || opts.builds);
  // «Максимально детализировано» (Арбак, 20.08): база поднята в полтора раза
  // (288x164 — горный рельеф без фасеток на зеркале), город — 480x275
  // (ячейка ~0.10 мм на ободе statement: штрих паутины 0.16 мм ложится на
  // узлы с запасом, кромки канавок гладкие на макро-зуме). Константы ЕДИНЫ
  // для всех устройств: заказный STL не смеет зависеть от девайса покупателя.
  // Сборка в воркере — кадры этих цифр не чувствуют.
  const det = cityMode ? 2 : 1;   // город 576x330: ячейка ~0.083 мм на ободе
  const SEG = Math.max(64, Math.round(288 * det * lod)), RINGS = Math.max(36, Math.round(164 * det * lod));
  const H0 = fH * 0.85;
  // band sunk as deep as the thin plate allows so the tube's arc never pokes past the rim
  const Z_B = zBandTop - discEmbed(wk), Z_T = Z_B + T;
  const hf = patchNorm(zoom, hsample);
  // Город гравируется на ПОЛИРОВАННОЙ ПЛИТЕ: фоновая волна высот выключена
  // совсем — даже 0.07 мм ряби на зеркале читались «рельефом под картой»
  // и мешали слоям (Арбак, 20.08). Горы — в режиме «Рельеф».
  const Heff = cityMode ? 0 : H0;
  const sub = [];
  for (let dy = 0; dy < 48; dy++) for (let dx = 0; dx < 48; dx++)
    sub.push(hf(0.5 + (dx / 47 - 0.5) * zoom, 0.5 + (dy / 47 - 0.5) * zoom));
  const sorted = [...sub].sort((a, b) => a - b);
  const base = sorted[Math.floor(basePct * (sorted.length - 1))];
  const relief = (u, v) => Math.max(0, hf(u, v) - base) / Math.max(1 - base, 1e-6);
  const pos = [], rows = [];
  const push = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  // Высоты рельефа считаются отдельно от меша, чтобы ограничить уклон ДО сборки
  // треугольников — иначе иглы уезжают в STL и в литьё.
  const hgt = [], fades = [], uvs = [];
  for (let i = 1; i <= RINGS; i++) {
    const r = R * i / RINGS, row = [], uvrow = [];
    const fade = 1 - ss(0.88 * R, 0.985 * R, r);   // relief dies out before the rim
    for (let j = 0; j < SEG; j++) {
      const th = 2 * Math.PI * j / SEG, x = r * Math.cos(th), y = r * Math.sin(th);
      const [ra, rb] = rot((x / R) * 0.5 * zoom, -(y / R) * 0.5 * zoom);
      row.push(Heff * fade * relief(0.5 + ra, 0.5 + rb));
      uvrow.push(0.5 + ra, 0.5 + rb);
    }
    hgt.push(row); fades.push(fade); uvs.push(uvrow);
  }
  limitSlope(hgt, RINGS, SEG, R);
  // Вода режется канавкой ПОСЛЕ ограничителя уклона: иначе он примет её стенки
  // за иглы и размоет канавку в кратер. Глубина ограничена инвариантом — под
  // канавкой обязано остаться >= 0.8 мм плиты, поэтому на тонкой плите (T=1.0)
  // канавка мельче. Затухание к бортику общее с рельефом, чтобы вода не резала край.
  if (opts.water || opts.roadMajor || opts.roadWeb) {
    // близкие окна («сверх детали», 21.08): канавки глубже, здания выше —
    // карта ВЫБИВАЕТСЯ из плиты; инвариант плиты держит вода (максимум)
    const close = !!opts.close;
    const wDepth = Math.min(WATER_DEPTH, T - 0.8);
    const rDepth = Math.min(close ? 0.24 : ROAD_DEPTH, T - 0.8);
    const nDepth = Math.min(close ? 0.13 : WEB_DEPTH, T - 0.8);
    const pDepth = Math.min(PARK_DEPTH, T - 0.8);
    const bLift = close ? 0.24 : BUILD_H;
    if (wDepth > 0.02) {
      // Обострённая маска сама по себе квантуется на узлах меша: рампа фаски
      // (~0.03 мм) уже шага сетки, ребро попадает «или в узел, или мимо» и
      // диагонали рассыпаются лесенкой. Поэтому crisp усредняется по 9 отводам
      // (центр + крест + диагонали) в радиусе 0.75 ячейки: тело линии — полная
      // глубина, кромка — плавная фаска в полторы ячейки. Уже нельзя: смещение
      // задаётся по узлам, переход в одну ячейку скачет треугольниками и на
      // глянце металла читается пилой (поймано на макро-зуме 18.08).
      const uvmm = 0.5 * zoom / R;   // uv-единиц на мм изделия
      const D = Math.SQRT1_2;
      const aa = (fn, u, v, h, shape = crisp) => {
        if (!fn) return 0;
        let s = shape(fn(u, v));
        s += shape(fn(u + h, v)) + shape(fn(u - h, v)) + shape(fn(u, v + h)) + shape(fn(u, v - h));
        const d = h * D;
        s += shape(fn(u + d, v + d)) + shape(fn(u - d, v + d)) + shape(fn(u + d, v - d)) + shape(fn(u - d, v - d));
        return s / 9;
      };
      const raw = x => x;   // зернь парков НЕ обостряется — усредняется в мат
      for (let i = 0; i < RINGS; i++) {
        const r = R * (i + 1) / RINGS;
        const h = 0.75 * Math.max(2 * Math.PI * r / SEG, R / RINGS) * uvmm;
        for (let j = 0; j < SEG; j++) {
          const u = uvs[i][j * 2], v = uvs[i][j * 2 + 1];
          const mw = aa(opts.water, u, v, h);
          const ma = aa(opts.roadMajor, u, v, h);
          const mn = aa(opts.roadWeb, u, v, h);
          // застройка: контуры зданий ПОДНИМАЮТСЯ над плитой; улицы, вода и
          // дворы остаются на плите — город становится барельефом («3 и
          // 1.5 км — кварталы объёмами, здания силуэтами», 20.08)
          let lift = 0;
          if (opts.builds) {
            const mb = aa(opts.builds, u, v, h);
            if (mb > 0.02) lift = bLift * mb * Math.max(0, 1 - (mw * 3 + ma * 3 + mn * 2));
          }
          if (lift < 0.001 && mw < 0.01 && ma < 0.01 && mn < 0.01) continue;
          // Магистраль ВЫИГРЫВАЕТ у воды: на пересечении срез поднимается с
          // водяной глубины на дорожную — мост. Вес плавный, чтобы въезд
          // полки в русло шёл фаской, а не ступенькой в один сэмпл.
          const rw = Math.min(1, ma / 0.5);
          let cut = (wDepth * mw) * (1 - rw) + (rDepth * ma) * rw;
          // паутина — только по земле: в русле её гравировка невидима и лишь
          // мусорила бы дно реки
          if (mw < 0.1) cut = Math.max(cut, nDepth * mn);
          // зелень — самый нижний приоритет: матирует только чистую сушу,
          // аллеи и пруды режут сквозь неё своим языком
          if (opts.parks && lift < 0.001 && mw < 0.05 && ma < 0.05 && mn < 0.05) {
            const mp = aa(opts.parks, u, v, h, raw);
            if (mp > 0.02) cut = Math.max(cut, pDepth * mp);
          }
          hgt[i][j] += (lift - cut) * fades[i];
        }
      }
    }
  }
  // город: центр ложится по среднему первого кольца — «горная» формула с
  // min() проваливала его в воронку-кружок, если рядом с центром канавка
  // (поймано на Соколе, 21.08)
  const hc = cityMode
    ? hgt[0].reduce((a, b) => a + b, 0) / SEG
    : Math.min(Heff * relief(0.5, 0.5), Math.min(...hgt[0]) + MAX_SLOPE * (R / RINGS));
  const vc = push(0, 0, Z_T + hc);
  for (let i = 0; i < RINGS; i++) {
    const r = R * (i + 1) / RINGS, ring = [];
    for (let j = 0; j < SEG; j++) {
      const th = 2 * Math.PI * j / SEG;
      ring.push(push(r * Math.cos(th), r * Math.sin(th), Z_T + hgt[i][j]));
    }
    rows.push(ring);
  }
  for (const [rf, z] of [[1.0, Z_T - 0.15], [1.0, Z_B + 0.15], [0.985, Z_B]]) {
    const ring = [];
    for (let j = 0; j < SEG; j++) {
      const th = 2 * Math.PI * j / SEG;
      ring.push(push(R * rf * Math.cos(th), R * rf * Math.sin(th), z));
    }
    rows.push(ring);
  }
  // нижнее кольцо ДУБЛИРУЕТСЯ: если веер низа шарит вершины с бортиком,
  // их нормали усредняются со стенкой, и зеркальный низ рябит звездой
  // (поймано на ракурсе снизу, 20.08); дубль даёт чистую (0,0,-1) и
  // честную жёсткую кромку торца
  const bottomRing = [];
  for (let j = 0; j < SEG; j++) {
    const th = 2 * Math.PI * j / SEG;
    bottomRing.push(push(R * 0.985 * Math.cos(th), R * 0.985 * Math.sin(th), Z_B));
  }
  const vb = push(0, 0, Z_B);
  const idxFlat = [], idxRel = [];
  const zOf = i => pos[i * 3 + 2];
  const emit = (a, b, c) => { ((zOf(a) + zOf(b) + zOf(c)) / 3 > Z_T + 0.08 ? idxRel : idxFlat).push(a, b, c); };
  for (let j = 0; j < SEG; j++) emit(vc, rows[0][j], rows[0][(j + 1) % SEG]);
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    for (let j = 0; j < SEG; j++) {
      const j1 = (j + 1) % SEG;
      // диагональ квада чередуется в шахматном порядке: одинаковая ориентация
      // давала «ёлочку» фасет на стенках городских канавок — блик пилил
      // диагональные линии через треугольник (макро-зум 18.08)
      if ((i + j) % 2 === 0) { emit(a[j], b[j], b[j1]); emit(a[j], b[j1], a[j1]); }
      else { emit(b[j], b[j1], a[j1]); emit(b[j], a[j1], a[j]); }
    }
  }
  for (let j = 0; j < SEG; j++) {
    const j1 = (j + 1) % SEG;
    // юбка-мостик от последнего кольца бортика к дублю (нулевой ширины по
    // построению — координаты совпадают, но вершины разные) + чистый веер
    idxFlat.push(rows[rows.length - 1][j], bottomRing[j1], bottomRing[j]);
    idxFlat.push(rows[rows.length - 1][j], rows[rows.length - 1][j1], bottomRing[j1]);
    idxFlat.push(vb, bottomRing[j1], bottomRing[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([...idxFlat, ...idxRel]);
  g.addGroup(0, idxFlat.length, 0);
  g.addGroup(idxFlat.length, idxRel.length, 1);
  g.computeVertexNormals();
  return g;
}

export function buildWireBand(size, wk) {
  const minor = (DISC_W[wk] || DISC_W.classic).minor;
  const major = size / 2 + minor;
  // 56x200: на зеркальной полировке блик едет по трубе непрерывной лентой,
  // 48x160 на макро-зуме гранился
  const g = new THREE.TorusGeometry(major, minor, 56, 200);
  g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  return { geom: g, zTop: major + minor };
}

// Плечи: веретено-наплыв на верхней дуге шинки. Голая труба ныряла под
// монету, и у краёв диска между ними оставался воздушный клин — кольцо
// «плавало» («сильнее засунуть под диск, чтобы ободок был как будто
// внутри», Арбак 20.08; плечи заложены и в ТЗ кольца-диска). Профиль:
// у концов радиус равен трубе (минус волосок — сливается заподлицо, без
// z-fighting), к центру растёт в K раз; всё, что выше лица монеты,
// прижимается под лицо — срез невидим, юнион его съедает. Веретено
// замкнуто крышками: manifold-юниону нужны замкнутые входы.
export function buildBandCollar(size, wk) {
  const { R, T, minor } = DISC_W[wk] || DISC_W.classic;
  const M = size / 2 + minor;
  const zFace = M + minor - discEmbed(wk) + T;        // лицо монеты
  const thS = Math.asin(Math.min(0.97 * R / M, 0.9)); // наплыв до кромки диска
  const K = 1.5;
  const SEG_A = 72, SEG_P = 36;
  const pos = [], idx = [];
  for (let i = 0; i <= SEG_A; i++) {
    const th = -thS + 2 * thS * i / SEG_A;
    const blend = Math.cos(Math.PI * th / (2 * thS));
    const rr = minor * (0.985 + (K - 0.985) * blend * blend);
    const s = Math.sin(th), c = Math.cos(th);
    // центр сечения смещён НАРУЖУ на прирост радиуса: внутренняя кромка
    // всегда совпадает с трубой — наплыв не смеет сужать посадочный круг
    // (поймано: bore 17.45 вместо 18.0 на первом STL плечей)
    const cShift = rr - minor;
    for (let j = 0; j < SEG_P; j++) {
      const a = 2 * Math.PI * j / SEG_P;
      const ring = M + cShift + rr * Math.cos(a);
      let z = ring * c;
      if (z > zFace - 0.12) z = zFace - 0.12;
      pos.push(ring * s, rr * Math.sin(a), z);
    }
  }
  for (let i = 0; i < SEG_A; i++) {
    for (let j = 0; j < SEG_P; j++) {
      const j1 = (j + 1) % SEG_P;
      const a = i * SEG_P + j, b = (i + 1) * SEG_P + j;
      const a1 = i * SEG_P + j1, b1 = (i + 1) * SEG_P + j1;
      idx.push(a, b, b1, a, b1, a1);
    }
  }
  // крышки торцов (веретено чуть уже трубы — крышки спрятаны в ней).
  // Ориентация ПРОТИВ рёбер тела на граничном кольце, иначе ребро living
  // дважды в одной ориентации = не-манифолд, и юнион STL отказывает
  // (поймано: ManifoldError на первом же экспорте плечей)
  const mCap = M - 0.015 * minor;   // центр торца с тем же наружным сдвигом
  const capA = pos.length / 3; pos.push(mCap * Math.sin(-thS), 0, mCap * Math.cos(-thS));
  for (let j = 0; j < SEG_P; j++) idx.push(capA, j, (j + 1) % SEG_P);
  const capB = pos.length / 3; pos.push(mCap * Math.sin(thS), 0, mCap * Math.cos(thS));
  const base = SEG_A * SEG_P;
  for (let j = 0; j < SEG_P; j++) idx.push(capB, base + (j + 1) % SEG_P, base + j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // объём наплыва поверх трубы: полный минус труба на той же дуге —
  // превью-вес не должен считать пересечение дважды
  const overlap = Math.PI * minor * minor * M * 2 * thS;
  g.userData.addVol = Math.max(0, meshVol(g) - overlap);
  return g;
}
function meshVol(g) {
  const p = g.getAttribute('position').array, ix = g.getIndex().array;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return Math.abs(v);
}
