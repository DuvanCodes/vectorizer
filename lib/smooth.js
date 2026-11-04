// Contornos limpios: el raster de origen deja ondulaciones diminutas en los bordes. Cada subtrazado se
// remuestrea a paso uniforme, se detectan las esquinas reales, los tramos entre esquinas se suavizan con un
// filtro Taubin (paso bajo que NO encoge las curvas) y se reajustan con pocas Béziers cúbicas (Schneider).
import fitCurve from 'fit-curve';
import { parsePath, sample } from './shapes.js';

const { fitCubic, createTangent } = fitCurve;
const STEP = 2; // paso del remuestreo (unidades de trabajo)
const CORNER_DEG = 55; // giro mínimo en un brazo de 2 pasos para considerarlo esquina
const f = (n) => String(+n.toFixed(2));

function resample(pts, step) {
  const n0 = pts.length;
  const cum = [0];
  for (let i = 1; i <= n0; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i % n0];
    cum.push(cum[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }
  const L = cum[n0];
  const n = Math.max(8, Math.round(L / step));
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k * L) / n;
    while (cum[j + 1] < s && j < n0 - 1) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = (s - cum[j]) / seg;
    const [x1, y1] = pts[j], [x2, y2] = pts[(j + 1) % n0];
    out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
  }
  return { pts: out, length: L };
}

/** Taubin λ|μ sobre una secuencia; `fixed` marca puntos que no se mueven. cyclic: índices módulo n. */
function taubin(P, fixed, cyclic, iters, lambda, mu) {
  const n = P.length;
  let A = P.map((p) => p.slice());
  const lap = (src, i) => {
    const a = cyclic ? src[(i + n - 1) % n] : src[Math.max(0, i - 1)];
    const b = cyclic ? src[(i + 1) % n] : src[Math.min(n - 1, i + 1)];
    return [(a[0] + b[0]) / 2 - src[i][0], (a[1] + b[1]) / 2 - src[i][1]];
  };
  for (let it = 0; it < iters; it++) {
    for (const w of [lambda, mu]) {
      const next = A.map((p) => p.slice());
      for (let i = 0; i < n; i++) {
        if (fixed[i] || (!cyclic && (i === 0 || i === n - 1))) continue;
        const [lx, ly] = lap(A, i);
        next[i][0] = A[i][0] + w * lx;
        next[i][1] = A[i][1] + w * ly;
      }
      A = next;
    }
  }
  return A;
}

function findCorners(P, k) {
  const n = P.length;
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[(i + n - k) % n], b = P[i], c = P[(i + k) % n];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const d = Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
    ang[i] = Math.abs(d);
  }
  const th = (CORNER_DEG * Math.PI) / 180;
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < th) continue;
    let isMax = true;
    for (let d = -k - 1; d <= k + 1 && isMax; d++) if (d && ang[(i + d + n) % n] > ang[i]) isMax = false;
    if (isMax) corners.push(i);
  }
  return corners;
}

const bez = (cs) => cs.map(([, c1, c2, p]) => `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p[0])} ${f(p[1])}`).join('');

function smoothSub(sub, { iters, tol }) {
  const raw = sample(sub);
  if (!raw || raw.length < 8) return null;
  const { pts, length } = resample(raw, STEP);
  if (length < 30) return null; // motas: se dejan como están
  const n = pts.length;
  // esquinas sobre una copia apenas suavizada (el ruido de 1 px no debe fabricar esquinas)
  const pre = taubin(pts, new Uint8Array(n), true, 4, 0.5, -0.53);
  const corners = findCorners(pre, 2);
  const mu = -0.5076; // λ=0.5 → banda de paso ~0.03: ondulaciones de λ < ~80 px desaparecen
  let d = '';
  if (corners.length === 0) {
    const S = taubin(pts, new Uint8Array(n), true, iters, 0.5, mu);
    const run = [...S, S[0]];
    const t = createTangent(S[1], S[n - 1]);
    const tb = createTangent(S[n - 1], S[1]);
    const cs = fitCubic(run, t, tb, tol);
    d = `M${f(S[0][0])} ${f(S[0][1])}${bez(cs)}Z`;
    return d;
  }
  // tramos entre esquinas consecutivas (cíclico); las esquinas quedan fijas
  const fixed = new Uint8Array(n);
  for (const c of corners) fixed[c] = 1;
  const S = taubin(pts, fixed, true, iters, 0.5, mu);
  const start = S[corners[0]];
  d = `M${f(start[0])} ${f(start[1])}`;
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c], b = corners[(c + 1) % corners.length];
    const run = [];
    for (let i = a; ; i = (i + 1) % n) { run.push(S[i]); if (i === b && run.length > 1) break; if (run.length > n + 1) break; }
    if (run.length < 3) { d += `L${f(run.at(-1)[0])} ${f(run.at(-1)[1])}`; continue; }
    d += bez(fitCubic(run, createTangent(run[1], run[0]), createTangent(run.at(-2), run.at(-1)), tol));
  }
  return d + 'Z';
}

export function smoothPaths(svg, { iters = 40, tol = 0.8 } = {}) {
  return svg.replace(/<path\b([^>]*?)\sd="([^"]*)"([^>]*?)\/>/g, (whole, pre, d, post) => {
    const subs = parsePath(d);
    if (!subs?.length) return whole;
    const out = [];
    for (const sub of subs) {
      let s = null;
      try { s = smoothSub(sub, { iters, tol }); } catch { s = null; }
      if (s) out.push(s);
    }
    return out.length ? `<path${pre} d="${out.join('')}"${post}/>` : whole;
  });
}
