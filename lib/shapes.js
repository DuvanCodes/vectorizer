// Detecta subtrazados que son círculos o elipses y los reemplaza por arcos exactos (A),
// y añade un trazo fino del mismo color para tapar las costuras entre formas recortadas.

const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Convierte un atributo d a subtrazados de segmentos absolutos: {type, p:[…]} */
function parsePath(d) {
  const subs = [];
  let cur = null;
  let x = 0, y = 0, sx = 0, sy = 0, last = null, lastCtl = null;
  const re = /([a-z])([^a-z]*)/gi;
  for (const [, cmd, rest] of d.matchAll(re)) {
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const n = ARGS[lower];
    if (n === undefined) return null;
    const nums = rest.match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
    if (lower === 'z') {
      if (cur) cur.closed = true;
      x = sx; y = sy; last = 'z'; lastCtl = null;
      continue;
    }
    if (nums.length === 0 || nums.length % n !== 0) return null;
    for (let i = 0; i < nums.length; i += n) {
      const a = nums.slice(i, i + n);
      const ox = rel ? x : 0, oy = rel ? y : 0;
      let seg;
      const op = lower === 'm' && i > 0 ? 'l' : lower; // pares extra tras M son L implícitos
      switch (op) {
        case 'm':
          x = a[0] + ox; y = a[1] + oy; sx = x; sy = y;
          cur = { segs: [], start: [x, y], closed: false };
          subs.push(cur);
          last = 'm'; lastCtl = null;
          continue;
        case 'l': x = a[0] + ox; y = a[1] + oy; seg = { t: 'L', p: [x, y] }; lastCtl = null; break;
        case 'h': x = a[0] + (rel ? x : 0); seg = { t: 'L', p: [x, y] }; lastCtl = null; break;
        case 'v': y = a[0] + (rel ? y : 0); seg = { t: 'L', p: [x, y] }; lastCtl = null; break;
        case 'c': {
          const c1 = [a[0] + ox, a[1] + oy], c2 = [a[2] + ox, a[3] + oy];
          seg = { t: 'C', p: [...c1, ...c2, a[4] + ox, a[5] + oy] };
          x = a[4] + ox; y = a[5] + oy; lastCtl = c2; break;
        }
        case 's': {
          const c1 = lastCtl && last === 'c' ? [2 * x - lastCtl[0], 2 * y - lastCtl[1]] : [x, y];
          const c2 = [a[0] + ox, a[1] + oy];
          seg = { t: 'C', p: [...c1, ...c2, a[2] + ox, a[3] + oy] };
          x = a[2] + ox; y = a[3] + oy; lastCtl = c2; break;
        }
        case 'q': {
          const c = [a[0] + ox, a[1] + oy];
          seg = { t: 'Q', p: [...c, a[2] + ox, a[3] + oy] };
          x = a[2] + ox; y = a[3] + oy; lastCtl = c; break;
        }
        case 't': {
          const c = lastCtl && last === 'q' ? [2 * x - lastCtl[0], 2 * y - lastCtl[1]] : [x, y];
          seg = { t: 'Q', p: [...c, a[0] + ox, a[1] + oy] };
          x = a[0] + ox; y = a[1] + oy; lastCtl = c; break;
        }
        case 'a':
          seg = { t: 'A', p: [a[5] + ox, a[6] + oy], arc: [a[0], a[1], a[2], a[3], a[4]] };
          x = a[5] + ox; y = a[6] + oy; lastCtl = null; break;
      }
      if (!cur) return null;
      cur.segs.push(seg);
      last = lower === 'h' || lower === 'v' ? 'l' : lower;
    }
  }
  return subs;
}

const f = (n) => String(+n.toFixed(2));

/** Serializa un subtrazado (absoluto) de vuelta a d. */
function encodeSub(sub) {
  let out = `M${f(sub.start[0])} ${f(sub.start[1])}`;
  for (const s of sub.segs) out += s.t === 'A' ? `A${s.arc.slice(0, 2).map(f).join(' ')} ${f(s.arc[2])} ${s.arc[3]} ${s.arc[4]} ${s.p.map(f).join(' ')}` : s.t + s.p.map(f).join(' ');
  return out + (sub.closed ? 'Z' : '');
}

