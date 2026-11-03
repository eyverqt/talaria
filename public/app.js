/* ==========================================================================
   Talaria — interfaz

   Habla con server/index.mjs: /api/* para las ordenes y un flujo de sucesos
   para el progreso en vivo. Sin frameworks: abre al instante.
   ========================================================================== */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PAGINAS = ['descargar', 'historial', 'ajustes'];
const TITULOS = { descargar: 'Descargar', historial: 'Historial', ajustes: 'Ajustes' };
const ETIQUETAS = {
  leyendo: 'Leyendo', 'en cola': 'En cola', descargando: 'Bajando', uniendo: 'Uniendo', convirtiendo: 'Convirtiendo',
  esperando: 'Esperando', listo: 'Listo ✓', error: 'Error', cancelado: 'Cancelado', pausado: 'Pausado',
};
const est = { cfg: {}, jobs: new Map(), nodos: new Map(), historial: [], tools: null, pagina: 'descargar' };

/* ------------------------------------------------------------ utilidades */

async function api(ruta, cuerpo, metodo = 'POST') {
  const r = await fetch(ruta, {
    method: metodo, headers: { 'Content-Type': 'application/json' },
    body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `error ${r.status}`);
  return d;
}

function toast(texto, malo) {
  const t = $('#toast');
  t.textContent = texto;
  t.classList.toggle('err', !!malo);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, malo ? 5600 : 2600);
}

function reloj(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  const dos = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}

function peso(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

function formato(j) {
  if (j.mode === 'audio') return j.format === 'original' ? 'AUDIO ORIGINAL' : (j.format || 'mp3').toUpperCase();
  const q = { best: 'MÁXIMA', 2160: '4K', 1440: '2K', 1080: '1080P', 720: '720P', 480: '480P' }[j.quality] || '';
  return `${q} ${(j.container || 'mp4').toUpperCase()}`;
}

function miniatura(url) {
  const img = document.createElement('img');
  img.className = 'miniatura';
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  if (url) img.src = url;
  img.onerror = () => { img.removeAttribute('src'); };
  return img;
}

/* ----------------------------------------------------------------- rutas */

function rutaActual() {
  const p = location.pathname.replace(/^\/+|\/+$/g, '');
  return PAGINAS.includes(p) ? p : 'descargar';
}

function ir(p, empujar = true) {
  est.pagina = p;
  $$('.pagina').forEach((s) => { s.hidden = s.dataset.p !== p; });
  $$('#tabs a').forEach((a) => a.classList.toggle('is-active', a.dataset.ir === p));
  $('#logoSub').textContent = TITULOS[p];
  if (empujar && rutaActual() !== p) history.pushState(null, '', `/${p}`);
  if (p === 'historial') pintarHistorial();
  window.scrollTo(0, 0);
}

/* --------------------------------------------------------------- opciones */

function pintarOpciones() {
  $$('.seg[data-key]').forEach((el) => {
    const v = String(est.cfg[el.dataset.key] ?? '');
    $$('button', el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  });
  const audio = est.cfg.mode === 'audio';
  $$('.soloVideo').forEach((n) => { n.hidden = audio; });
  $$('.soloAudio').forEach((n) => { n.hidden = !audio; });
  $('#formatoHint').textContent = formato(est.cfg);
  if (document.activeElement !== $('#outDir')) $('#outDir').value = est.cfg.outDir || '';
}

async function cambiar(cambios) {
  Object.assign(est.cfg, cambios);
  pintarOpciones();
  try { est.cfg = await api('/api/config', cambios); pintarOpciones(); } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------- trabajos */

function fila(j) {
  $('#colaVacia').hidden = true;
  const li = document.createElement('li');
  li.className = 'job';
  li.innerHTML = '<div class="j-mini"></div><div><div class="job-h"><b></b><span></span></div><div class="bar"><i></i></div><div class="job-f"><span></span><div class="job-a"></div></div></div>';
  $('.j-mini', li).appendChild(miniatura(j.thumbnail));
  $('.job-a', li).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) accion(j.id, b.dataset.a);
  });
  $('#cola').appendChild(li);
  const n = { li, titulo: $('.job-h b', li), estado: $('.job-h > span', li), barra: $('.bar i', li), fase: $('.job-f > span', li), acciones: $('.job-a', li), img: $('img', li) };
  est.nodos.set(j.id, n);
  return n;
}

