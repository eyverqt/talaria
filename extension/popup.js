// Talaria - boton de la extension: manda la pestaña actual a la app local.
const BASE = 'http://127.0.0.1:5241';
const $ = (s) => document.querySelector(s);
let url = '';

function estado(texto, malo) {
  $('#estado').textContent = texto;
  $('#estado').className = malo ? 'err' : 'muted';
}

async function enviar(mode) {
  try {
    const r = await fetch(`${BASE}/api/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: url, options: { mode } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `error ${r.status}`);
    estado('En marcha ✓');
    setTimeout(() => window.close(), 900);
  } catch (e) {
    estado(/fetch/i.test(e.message) ? 'Talaria no está abierta: ejecuta start.bat' : e.message, true);
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  url = (tab && tab.url) || '';
  $('#titulo').textContent = (tab && tab.title) || url;
  if (!/^https?:/.test(url)) {
    estado('Abre una página con un vídeo', true);
    $('#video').disabled = true;
    $('#audio').disabled = true;
  }
});
$('#video').addEventListener('click', () => enviar('video'));
$('#audio').addEventListener('click', () => enviar('audio'));
