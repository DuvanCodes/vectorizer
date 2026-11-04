const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileIn = $('file'), cmp = $('cmp'), orig = $('orig'), vec = $('vec');
let current = null; // File actual
let result = null; // {svg,width,height,...}
let origUrl = null;
const view = { k: 1, x: 0, y: 0 };

// --- controles ---
const sliders = ['colors', 'layers', 'speckle', 'corners'];
const presetDefaults = {
  auto: [24, 6, 4, 60], alta: [32, 6, 4, 60], logo: [8, 6, 6, 60], ilustracion: [16, 6, 4, 60], foto: [64, 6, 8, 60], bn: [2, 6, 8, 60],
};
const syncOut = (s) => (s.previousElementSibling.textContent = s.value);
sliders.forEach((id) => { $(id).addEventListener('input', (e) => { syncOut(e.target); e.target.dataset.touched = '1'; }); });
function applyPreset() {
  presetDefaults[$('preset').value].forEach((v, i) => { $(sliders[i]).value = v; syncOut($(sliders[i])); delete $(sliders[i]).dataset.touched; });
}
$('preset').addEventListener('change', applyPreset);
applyPreset();
$('adv-toggle').onclick = () => ($('adv').hidden = !$('adv').hidden);

// --- carga ---
drop.onclick = () => fileIn.click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); };
fileIn.onchange = () => fileIn.files[0] && start(fileIn.files[0]);
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && start(e.dataTransfer.files[0]));
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
  if (f) start(f);
});
$('again').onclick = () => { $('result').hidden = true; $('app').hidden = false; window.scrollTo({ top: 0 }); };
$('redo').onclick = () => current && start(current);

function showErr(msg) { $('err').textContent = msg; $('err').hidden = !msg; }

async function start(file) {
  if (!file.type.startsWith('image/')) return showErr('Elige un archivo de imagen.');
  showErr('');
  current = file;
  $('busy').hidden = false;
  try {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('preset', $('preset').value);
    sliders.forEach((id) => { if ($(id).dataset.touched) fd.append(id, $(id).value); });
    ['snap', 'gaps', 'grad', 'smooth'].forEach((id) => fd.append(id, $(id).checked ? '1' : '0'));
    const r = await fetch('/api/vectorize', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al vectorizar.');
    result = data;
    if (origUrl) URL.revokeObjectURL(origUrl);
    origUrl = URL.createObjectURL(file);
    await show(data);
  } catch (e) {
    showErr(e.message);
  } finally {
    $('busy').hidden = true;
  }
}

async function show(d) {
  $('app').hidden = true;
  $('result').hidden = false;
  orig.src = origUrl;
  await orig.decode().catch(() => {});
  vec.innerHTML = d.svg;
  vec.style.background = d.transparent ? 'none' : '#fff'; // fuente opaca: el hueco del vector es blanco, no un damero
  const svg = vec.firstElementChild;
  svg.setAttribute('width', d.width);
  svg.setAttribute('height', d.height);
  const kb = (d.bytes / 1024).toFixed(1);
  $('stats').innerHTML = `<b>${d.width}×${d.height}</b> px · <b>${d.paths.toLocaleString()}</b> trazados · <b>${kb} KB</b> · ${(d.ms / 1000).toFixed(1)} s` +
    ` · <b>${d.colors}</b> colores` + (d.gradients ? ` · <b>${d.gradients}</b> degradados` : '') + (d.circles + d.ellipses ? ` · <b>${d.circles}</b> círculos y <b>${d.ellipses}</b> elipses exactos` : '');
  cmp.style.setProperty('--split', '50%');
  fit();
}

// --- visor: zoom/pan compartido, divisor ---
function fit() {
  const { width: cw, height: ch } = cmp.getBoundingClientRect();
  view.k = Math.min(cw / result.width, ch / result.height) * 0.95;
  view.x = (cw - result.width * view.k) / 2;
  view.y = (ch - result.height * view.k) / 2;
  applyView();
}
function applyView() {
  const t = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
  orig.style.width = result.width + 'px'; orig.style.height = result.height + 'px';
  orig.style.transform = t;
  vec.style.transform = t;
  // clip-path vive en coordenadas locales del elemento: convertimos el % del contenedor.
  const split = parseFloat(cmp.style.getPropertyValue('--split'));
  const px = (cmp.clientWidth * split) / 100;
  const local = (px - view.x) / view.k;
  vec.style.clipPath = `inset(-9999px -9999px -9999px ${local}px)`;
  orig.style.clipPath = `inset(-9999px ${result.width - local}px -9999px -9999px)`; // sin esto el original asoma bajo las zonas transparentes del vector
}
window.addEventListener('resize', () => result && fit());

cmp.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cmp.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const nk = Math.min(80, Math.max(0.02, view.k * Math.exp(-e.deltaY * 0.0015)));
  view.x = mx - ((mx - view.x) / view.k) * nk;
  view.y = my - ((my - view.y) / view.k) * nk;
  view.k = nk;
  applyView();
}, { passive: false });

let mode = null, last = null;
cmp.addEventListener('pointerdown', (e) => {
  cmp.setPointerCapture(e.pointerId);
  mode = e.target.closest('#handle') ? 'split' : 'pan';
  last = [e.clientX, e.clientY];
  cmp.classList.toggle('drag', mode === 'pan');
});
cmp.addEventListener('pointermove', (e) => {
  if (!mode) return;
  if (mode === 'split') {
    const r = cmp.getBoundingClientRect();
    cmp.style.setProperty('--split', Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)) + '%');
  } else {
    view.x += e.clientX - last[0]; view.y += e.clientY - last[1];
  }
  last = [e.clientX, e.clientY];
  applyView();
});
cmp.addEventListener('pointerup', () => { mode = null; cmp.classList.remove('drag'); });
cmp.addEventListener('dblclick', fit);

// --- descargas ---
const base = () => (current?.name || 'imagen').replace(/\.[^.]+$/, '');
function save(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('dl-svg').onclick = () => save(new Blob([result.svg], { type: 'image/svg+xml' }), base() + '.svg');
$('dl-png').onclick = async () => {
  const scale = 2;
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
  await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: result.width * scale, height: result.height * scale });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  c.toBlob((b) => save(b, base() + '.png'));
};
