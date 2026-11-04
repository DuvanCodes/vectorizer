import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { vectorize, optimize, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { snapShapes, fillGaps } from './lib/shapes.js';
import { smoothPaths } from './lib/smooth.js';
import { buildPalette, labelPixels, paintLabels } from './lib/palette.js';
import { findGradientGroups, applyGradients } from './lib/gradients.js';

const MAX_MB = 25;
const MIN_SIDE = 2000; // imágenes pequeñas se amplían para que el trazado tenga más subpíxeles
const MAX_SIDE = 4096;
const MIN_SIDE_BW = 3000;

// Arte de línea/tinta: casi todos los píxeles son grises (sin croma), sobre blanco.
// ¿Hay transparencia apreciable (≥2% de píxeles)? Decide si el blanco del dibujo es relleno real o fondo.
async function hasTransparency(buf) {
  const { data } = await sharp(buf).rotate().ensureAlpha().extractChannel(3).resize(128, 128, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let t = 0;
  for (const a of data) if (a < 128) t++;
  return t / data.length >= 0.02;
}

async function isMonochrome(buf) {
  const { data } = await sharp(buf).rotate().flatten({ background: '#fff' }).resize(160, 160, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let gray = 0;
  for (let i = 0; i < data.length; i += 3) if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 24) gray++;
  return gray / (data.length / 3) > 0.97;
}

// Foto: casi ningún píxel se parece a su vecino (en logos/ilustraciones, incluso con ruido JPEG, >80% sí).
async function isPhoto(buf) {
  const { data, info } = await sharp(buf).rotate().flatten({ background: '#fff' }).resize(256, 256, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let flat = 0, total = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width - 1; x++) {
      const i = (y * info.width + x) * 3;
      const d = Math.max(Math.abs(data[i] - data[i + 3]), Math.abs(data[i + 1] - data[i + 4]), Math.abs(data[i + 2] - data[i + 5]));
      if (d <= 3) flat++;
      total++;
    }
  }
  return flat / total < 0.5;
}

const base = {
  colorMode: ColorMode.Color,
  hierarchical: Hierarchical.Cutout, // formas sin solapes (como un vectorial editable); gaps las suelda
  mode: PathSimplifyMode.Spline,
  filterSpeckle: 4,
  colorPrecision: 8,
  layerDifference: 6, // la paleta ya está cuantizada: las capas casi no se funden
  cornerThreshold: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThreshold: 45,
  pathPrecision: 2,
};

// maxColors: tamaño de la paleta a la que se cuantiza la imagen antes de trazar.
const PRESETS = {
  auto: { ...base, maxColors: 24 },
  alta: { ...base, maxColors: 32 },
  logo: { ...base, maxColors: 8, filterSpeckle: 6 },
  ilustracion: { ...base, maxColors: 16 },
  foto: { ...base, maxColors: 96, filterSpeckle: 6, layerDifference: 4 },
  bn: { ...base, colorMode: ColorMode.Binary, filterSpeckle: 8, pathPrecision: 1, lengthThreshold: 10, spliceThreshold: 90 },
};

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const flag = (v, d) => (v === undefined ? d : v === '1' || v === 'true' || v === 'on');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } });

app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

