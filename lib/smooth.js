// Contornos limpios: el raster de origen deja ondulaciones diminutas en los bordes. Cada subtrazado se
// remuestrea a paso uniforme, se detectan las esquinas reales, los tramos entre esquinas se suavizan con un
// filtro Taubin (paso bajo que NO encoge las curvas) y después se regulariza la geometría:
//   · las rectas largas pasan a ser segmentos exactos (alineados con el eje si están a <0.8°),
//   · cada esquina entre dos rectas es la intersección exacta de ambas,
//   · las curvas se reajustan con pocas Béziers cúbicas (Schneider) con tangente continua contra las rectas.
import fitCurve from 'fit-curve';
import { parsePath, sample } from './shapes.js';

const { fitCubic, createTangent } = fitCurve;
const STEP = 2; // paso del remuestreo (unidades de trabajo)
const CORNER_DEG = 55; // giro mínimo en un brazo de 2 pasos para considerarlo esquina
const LINE_MIN = 50; // longitud mínima de una recta
const LINE_TOL = 1.8; // desviación máxima permitida respecto a la recta ajustada
const LINE_BOW = 0.5; // abombamiento máximo (sagita): por encima es una curva suave, no una recta con ruido
const AXIS_SNAP_DEG = 0.8; // una recta a menos de esto de la horizontal/vertical se alinea exactamente
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

// ---------------------------------------------------------------------------------------------
// Rectas
// ---------------------------------------------------------------------------------------------

/** Recta por mínimos cuadrados totales sobre P[i0..i1]; devuelve null si no cumple ser una recta limpia. */
function fitLine(P, i0, i1) {
  const n = i1 - i0 + 1;
  let cx = 0, cy = 0;
  for (let i = i0; i <= i1; i++) { cx += P[i][0]; cy += P[i][1]; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = i0; i <= i1; i++) {
    const x = P[i][0] - cx, y = P[i][1] - cy;
    sxx += x * x; sxy += x * y; syy += y * y;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(th), dy = Math.sin(th);
  // sentido de avance: de la primera a la última muestra
  if ((P[i1][0] - P[i0][0]) * dx + (P[i1][1] - P[i0][1]) * dy < 0) { dx = -dx; dy = -dy; }
  const len = Math.hypot(P[i1][0] - P[i0][0], P[i1][1] - P[i0][1]);
  if (len < LINE_MIN) return null;
  // residuos con signo y parámetro t normalizado a [-1, 1] → parábola r(t) = a t² + b t + c
  const t = new Float64Array(n), r = new Float64Array(n);
  let tmin = Infinity, tmax = -Infinity, maxDev = 0;
  for (let i = 0; i < n; i++) {
    const x = P[i0 + i][0] - cx, y = P[i0 + i][1] - cy;
    t[i] = x * dx + y * dy;
    r[i] = -x * dy + y * dx;
    if (t[i] < tmin) tmin = t[i];
    if (t[i] > tmax) tmax = t[i];
    maxDev = Math.max(maxDev, Math.abs(r[i]));
  }
  if (maxDev > LINE_TOL) return null;
  const span = (tmax - tmin) / 2 || 1, mid = (tmax + tmin) / 2;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const u = (t[i] - mid) / span;
    s1 += u; s2 += u * u; s3 += u ** 3; s4 += u ** 4;
    r0 += r[i]; r1 += u * r[i]; r2 += u * u * r[i];
  }
  // sistema normal 3x3 (Cramer) para [c, b, a]
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return null;
  const Ma = [[s0, s1, r0], [s1, s2, r1], [s2, s3, r2]];
  const bow = Math.abs(det3(Ma) / D);
  if (bow > LINE_BOW) return null;
  return { cx, cy, dx, dy, len };
}

