// Reconstrucción de degradados lineales a partir de bandas de color.
//
// Parte de una imagen ya etiquetada con una paleta (cada píxel → índice de color) y de la imagen
// original. Fusiona etiquetas vecinas de tono parecido SOLO si los píxeles originales de la unión
// se explican bien con un perfil de color a lo largo de una dirección (= un linearGradient).
// Así un degradado se vuelve una forma con un gradiente, y dos colores planos distintos no se funden.

const BINS = 8;
const TRIM = 0.92; // se descartan los píxeles peor ajustados (bordes antialias) al evaluar el ajuste

const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function lab([r, g, b]) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** Ajusta color = f(t) con t = g·(p - m); g sale de una regresión lineal por canal reducida a rango 1. */
function fitProfile(src, w, idx) {
  const n = idx.length;
  if (n < 200) return null;
  let mx = 0, my = 0;
  for (const i of idx) { mx += i % w; my += (i / w) | 0; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  const sxc = [0, 0, 0], syc = [0, 0, 0], mc = [0, 0, 0];
  for (const i of idx) for (let c = 0; c < 3; c++) mc[c] += src[i * 4 + c];
  for (let c = 0; c < 3; c++) mc[c] /= n;
  for (const i of idx) {
    const x = (i % w) - mx, y = ((i / w) | 0) - my;
    sxx += x * x; sxy += x * y; syy += y * y;
    for (let c = 0; c < 3; c++) { const d = src[i * 4 + c] - mc[c]; sxc[c] += x * d; syc[c] += y * d; }
  }
  const det = sxx * syy - sxy * sxy;
  if (det < 1e-6 * (sxx + syy) ** 2) return null;
  // pendientes (ax, ay) por canal → matriz 3x2; dirección principal de MtM
  let a = 0, b = 0, d2 = 0;
  for (let c = 0; c < 3; c++) {
    const ax = (sxc[c] * syy - syc[c] * sxy) / det, ay = (syc[c] * sxx - sxc[c] * sxy) / det;
    a += ax * ax; b += ax * ay; d2 += ay * ay;
  }
  const th = 0.5 * Math.atan2(2 * b, a - d2);
  const g = [Math.cos(th), Math.sin(th)];

  const t = new Float64Array(n);
  for (let k = 0; k < n; k++) t[k] = g[0] * ((idx[k] % w) - mx) + g[1] * (((idx[k] / w) | 0) - my);
  const sorted = Float64Array.from(t).sort();
  const tmin = sorted[Math.floor(n * 0.01)], tmax = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
  if (tmax - tmin < 4) return null;

  let keep = null;
  let prof = null, rmse = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const sum = Array.from({ length: BINS }, () => [0, 0, 0, 0]);
    for (let k = 0; k < n; k++) {
      if (keep && !keep[k]) continue;
      const bi = Math.min(BINS - 1, Math.max(0, Math.floor(((t[k] - tmin) / (tmax - tmin)) * BINS)));
      const s = sum[bi], p = idx[k] * 4;
      s[0] += src[p]; s[1] += src[p + 1]; s[2] += src[p + 2]; s[3]++;
    }
    prof = [];
    for (let bi = 0; bi < BINS; bi++) if (sum[bi][3] >= 3) prof.push({ t: tmin + ((bi + 0.5) / BINS) * (tmax - tmin), c: [sum[bi][0] / sum[bi][3], sum[bi][1] / sum[bi][3], sum[bi][2] / sum[bi][3]] });
    if (prof.length < 2) return null;
    const at = (tv) => {
      if (tv <= prof[0].t) return prof[0].c;
      for (let j = 1; j < prof.length; j++) if (tv <= prof[j].t) {
        const u = (tv - prof[j - 1].t) / (prof[j].t - prof[j - 1].t);
        return prof[j - 1].c.map((v, c) => v + (prof[j].c[c] - v) * u);
      }
      return prof.at(-1).c;
    };
    const err = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const m = at(t[k]), p = idx[k] * 4;
      err[k] = ((src[p] - m[0]) ** 2 + (src[p + 1] - m[1]) ** 2 + (src[p + 2] - m[2]) ** 2) / 3;
    }
    const cut = Float64Array.from(err).sort()[Math.floor(n * TRIM)];
    keep = new Uint8Array(n);
    let s = 0, cnt = 0;
    for (let k = 0; k < n; k++) if (err[k] <= cut) { keep[k] = 1; s += err[k]; cnt++; }
    rmse = Math.sqrt(s / cnt);
  }
  const dist = Math.hypot(...prof[0].c.map((v, c) => v - prof.at(-1).c[c]));
  return { rmse, range: dist, g, m: [mx, my], tmin, tmax, prof };
}