const BOTONES = {
  activo: [['pause', 'Pausar'], ['cancel', 'Cancelar']],
  cola: [['cancel', 'Cancelar']],
  pausado: [['retry', 'Reanudar'], ['remove', 'Quitar']],
  error: [['retry', 'Reintentar'], ['remove', 'Quitar']],
  cancelado: [['retry', 'Otra vez'], ['remove', 'Quitar']],
  listo: [['open', 'Abrir'], ['transcribe', 'Transcribir'], ['remove', 'Quitar']],
};

function pintarJob(j) {
  const n = est.nodos.get(j.id) || fila(j);
  n.li.dataset.estado = j.status;
  n.titulo.textContent = j.title;
  n.titulo.title = j.title;
  if (j.thumbnail && n.img.getAttribute('src') !== j.thumbnail) n.img.src = j.thumbnail;
  n.estado.textContent = j.status === 'descargando' ? `${Math.round(j.pct || 0)}%` : (ETIQUETAS[j.status] || j.status);
  n.barra.style.width = `${j.pct || 0}%`;
  const partes = [formato(j)];
  if (j.speed) partes.push(`${peso(j.speed)}/s`);
  if (j.total) partes.push(peso(j.total));
  if (j.eta != null && j.status === 'descargando') partes.push(`Queda ${reloj(j.eta)}`);
  if (j.phase && j.phase !== 'descargando') partes.push(j.phase);
  if (j.playlist) partes.push(j.playlist);
  n.fase.textContent = j.error || partes.join(' · ');
  n.fase.title = j.error || j.filepath || '';
  const tipo = ['descargando', 'uniendo', 'convirtiendo'].includes(j.status) ? 'activo'
    : ['en cola', 'leyendo', 'esperando'].includes(j.status) ? 'cola' : j.status;
  if (n.acciones.dataset.t !== tipo) {
    n.acciones.dataset.t = tipo;
    n.acciones.innerHTML = (BOTONES[tipo] || []).map(([a, t]) => `<button type="button" data-a="${a}">${t}</button>`).join('');
  }
}

async function accion(id, a) {
  try {
    if (a === 'open') await api('/api/open', { id });
    else if (a === 'remove') await api(`/api/job/${id}`, null, 'DELETE');
    else if (a === 'transcribe') { await api(`/api/job/${id}/transcribe`); toast('En la cola de Tiro'); }
    else await api(`/api/job/${id}/${a}`);
  } catch (e) { toast(e.message, true); }
}

function quitarJob(id) {
  const n = est.nodos.get(id);
  if (n) n.li.remove();
  est.nodos.delete(id);
  est.jobs.delete(id);
  $('#colaVacia').hidden = est.jobs.size > 0;
}

