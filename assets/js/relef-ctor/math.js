// Shared math for the constructor: sampling, easing, smoothing, mesh volume.

export const ss = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export function quadBez(p0, p1, p2, t) {
  const m = 1 - t;
  return [m * m * p0[0] + 2 * m * t * p1[0] + t * t * p2[0], m * m * p0[1] + 2 * m * t * p1[1] + t * t * p2[1]];
}

// y of a cubic bezier (0,0)-(p1)-(p2)-(1,1) for a given x, by arc walking
export function bezYforX(p1x, p1y, p2x, p2y, x, n = 96) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let px0 = 0, py0 = 0;
  for (let k = 1; k <= n; k++) {
    const t = k / n, m = 1 - t;
    const px = 3 * m * m * t * p1x + 3 * m * t * t * p2x + t ** 3;
    const py = 3 * m * m * t * p1y + 3 * m * t * t * p2y + t ** 3;
    if (px >= x) return py0 + (py - py0) * (x - px0) / Math.max(px - px0, 1e-9);
    px0 = px; py0 = py;
  }
  return 1;
}

export function smooth1d(arr, radius = 4) {
  const n = arr.length, out = new Array(n), l = 1 / (2 * (radius / 2) ** 2);
  for (let t = 0; t < n; t++) {
    let acc = 0, w = 0;
    for (let i = Math.max(0, t - radius); i <= Math.min(n - 1, t + radius); i++) {
      const g = Math.exp(-((i - t) ** 2) * l);
      acc += arr[i] * g; w += g;
    }
    out[t] = acc / w;
  }
  return out;
}

// separable box blur passes + unsharp mask to keep ridges crisp
/** Сглаживание + нерезкая маска. `sharpen` — усиление маски; 0 отключает её.
 *  Заострять поле осмысленно только когда сетка изделия читает рельеф ЧАЩЕ, чем
 *  его хранит источник: тогда маска возвращает детали, потерянные при
 *  передискретизации. Когда на отсчёт приходятся сотни метров (континентальный
 *  охват), та же маска превращает перепад между соседними ячейками DEM в иглу —
 *  нелитейную и цепляющую волосы на серьге. Масштаб считает вызывающий код. */
export function processHM(src, w, h, passes, sharpen = 0.7, structure = 0) {
  const a = Float32Array.from(src);
  const b = new Float32Array(a.length);
  const blur1 = (arr, tmp) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      tmp[y * w + x] = (arr[y * w + x0] + arr[y * w + x] + arr[y * w + x1]) / 3;
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      arr[y * w + x] = (tmp[y0 * w + x] + tmp[y * w + x] + tmp[y1 * w + x]) / 3;
    }
  };
  for (let p = 0; p < passes; p++) blur1(a, b);
  if (sharpen <= 0 && structure <= 0) return a;
  // Две полосы нерезкой маски: sharpen возвращает самые тонкие детали
  // (base - blur1), structure поднимает СРЕДНЮЮ частоту (blur1 - blur3) —
  // морщины и рёбра скал, из которых складывается «скалистость» рельефа;
  // одиночный тонкий unsharp этой полосы не касался, и склоны выходили
  // обмылками рядом с конкурентными рендерами (сравнение 20.08).
  const base = Float32Array.from(a);
  blur1(a, b);                                   // a = blur1
  const b1 = Float32Array.from(a);
  blur1(a, b); blur1(a, b);                      // a = blur3
  for (let i = 0; i < a.length; i++) {
    a[i] = base[i] + sharpen * (base[i] - b1[i]) + structure * (b1[i] - a[i]);
  }
  return a;
}

// bilinear sampler over a w*h float grid, u/v in [0,1]
export function makeSampler(data, w, h) {
  return (u, v) => {
    const x = Math.min(Math.max(u, 0), 1) * (w - 1);
    const y = Math.min(Math.max(v, 0), 1) * (h - 1);
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0, fy = y - y0;
    const a = data[y0 * w + x0], b = data[y0 * w + x1], c = data[y1 * w + x0], d = data[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

// screen offset -> map offset under bearing: m = R(-bearing)*s (y-down)
export function rotator(bearing) {
  const c = Math.cos(bearing), s = Math.sin(bearing);
  return (a, b) => [a * c + b * s, -a * s + b * c];
}

// map-frame fraction -> screen fraction under bearing: s = R(bearing)*m (y-down)
export function screenRotator(bearing) {
  const c = Math.cos(bearing), s = Math.sin(bearing);
  return (fx, fy) => [fx * c - fy * s, fx * s + fy * c];
}

export function meshVolume(geom) {
  const p = geom.getAttribute('position').array, ix = geom.getIndex().array;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return Math.abs(v);
}
