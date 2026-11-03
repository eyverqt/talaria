// Talaria - clic derecho en una pagina o enlace: lo manda a la app local.
const API = 'http://127.0.0.1:5241/api/add';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'video', title: 'Descargar con Talaria', contexts: ['page', 'link', 'video'] });
  chrome.contextMenus.create({ id: 'audio', title: 'Solo audio con Talaria', contexts: ['page', 'link', 'video'] });
});

function aviso(texto, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: texto });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.srcUrl || info.pageUrl || (tab && tab.url);
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: url, options: { mode: info.menuItemId } }),
    });
    aviso(r.ok ? '✓' : '!', r.ok ? '#2e2e30' : '#ff2400');
  } catch (e) {
    aviso('!', '#ff2400');      // Talaria no esta abierto
  }
});