/** Parte un tramo abierto P[0..m-1] en piezas: rectas largas ('L') y tramos curvos ('C'). */
function splitRun(P) {
  const m = P.length;
  const minPts = Math.ceil(LINE_MIN / STEP);
  const pieces = [];
  let curveStart = 0;
  let i = 0;
  const pushCurve = (a, b) => { if (b - a >= 1) pieces.push({ kind: 'C', a, b }); };
  while (i + minPts < m) {
    let j = i + minPts;
    let fit = fitLine(P, i, j);
    if (!fit) { i += 4; continue; }
    // crecer a la derecha mientras siga siendo recta
    let best = { j, fit };
    for (let k = j + 4; k < m; k += 4) {
      const g = fitLine(P, i, k);
      if (!g) break;
      best = { j: k, fit: g };
    }
    const g2 = best.j < m - 1 ? fitLine(P, i, m - 1) : null; // ¿llega hasta el final del tramo?
    if (g2) best = { j: m - 1, fit: g2 };
    // crecer a la izquierda (hasta el inicio de la zona curva pendiente)
    let a = i, fa = best.fit;
    for (let k = a - 4; k >= curveStart; k -= 4) {
      const g = fitLine(P, k, best.j);
      if (!g) break;
      a = k; fa = g;
    }
    if (a - curveStart > 0 && a - curveStart < 4) { // un resto de 1-3 muestras no merece una curva aparte
      const g = fitLine(P, curveStart, best.j);
      if (g) { a = curveStart; fa = g; }
    }
    pushCurve(curveStart, a);
    pieces.push({ kind: 'L', a, b: best.j, fit: fa });
    curveStart = best.j;
    i = best.j;
  }
  pushCurve(curveStart, m - 1);
  return pieces;
}