/** Puntos a lo largo del contorno (las cuerdas también se muestrean para detectar polígonos). */
function sample(sub) {
  const pts = [sub.start];
  let [px, py] = sub.start;
  for (const s of sub.segs) {
    const len = Math.hypot(s.p.at(-2) - px, s.p.at(-1) - py);
    const steps = Math.min(48, Math.max(2, Math.ceil(len / 4)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      if (s.t === 'A') pts.push(arcPoint(px, py, s, t));
      else if (s.t === 'L') pts.push([px + (s.p[0] - px) * t, py + (s.p[1] - py) * t]);
      else if (s.t === 'Q')
        pts.push([u * u * px + 2 * u * t * s.p[0] + t * t * s.p[2], u * u * py + 2 * u * t * s.p[1] + t * t * s.p[3]]);
      else
        pts.push([
          u ** 3 * px + 3 * u * u * t * s.p[0] + 3 * u * t * t * s.p[2] + t ** 3 * s.p[4],
          u ** 3 * py + 3 * u * u * t * s.p[1] + 3 * u * t * t * s.p[3] + t ** 3 * s.p[5],
        ]);
    }
    px = s.p.at(-2); py = s.p.at(-1);
  }
  // En un relleno el subtrazado se cierra solo (el optimizador suprime la Z): muestrear la cuerda final.
  const [x0, y0] = sub.start;
  const gap = Math.hypot(x0 - px, y0 - py);
  for (let i = 1; i < Math.ceil(gap / 4); i++) pts.push([px + ((x0 - px) * i) / Math.ceil(gap / 4), py + ((y0 - py) * i) / Math.ceil(gap / 4)]);
  return pts;
}

/** Punto del arco a fracción t (conversión de parametrización por extremos a centro, SVG F.6.5). */
function arcPoint(x1, y1, s, t) {
  let [rx, ry, rot, large, sweep] = s.arc;
  const [x2, y2] = s.p;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  const phi = (rot * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p / rx) ** 2 + (y1p / ry) ** 2;
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;
  const th = th1 + dth * t;
  return [cx + rx * Math.cos(th) * cp - ry * Math.sin(th) * sp, cy + rx * Math.cos(th) * sp + ry * Math.sin(th) * cp];
}

function solve(M, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < 1e-12) return null;
    [M[i], M[p]] = [M[p], M[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const k = M[r][i] / M[i][i];
      for (let c = i; c < n; c++) M[r][c] -= k * M[i][c];
      b[r] -= k * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c];
    x[i] = s / M[i][i];
  }
  return x;
}

/** Ajusta una elipse (mínimos cuadrados sobre la cónica) y valida con distancia geométrica. */
function fitEllipse(pts, tol) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let s = 0;
  for (const [x, y] of pts) s += (x - mx) ** 2 + (y - my) ** 2;
  s = Math.sqrt(s / pts.length);
  if (s < 1e-6) return null;
  const N = Array.from({ length: 5 }, () => new Array(5).fill(0));
  const b = new Array(5).fill(0);
  for (const [X, Y] of pts) {
    const x = (X - mx) / s, y = (Y - my) / s;
    const r = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) { b[i] += r[i]; for (let j = 0; j < 5; j++) N[i][j] += r[i] * r[j]; }
  }
  const q = solve(N, b);
  if (!q) return null;
  const [A, B, C, D, E] = q;
  const det = 4 * A * C - B * B;
  if (det <= 1e-9) return null;
  const cx = (B * E - 2 * C * D) / det, cy = (B * D - 2 * A * E) / det;
  const R = 1 - (A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy);
  const tr = A + C, dd = Math.sqrt(Math.max(0, ((A - C) / 2) ** 2 + (B / 2) ** 2));
  const l1 = tr / 2 + dd, l2 = tr / 2 - dd;
  if (R <= 0 || l1 <= 0 || l2 <= 0) return null;
  let a = Math.sqrt(R / l2), bb = Math.sqrt(R / l1); // l2 menor → eje mayor
  let phi = 0.5 * Math.atan2(-B, C - A); // ángulo del eje mayor
  const ca = Math.cos(phi), sa = Math.sin(phi);
  const E1 = { cx: cx * s + mx, cy: cy * s + my, a: a * s, b: bb * s, phi };
  // Validar con distancia geométrica aproximada. El contorno trae ruido de muestreo/JPEG,
  // así que se exige el percentil 97 (y un tope al máximo) en vez del peor punto.
  const lim = tol + 0.004 * E1.a;
  const dev = [];
  for (const [X, Y] of pts) {
    const dx = X - E1.cx, dy = Y - E1.cy;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    const fv = (u / E1.a) ** 2 + (v / E1.b) ** 2 - 1;
    const g = 2 * Math.hypot(u / E1.a ** 2, v / E1.b ** 2);
    if (g === 0) return null;
    dev.push(Math.abs(fv) / g);
  }
  dev.sort((p, q) => p - q);
  if (dev[Math.floor(dev.length * 0.97)] > lim || dev.at(-1) > lim * 3) return null;
  return E1;
}