function refrescarGlobal() {
  const todos = [...est.jobs.values()];
  const activas = todos.filter((j) => ['descargando', 'uniendo', 'convirtiendo'].includes(j.status));
  const enCola = todos.filter((j) => ['en cola', 'leyendo', 'esperando'].includes(j.status)).length;
  const listas = todos.filter((j) => j.status === 'listo').length;
  const veloz = activas.reduce((s, j) => s + (j.speed || 0), 0);
  $('#stActivas').textContent = activas.length;
  $('#stListas').textContent = listas;
  const mb = veloz / 1048576;
  $('#stVeloz').textContent = mb >= 100 ? Math.round(mb) : mb.toFixed(1);
  $('#colaHint').textContent = todos.length ? `${todos.length} en total${enCola ? ` · ${enCola} en cola` : ''}` : '';
  const pausados = todos.some((j) => j.status === 'pausado');
  $('#btnPausar').textContent = pausados && !activas.length ? 'Reanudar todo' : 'Pausar todo';
  const conTotal = todos.filter((j) => !['error', 'cancelado'].includes(j.status));
  const media = conTotal.length ? conTotal.reduce((s, j) => s + (j.pct || 0), 0) / conTotal.length : 0;
  const hay = activas.length || enCola;
  $('#barTop i').style.width = hay ? `${media}%` : '0';
  const live = $('#live');
  if (activas.length) { live.className = 'hot'; live.textContent = `${activas.length} ${activas.length === 1 ? 'activa' : 'activas'} · ${mb.toFixed(1)} MB/s`; }
  else if (enCola) { live.className = 'hot'; live.textContent = `${enCola} en cola`; }
  else { live.className = 'muted'; live.textContent = listas ? `${listas} ${listas === 1 ? 'lista' : 'listas'}` : 'Sin descargas'; }
  document.title = activas.length ? `${Math.round(media)}% · Talaria` : 'Talaria';
}

/* ------------------------------------------------------------ herramientas */

function pintarTools(s) {
  est.tools = s;
  const t = s.tools;
  const yt = t['yt-dlp'];
  const preparando = Object.values(t).find((x) => ['buscando', 'descargando', 'extrayendo'].includes(x.status));
  $('#metaTools').textContent = preparando
    ? `Instalando ${preparando.label} ${preparando.pct || 0}%`
    : (yt.version ? `yt-dlp ${yt.version}` : 'yt-dlp —');
  $('#tools').innerHTML = Object.values(t).map((x) => `<li><b>${E(x.label)}${x.required ? '' : ' · opcional'}</b><span class="${x.status === 'error' ? 'err' : 'muted'}">${E(x.status === 'listo' ? (x.version || 'listo') + ' ✓' : x.status === 'error' ? x.error || 'error' : `${x.status} ${x.pct ? x.pct + '%' : ''}`)}</span></li>`).join('');
}

/* ---------------------------------------------------------------- historial */

function pintarHistorial() {
  const q = $('#histQ').value.trim().toLowerCase();
  const lista = est.historial.filter((h) => !q || `${h.title} ${h.uploader || ''}`.toLowerCase().includes(q));
  $('#nHist').textContent = est.historial.length || '';
  const bytes = est.historial.reduce((s, h) => s + (h.size || 0), 0);
  const seg = est.historial.reduce((s, h) => s + (h.duration || 0), 0);
  $('#hsN').textContent = est.historial.length;
  const gb = bytes >= 1073741824;
  $('#hsG').textContent = gb ? (bytes / 1073741824).toFixed(1) : Math.round(bytes / 1048576);
  $('#hsGu').textContent = gb ? 'GB en disco' : 'MB en disco';
  const horas = seg >= 3600;
  $('#hsH').textContent = horas ? (seg / 3600).toFixed(1) : Math.round(seg / 60);
  $('#hsHu').textContent = horas ? 'Horas' : 'Minutos';
  $('#histVacio').hidden = est.historial.length > 0;
  $('#histHint').textContent = q ? `${lista.length} resultados` : '';
  const ul = $('#histLista');
  ul.innerHTML = '';
  lista.slice(0, 300).forEach((h, i) => {
    const li = document.createElement('li');
    li.className = 'h-fila';
    li.dataset.i = String(est.historial.indexOf(h));
    const d = h.finishedAt ? new Date(h.finishedAt).toLocaleDateString('es', { day: '2-digit', month: 'short' }) : '';
    li.innerHTML = `<div class="j-mini"></div><div><b title="${E(h.title)}">${E(h.title)}</b><small>${E([formato(h), peso(h.size), h.duration ? reloj(h.duration) : '', d, h.uploader].filter(Boolean).join(' · '))}</small></div><div class="job-a"><button type="button" data-a="abrir">Abrir</button><button type="button" data-a="otra">Otra vez</button></div>`;
    $('.j-mini', li).appendChild(miniatura(h.thumbnail));
    ul.appendChild(li);
  });
}