// ---------------------------------------------------------------------------------------------

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
  if (corners.length === 0) {
    const S = taubin(pts, new Uint8Array(n), true, iters, 0.5, mu);
    const run = [...S, S[0]];
    const t = createTangent(S[1], S[n - 1]);
    const tb = createTangent(S[n - 1], S[1]);
    const cs = fitCubic(run, t, tb, tol);
    return `M${f(S[0][0])} ${f(S[0][1])}${bez(cs)}Z`;
  }
  // tramos entre esquinas consecutivas (cíclico); las esquinas quedan fijas
  const fixed = new Uint8Array(n);
  for (const c of corners) fixed[c] = 1;
  const S = taubin(pts, fixed, true, iters, 0.5, mu);

  // 1) piezas (rectas / curvas) de cada tramo
  const pieces = [];
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c], b = corners[(c + 1) % corners.length];
    const run = [];
    for (let i = a; ; i = (i + 1) % n) { run.push(S[i]); if (i === b && run.length > 1) break; if (run.length > n + 1) break; }
    if (run.length < 3) { pieces.push({ kind: 'C', pts: run }); continue; }
    for (const p of splitRun(run)) {
      if (p.kind === 'L') {
        const ft = p.fit;
        // alinear con el eje si casi lo está
        let { dx, dy, cx, cy } = ft;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        const offH = Math.min(Math.abs(ang), Math.abs(Math.abs(ang) - 180));
        const offV = Math.abs(Math.abs(ang) - 90);
        if (offH < AXIS_SNAP_DEG) { dx = dx >= 0 ? 1 : -1; dy = 0; }
        else if (offV < AXIS_SNAP_DEG) { dx = 0; dy = dy >= 0 ? 1 : -1; }
        // extremos = proyección de las muestras extremas sobre la recta
        const proj = (q) => { const t = (q[0] - cx) * dx + (q[1] - cy) * dy; return [cx + dx * t, cy + dy * t]; };
        pieces.push({ kind: 'L', dir: [dx, dy], c: [cx, cy], p0: proj(run[p.a]), p1: proj(run[p.b]) });
      } else {
        pieces.push({ kind: 'C', pts: run.slice(p.a, p.b + 1).map((q) => q.slice()) });
      }
    }
  }

  // 2) uniones entre piezas consecutivas (cíclico)
  const m = pieces.length;
  const project = (L, q) => { const t = (q[0] - L.c[0]) * L.dir[0] + (q[1] - L.c[1]) * L.dir[1]; return [L.c[0] + L.dir[0] * t, L.c[1] + L.dir[1] * t]; };
  for (let k = 0; k < m; k++) {
    const A = pieces[k], B = pieces[(k + 1) % m];
    if (A === B) continue;
    if (A.kind === 'L' && B.kind === 'L') {
      const cross = A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0];
      if (Math.abs(cross) > 0.2) { // no paralelas: esquina = intersección exacta
        const wx = B.c[0] - A.c[0], wy = B.c[1] - A.c[1];
        const s = (wx * B.dir[1] - wy * B.dir[0]) / cross;
        const V = [A.c[0] + A.dir[0] * s, A.c[1] + A.dir[1] * s];
        if (Math.hypot(V[0] - A.p1[0], V[1] - A.p1[1]) < 14) { A.p1 = V; B.p0 = V.slice(); }
      }
    } else if (A.kind === 'L' && B.kind === 'C') {
      const P1 = project(A, B.pts[0]);
      A.p1 = P1; B.pts[0] = P1.slice();
    } else if (A.kind === 'C' && B.kind === 'L') {
      const P0 = project(B, A.pts.at(-1));
      B.p0 = P0; A.pts[A.pts.length - 1] = P0.slice();
    }
  }

  // 3) trazado: rectas como L, filetes entre dos rectas como arco circular, el resto como Béziers
  //    con la tangente de la recta vecina
  const first = pieces[0];
  const startPt = first.kind === 'L' ? first.p0 : first.pts[0];
  let d = `M${f(startPt[0])} ${f(startPt[1])}`;
  let cur = startPt;
  const lineTo = (q) => { d += `L${f(q[0])} ${f(q[1])}`; cur = q; };
  for (let k = 0; k < m; k++) {
    const P = pieces[k], prev = pieces[(k + m - 1) % m], next = pieces[(k + 1) % m];
    if (P.kind === 'L') {
      if (Math.hypot(cur[0] - P.p0[0], cur[1] - P.p0[1]) > 0.05) lineTo(P.p0); // unión sin vértice común
      lineTo(P.p1);
      continue;
    }
    const pts2 = P.pts;
    if (pts2.length < 3) { lineTo(pts2.at(-1)); continue; }
    const P0 = pts2[0], P3 = pts2.at(-1);
    // filete: curva corta entre dos rectas → arco circular exacto (Bézier con k = 4/3·tan(θ/4)/tan(θ/2))
    if (prev.kind === 'L' && next.kind === 'L') {
      const cross = prev.dir[0] * next.dir[1] - prev.dir[1] * next.dir[0];
      const dot = prev.dir[0] * next.dir[0] + prev.dir[1] * next.dir[1];
      const th = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (Math.abs(cross) > 0.2 && th > 0.17 && th < 2.97) {
        const wx = next.c[0] - prev.c[0], wy = next.c[1] - prev.c[1];
        const sV = (wx * next.dir[1] - wy * next.dir[0]) / cross;
        const V = [prev.c[0] + prev.dir[0] * sV, prev.c[1] + prev.dir[1] * sV];
        const t1 = (V[0] - P0[0]) * prev.dir[0] + (V[1] - P0[1]) * prev.dir[1]; // P0 antes del vértice
        const t2 = (P3[0] - V[0]) * next.dir[0] + (P3[1] - V[1]) * next.dir[1]; // P3 después del vértice
        if (t1 > 0 && t2 > 0 && t1 < 80 && t2 < 80) {
          const kk = ((4 / 3) * Math.tan(th / 4)) / Math.tan(th / 2);
          const c1 = [P0[0] + prev.dir[0] * kk * t1, P0[1] + prev.dir[1] * kk * t1];
          const c2 = [P3[0] - next.dir[0] * kk * t2, P3[1] - next.dir[1] * kk * t2];
          d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(P3[0])} ${f(P3[1])}`;
          cur = P3;
          continue;
        }
      }
    }
    const tl = prev.kind === 'L' ? prev.dir : createTangent(pts2[1], pts2[0]);
    const tr = next.kind === 'L' ? [-next.dir[0], -next.dir[1]] : createTangent(pts2.at(-2), pts2.at(-1));
    d += bez(fitCubic(pts2, tl, tr, tol));
    cur = P3;
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