app.post('/api/vectorize', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta la imagen.' });
  const t0 = Date.now();
  try {
    let key = PRESETS[req.body.preset] ? req.body.preset : 'auto';
    if (key === 'auto') {
      if (await isMonochrome(req.file.buffer)) key = 'bn';
      else if (await isPhoto(req.file.buffer)) key = 'foto';
    }
    const preset = PRESETS[key];
    const bw = key === 'bn';
    const maxColors = Math.round(clamp(req.body.colors, 2, 128, preset.maxColors));
    const config = {
      ...preset,
      filterSpeckle: clamp(req.body.speckle, 0, 128, preset.filterSpeckle),
      layerDifference: clamp(req.body.layers, 0, 128, preset.layerDifference),
      cornerThreshold: clamp(req.body.corners, 0, 180, preset.cornerThreshold),
    };
    const snap = flag(req.body.snap, true);
    const smooth = flag(req.body.smooth, true);
    const grad = flag(req.body.grad, true) && key !== 'foto' && !bw;
    const gaps = flag(req.body.gaps, true) && config.hierarchical === Hierarchical.Cutout;

    const img = sharp(req.file.buffer, { limitInputPixels: 100e6 }).rotate();
    const meta = await img.metadata();
    const [w, h] = [meta.width, meta.height];
    if (!w || !h) throw new Error('Imagen no válida.');

    // Escala de trabajo: ampliar lo pequeño, reducir lo gigante.
    const longest = Math.max(w, h);
    const minSide = bw ? MIN_SIDE_BW : MIN_SIDE;
    const scale = longest < minSide ? minSide / longest : longest > MAX_SIDE ? MAX_SIDE / longest : 1;
    const pw = Math.round(w * scale);
    const ph = Math.round(h * scale);

    // Limpiar ANTES de ampliar: el ruido de bloques JPEG vive en píxeles de origen y, si se amplía,
    // se convierte en manchas enormes que ningún desenfoque posterior pequeño arregla.
    const denoise = scale > 1 ? 0.9 : 0.5;
    let pipeline = (bw ? img.flatten({ background: '#fff' }) : img).median(3).blur(denoise);
    pipeline = pipeline.resize(pw, ph, { kernel: 'lanczos3', fit: 'fill' });
    // Tras ampliar, un desenfoque proporcional redondea las isolíneas que luego sigue el trazador.
    pipeline = pipeline.blur(bw ? 2.0 : Math.min(2.2, Math.max(0.5, 0.35 * scale)));
    pipeline = pipeline.ensureAlpha();
    // Cuantizar a una paleta de colores dominantes: degradados/ruido se funden en colores planos y los
    // contornos salen como isolíneas suaves del campo ya desenfocado.
    let png, colorsUsed = 2, gradGroups = [], palette = [];
    if (bw) png = await pipeline.png().toBuffer();
    else {
      const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
      // Foto: conservar casi todos los tonos; logo/ilustración: fusionar matices casi iguales (degradados a pocas bandas limpias).
      palette = buildPalette(data, maxColors, key === 'foto' ? { mergeDist: 5, minorPop: 0, transition: false } : { mergeDist: 6 });
      colorsUsed = palette.length;
      const labels = labelPixels(data, palette);
      // Degradados: fusionar bandas vecinas que los píxeles originales explican como un gradiente lineal.
      const repOf = [];
      if (grad) {
        gradGroups = findGradientGroups({ src: data, labels, palette, w: info.width, h: info.height }).groups;
        for (const g of gradGroups) for (const l of g.members) repOf[l] = g.rep;
      }
      paintLabels(data, labels, palette, repOf);
      png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    }

    // El umbral de motas está en píxeles del trazado: escala con la ampliación.
    const traceCfg = { ...config, filterSpeckle: Math.round(config.filterSpeckle * Math.max(1, scale)) };
    // Tinta y relleno blanco sobre fondo transparente: el blanco interior es relleno REAL. Se apilan dos capas:
    // debajo la silueta opaca completa en negro, encima solo el blanco. Así lo que no es blanco es negro y
    // entre ambos no puede quedar ninguna franja transparente (los píxeles de borde del original son
    // semitransparentes y ninguna capa suelta los cubría).
    const transparent = await hasTransparency(req.file.buffer);
    const layered = bw && transparent;
    const chain = (flat) => {
      let p = sharp(req.file.buffer, { limitInputPixels: 100e6 }).rotate();
      p = flat ? p.flatten({ background: flat }) : p.ensureAlpha();
      return p.median(3).blur(denoise).resize(pw, ph, { kernel: 'lanczos3', fit: 'fill' }).blur(2.0);
    };
    let svg;
    if (layered) {
      const opaque = await chain().extractChannel(3).threshold(128).negate().png().toBuffer(); // opaco = negro
      const white = await chain('#000').extractChannel(0).threshold(128).negate().png().toBuffer(); // blanco = negro
      const base = await optimize(await vectorize(opaque, traceCfg));
      const top = await optimize(await vectorize(white, traceCfg));
      const whitePaths = (top.match(/<path[^>]*>/g) ?? []).map((p) => p.replace(/#000(?:000)?/g, '#fff')).join('');
      svg = base.replace('</svg>', whitePaths + '</svg>');
    } else {
      svg = await optimize(await vectorize(png, traceCfg));
    }

    // Bordes ultra limpios: se quitan las ondulaciones del raster y se reajusta con pocas Béziers largas.
    if (smooth && key !== 'foto') svg = smoothPaths(svg, { iters: Math.round(150 * Math.max(1, Math.sqrt(scale))), tol: 2.0 });

    let circles = 0, ellipses = 0;
    if (snap) ({ svg, circles, ellipses } = snapShapes(svg, { tol: 0.25 * Math.max(1, scale) }));
    if (gaps && !layered) svg = fillGaps(svg, 0.8 * Math.max(1, scale / 2));
    let gradients = 0;
    if (gradGroups.length) ({ svg, count: gradients } = applyGradients(svg, gradGroups, palette));

    // El trazado se hizo a escala ampliada: viewBox conserva coordenadas, width/height vuelven al tamaño original.
    svg = svg.replace(/<svg([^>]*?)>/, (_, attrs) => {
      const clean = attrs.replace(/\s(width|height|viewBox)="[^"]*"/g, '');
      return `<svg${clean} width="${w}" height="${h}" viewBox="0 0 ${pw} ${ph}">`;
    });

    res.json({
      mode: key,
      svg,
      width: w,
      height: h,
      bytes: Buffer.byteLength(svg),
      paths: (svg.match(/<path/g) ?? []).length,
      colors: colorsUsed,
      circles,
      ellipses,
      gradients,
      transparent,
      ms: Date.now() - t0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Error al vectorizar.' });
  }
});

app.use((err, _req, res, _next) => {
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({
    error: err.code === 'LIMIT_FILE_SIZE' ? `Máximo ${MAX_MB} MB.` : err.message,
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Vectorizer en http://localhost:${port}`));