/* ----------------------------------------------------------------- acciones */

async function descargar() {
  const caja = $('#enlaces');
  const text = caja.value.trim();
  if (!text) { caja.focus(); return; }
  const clip = { desde: $('#clipDesde').value.trim(), hasta: $('#clipHasta').value.trim() };
  caja.value = '';                 // ya: un segundo Ctrl+Enter no vuelve a mandar lo mismo
  $('#clipDesde').value = '';
  $('#clipHasta').value = '';
  try {
    const r = await api('/api/add', { text, options: { clip } });
    toast(`${r.added} ${r.added === 1 ? 'enlace' : 'enlaces'} en marcha`);
  } catch (e) {
    caja.value = text;
    $('#clipDesde').value = clip.desde;
    $('#clipHasta').value = clip.hasta;
    toast(e.message, true);
  }
}

const VS = [
  ['Talaria', 'En tu equipo, sin cuentas ni anuncios. <em>Cola con límite, se repara sola cuando YouTube cambia</em>, no repite lo ya bajado y arranca al instante: solo necesita Node. Pasa lo descargado a Tiro para transcribirlo. Gratis y de código abierto.', true],
  ['Youwee', '<em>Hace mucho más que Talaria</em>: resúmenes con IA, plugins, editor de subtítulos, Telegram. Es una app que hay que instalar; Talaria es para pegar y bajar.'],
  ['4K Video Downloader+', 'El plan gratis pone <em>un tope diario de descargas</em> y lleva anuncios. La suscripción empieza en unos 15 USD al año.'],
  ['Parabolic', 'Libre y sobre yt-dlp, pero <em>las reseñas recientes en Windows señalan fallos</em> con los subtítulos.'],
  ['ytDownloader', 'Libre y muy popular, <em>hecho en Electron</em>: instala un navegador entero para hacer de interfaz.'],
  ['ArcDLP', 'Libre y en Electron. Su cola es <em>secuencial</em>: una descarga detrás de otra.'],
  ['Cobalt', 'Web sin instalar, pero <em>depende de un servidor ajeno</em> y las limitaciones de YouTube lo afectan a menudo.'],
];

/* --------------------------------------------------------------- arranque */

