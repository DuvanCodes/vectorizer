// Cuantización a colores dominantes. A diferencia de un cuantizador genérico, los tonos de
// transición (antialiasing entre dos colores) NO reciben entrada propia: se asignan al dominante
// más cercano, de modo que el borde cae en el punto medio de la rampa (una isolínea suave).

const SAMPLE = 60000;
const MIN_POP = 0.0004; // bajo el 0.04% de los píxeles es ruido puro; lo demás lo filtran las reglas de abajo
const TRANSITION_POP = 0.03; // por debajo de esta población puede ser un color de transición
const MERGE_DIST = 14; // colores más cercanos que esto son el mismo para el ojo
const MINOR_POP = 0.015; // colores más raros que esto y cercanos a uno dominante son artefactos (anillos/croma JPEG)
const MINOR_DIST = 60;
const TRANSITION_DIST = 16; // distancia RGB máxima al segmento entre dos colores vecinos

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function buildPalette(rgba, k, { mergeDist = MERGE_DIST, minorPop = MINOR_POP, transition = true } = {}) {
  const n = rgba.length / 4;
  const stride = Math.max(1, Math.floor(n / SAMPLE));
  const pts = [];
  for (let i = 0; i < n; i += stride) if (rgba[i * 4 + 3] >= 128) pts.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  if (pts.length === 0) return [];
  const rand = rng(12345);
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  // k-means++ determinista
  const cs = [pts[Math.floor(rand() * pts.length)].slice()];
  const dist = pts.map((p) => d2(p, cs[0]));
  while (cs.length < Math.min(k, pts.length)) {
    let sum = 0;
    for (const v of dist) sum += v;
    if (sum === 0) break;
    let r = rand() * sum, idx = 0;
    while (idx < dist.length - 1 && (r -= dist[idx]) > 0) idx++;
    cs.push(pts[idx].slice());
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i], d2(pts[i], cs.at(-1)));
  }

  const lloyd = (iters) => {
    let counts = new Array(cs.length).fill(0);
    for (let it = 0; it < iters; it++) {
      const acc = cs.map(() => [0, 0, 0]);
      counts = new Array(cs.length).fill(0);
      for (const p of pts) {
        let b = 0, bd = Infinity;
        for (let c = 0; c < cs.length; c++) { const d = d2(p, cs[c]); if (d < bd) { bd = d; b = c; } }
        acc[b][0] += p[0]; acc[b][1] += p[1]; acc[b][2] += p[2]; counts[b]++;
      }
      for (let c = 0; c < cs.length; c++) if (counts[c]) cs[c] = [acc[c][0] / counts[c], acc[c][1] / counts[c], acc[c][2] / counts[c]];
    }
    return counts;
  };

  let counts = lloyd(10);
  // descartar colores de transición (poca población) y reajustar
  const keep = cs.map((_, i) => counts[i] / pts.length >= MIN_POP);
  if (keep.some(Boolean) && keep.some((v) => !v)) {
    const kept = cs.filter((_, i) => keep[i]);
    cs.length = 0;
    cs.push(...kept);
    counts = lloyd(4);
  }
  // Quitar colores de transición: poco poblados y situados sobre el segmento entre dos colores más poblados.
  const pop = cs.map((_, i) => counts[i] / pts.length);
  const distSeg = (p, a, b) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const t = len2 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
    return Math.sqrt(d2(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  };
  const order = cs.map((_, i) => i).sort((i, j) => pop[i] - pop[j]);
  const dead = new Set();
  for (const i of order) {
    if (!transition || pop[i] > TRANSITION_POP) break;
    const others = cs.map((_, j) => j).filter((j) => j !== i && !dead.has(j) && pop[j] > pop[i] * 0.15);
    outer: for (const a of others) for (const b of others) {
      if (a < b && d2(cs[a], cs[b]) > 900 && distSeg(cs[i], cs[a], cs[b]) < TRANSITION_DIST) { dead.add(i); break outer; }
    }
  }
  // fusionar casi-duplicados (conserva el más poblado) y absorber artefactos minoritarios
  for (const i of order) {
    if (dead.has(i)) continue;
    for (let j = 0; j < cs.length; j++) {
      if (j === i || dead.has(j) || pop[j] < pop[i]) continue;
      const dd = Math.sqrt(d2(cs[i], cs[j]));
      if (dd < mergeDist || (pop[i] < minorPop && pop[j] > pop[i] * 3 && dd < MINOR_DIST)) { dead.add(i); break; }
    }
  }
  return cs.filter((_, i) => !dead.has(i)).map((c) => c.map((v) => Math.round(v)));
}

/** Índice de paleta más cercano por píxel (255 = transparente). No modifica la imagen. */
export function labelPixels(rgba, palette) {
  const n = rgba.length / 4;
  const [pr, pg, pb] = [palette.map((c) => c[0]), palette.map((c) => c[1]), palette.map((c) => c[2])];
  const K = palette.length;
  const labels = new Uint8Array(n);
  let lr = -1, lg = -1, lb = -1, lc = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) { labels[i] = 255; continue; }
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    if (r !== lr || g !== lg || b !== lb) {
      let bd = Infinity;
      for (let c = 0; c < K; c++) {
        const d = (r - pr[c]) ** 2 + (g - pg[c]) ** 2 + (b - pb[c]) ** 2;
        if (d < bd) { bd = d; lc = c; }
      }
      lr = r; lg = g; lb = b;
    }
    labels[i] = lc;
  }
  return labels;
}

/** Pinta in situ cada píxel con el color de paleta de su etiqueta (o de su representante, si hay fusión). */
export function paintLabels(rgba, labels, palette, repOf = []) {
  for (let i = 0; i < labels.length; i++) {
    const o = i * 4;
    if (labels[i] === 255) { rgba[o + 3] = 0; continue; }
    const c = palette[repOf[labels[i]] ?? labels[i]];
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
  }
  return rgba;
}