function encodeEllipse(e, sweep) {
  const circle = Math.abs(e.a - e.b) / e.a < 0.01;
  const rx = circle ? (e.a + e.b) / 2 : e.a, ry = circle ? rx : e.b;
  const phi = circle ? 0 : e.phi;
  const ca = Math.cos(phi), sa = Math.sin(phi);
  // punto de la elipse a ángulo t (paramétrico), rotada phi
  const at = (t) => [e.cx + rx * Math.cos(t) * ca - ry * Math.sin(t) * sa, e.cy + rx * Math.cos(t) * sa + ry * Math.sin(t) * ca];
  const deg = f((phi * 180) / Math.PI);
  // Cuatro arcos de cuarto: un semicírculo exacto con large-arc=1 es ambiguo y algunos renderizadores eligen mal.
  const dir = sweep ? 1 : -1;
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 1; i <= 4; i++) { const p = at((dir * i * Math.PI) / 2); d += `A${f(rx)} ${f(ry)} ${deg} 0 ${sweep} ${f(p[0])} ${f(p[1])}`; }
  return { d: d + 'Z', circle };
}

/**
 * @returns {{svg: string, circles: number, ellipses: number}}
 */
export function snapShapes(svg, { tol = 0.6, minRadius = 4 } = {}) {
  let circles = 0, ellipses = 0;
  const out = svg.replace(/<path\b([^>]*?)\sd="([^"]*)"([^>]*?)\/>/g, (whole, pre, d, post) => {
    const subs = parsePath(d);
    if (!subs?.length) return whole;
    let changed = false;
    const parts = subs.map((sub) => {
      if (sub.segs.length > 600 || sub.segs.length < 2) return encodeSub(sub);
      const pts = sample(sub);
      if (!pts || pts.length < 12) return encodeSub(sub);
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        area += x1 * y2 - x2 * y1;
      }
      area /= 2;
      const e = fitEllipse(pts, tol);
      if (!e || e.b < minRadius) return encodeSub(sub);
      // el área del subtrazado debe coincidir con la de la elipse (descarta ajustes parciales)
      if (Math.abs(Math.abs(area) - Math.PI * e.a * e.b) / (Math.PI * e.a * e.b) > 0.03) return encodeSub(sub);
      const enc = encodeEllipse(e, area > 0 ? 1 : 0);
      enc.circle ? circles++ : ellipses++;
      changed = true;
      return enc.d;
    });
    return changed ? `<path${pre} d="${parts.join('')}"${post}/>` : whole;
  });
  return { svg: out, circles, ellipses };
}

/** Trazo del mismo color que el relleno: cubre las costuras de antialiasing entre formas recortadas. */
export function fillGaps(svg, width = 0.8) {
  return svg.replace(/<path\b([^>]*?)\sfill="(#[0-9a-fA-F]{3,8})"([^>]*?)\/>/g, (_, pre, c, post) =>
    `<path${pre} fill="${c}" stroke="${c}" stroke-width="${width}" stroke-linejoin="round"${post}/>`);
}
export { parsePath, sample };