function enganchar() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-ir]');
    if (a && !e.ctrlKey && !e.metaKey) { e.preventDefault(); ir(a.dataset.ir); }
  });
  window.addEventListener('popstate', () => ir(rutaActual(), false));

  $$('.seg[data-key]').forEach((el) => el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    let v = b.dataset.v;
    if (v === 'true' || v === 'false') v = v === 'true';
    cambiar({ [el.dataset.key]: v });
  }));

  $('#btnDescargar').addEventListener('click', descargar);
  $('#btnPegar').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      $('#enlaces').value = ($('#enlaces').value ? `${$('#enlaces').value}\n` : '') + t;
    } catch (e) { $('#enlaces').focus(); toast('Pega con Ctrl+V'); }
  });
  $('#enlaces').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); descargar(); } });

  // pegar en cualquier parte de la ventana: el enlace cae en la caja
  document.addEventListener('paste', (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName || '')) return;
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!/https?:\/\//.test(t)) return;
    e.preventDefault();
    if (est.pagina !== 'descargar') ir('descargar');
    const caja = $('#enlaces');
    caja.value = (caja.value ? `${caja.value}\n` : '') + t.trim();
    caja.focus();
  });
  // soltar un enlace arrastrado desde el navegador
  document.addEventListener('dragover', (e) => { e.preventDefault(); $('#enlaces').classList.add('over'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#enlaces').classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    $('#enlaces').classList.remove('over');
    const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text');
    if (t) { const c = $('#enlaces'); c.value = (c.value ? `${c.value}\n` : '') + t.trim(); }
  });

  $('#btnPausar').addEventListener('click', () => api($('#btnPausar').textContent.startsWith('Reanudar') ? '/api/resume-all' : '/api/pause-all').catch(() => {}));
  $('#btnReintentar').addEventListener('click', () => api('/api/retry-failed').catch(() => {}));
  $('#btnLimpiar').addEventListener('click', () => api('/api/clear').catch(() => {}));
  $('#btnCarpeta').addEventListener('click', () => api('/api/open').catch(() => {}));

  $('#histQ').addEventListener('input', pintarHistorial);
  $('#histLista').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const h = est.historial[+b.closest('li').dataset.i];
    if (b.dataset.a === 'abrir') api('/api/open', { filepath: h.filepath }).catch(() => {});
    else {
      await api('/api/add', { text: h.url, options: { mode: h.mode, quality: h.quality, container: h.container, format: h.format, dedupe: false } }).catch((x) => toast(x.message, true));
      ir('descargar');
    }
  });
  $('#btnVaciarHist').addEventListener('click', () => {
    const b = $('#btnVaciarHist');
    if (!b.classList.contains('armado')) {
      b.classList.add('armado');
      b.textContent = '¿Seguro? Vaciar';
      setTimeout(() => { b.classList.remove('armado'); b.textContent = 'Vaciar'; }, 3500);
      return;
    }
    b.classList.remove('armado');
    b.textContent = 'Vaciar';
    api('/api/history/clear').catch(() => {});
  });

  $('#outDir').addEventListener('change', () => cambiar({ outDir: $('#outDir').value }));
  $('#btnElegir').addEventListener('click', async () => {
    const r = await api('/api/pick-folder').catch(() => ({}));
    if (r.outDir) { est.cfg.outDir = r.outDir; pintarOpciones(); }
  });
  $('#btnActualizar').addEventListener('click', async () => {
    const b = $('#btnActualizar');
    b.textContent = 'Buscando…';
    try {
      const r = await api('/api/tools/update');
      toast(r.actualizado ? `yt-dlp actualizado a ${r.version}` : r.pendiente ? 'Hay versión nueva: se instala al terminar las descargas' : `yt-dlp ya está al día (${r.version || ''})`);
    } catch (e) { toast(e.message, true); }
    b.textContent = 'Buscar actualización';
  });
}

function conectar() {
  const es = new EventSource('/api/events');
  es.addEventListener('tools', (ev) => pintarTools(JSON.parse(ev.data)));
  es.addEventListener('sync', (ev) => {
    const lista = JSON.parse(ev.data);
    [...est.jobs.keys()].filter((id) => !lista.some((j) => j.id === id)).forEach(quitarJob);
    lista.forEach((j) => { est.jobs.set(j.id, j); pintarJob(j); });
    refrescarGlobal();
  });
  es.addEventListener('job', (ev) => {
    const j = JSON.parse(ev.data);
    if (j.removed) quitarJob(j.id);
    else { est.jobs.set(j.id, j); pintarJob(j); }
    refrescarGlobal();
  });
  es.addEventListener('history', (ev) => {
    est.historial = JSON.parse(ev.data);
    $('#nHist').textContent = est.historial.length || '';
    if (est.pagina === 'historial') pintarHistorial();
  });
  es.onerror = () => { const l = $('#live'); l.className = 'hot'; l.textContent = 'Sin servidor'; };
}

async function arrancar() {
  const s = await api('/api/state', null, 'GET');
  est.cfg = s.config;
  est.historial = s.history || [];
  $('#nHist').textContent = est.historial.length || '';
  $('#vs').innerHTML = VS.map(([n, t, yo]) => `<li${yo ? ' class="yo"' : ''}><b>${n}</b><span>${t}</span></li>`).join('');
  pintarOpciones();
  enganchar();
  ir(rutaActual(), false);
  conectar();
}

arrancar();