/**
 * @param {Uint8Array|Buffer} src RGBA original (sin cuantizar)
 * @param {Uint8Array} labels índice de paleta por píxel (255 = transparente)
 * @returns {{groups: {members:number[], rep:number, fit:object}[]}}
 */
export function findGradientGroups({ src, labels, palette, w, h, maxRmse = 6, minRange = 14, sampleN = 80000 }) {
  const K = palette.length, n = w * h;
  const stride = Math.max(1, Math.floor(n / sampleN));
  const samples = Array.from({ length: K }, () => []);
  const count = new Array(K).fill(0);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l === 255) continue;
    count[l]++;
    if (i % stride === 0) samples[l].push(i);
  }
  const adj = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l === 255) continue;
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0) continue;
        const m = labels[j];
        if (m === 255 || m === l) continue;
        const key = l < m ? l * K + m : m * K + l;
        adj.set(key, (adj.get(key) ?? 0) + 1);
      }
    }
  }
  const labs = palette.map(lab);
  const chroma = labs.map(([, a, b]) => Math.hypot(a, b));
  const pairs = [];
  for (const [key, c] of adj) {
    const a = Math.floor(key / K), b = key % K;
    if (c < 15 || chroma[a] < 8 || chroma[b] < 8) continue;
    const dab = Math.hypot(labs[a][1] - labs[b][1], labs[a][2] - labs[b][2]);
    if (dab > 30) continue;
    pairs.push({ a, b, d: Math.hypot(labs[a][0] - labs[b][0], dab) });
  }
  pairs.sort((p, q) => p.d - q.d);

  const parent = Array.from({ length: K }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const members = Array.from({ length: K }, (_, i) => [i]);
  const fits = new Array(K).fill(null);
  for (const { a, b } of pairs) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    const all = [...members[ra], ...members[rb]];
    const fit = fitProfile(src, w, all.flatMap((l) => samples[l]));
    if (!fit || fit.rmse > maxRmse || fit.range < minRange) continue;
    parent[rb] = ra;
    members[ra] = all;
    fits[ra] = fit;
  }
  const groups = [];
  for (let k = 0; k < K; k++) {
    if (find(k) !== k || members[k].length < 2 || !fits[k]) continue;
    const rep = members[k].reduce((best, l) => (count[l] > count[best] ? l : best), members[k][0]);
    groups.push({ members: members[k], rep, fit: fits[k] });
  }
  return { groups };
}

/** Sustituye el color plano representante de cada grupo por un linearGradient. */
export function applyGradients(svg, groups, palette) {
  if (!groups.length) return { svg, count: 0 };
  const defs = [];
  const byColor = new Map();
  groups.forEach((g, i) => {
    const { m, g: dir, tmin, tmax, prof } = g.fit;
    const id = `g${i + 1}`;
    const p1 = [m[0] + dir[0] * tmin, m[1] + dir[1] * tmin], p2 = [m[0] + dir[0] * tmax, m[1] + dir[1] * tmax];
    const stops = [{ o: 0, c: prof[0].c }, ...prof.map((s) => ({ o: (s.t - tmin) / (tmax - tmin), c: s.c })), { o: 1, c: prof.at(-1).c }]
      .map((s) => ({ ...s, o: Math.min(1, Math.max(0, s.o)) }));
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${p1[0].toFixed(1)}" y1="${p1[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}">${stops.map((s) => `<stop offset="${s.o.toFixed(3)}" stop-color="${hex(s.c)}"/>`).join('')}</linearGradient>`);
    byColor.set(hex(palette[g.rep]), id);
  });
  const norm = (c) => (c.length === 4 ? '#' + [...c.slice(1)].map((h) => h + h).join('') : c).toLowerCase();
  const out = svg
    .replace(/(fill|stroke)="(#[0-9a-fA-F]{3,6})"/g, (whole, attr, c) => (byColor.has(norm(c)) ? `${attr}="url(#${byColor.get(norm(c))})"` : whole))
    .replace(/<svg([^>]*)>/, (m) => `${m}<defs>${defs.join('')}</defs>`);
  return { svg: out, count: groups.length };
}
