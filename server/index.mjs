// Talaria - servidor local sin dependencias: solo Node. Sirve la interfaz, la API
// y los sucesos en vivo. Arranca en milisegundos porque no hay nada que construir.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { ensureTools, onToolChange, toolState, toolPath, updateYtDlp, ROOT } from './tools.mjs'
import {
  jobs, snapshot, onJobChange, onFinished, resolveEntries, createJob, encolar, setConfig, claveDe,
  cancelJob, pauseJob, retryJob, removeJob, clearFinished, pauseAll, resumeAll, retryFailed, hayActivos, traducirError,
} from './downloads.mjs'

const PORT = Number(process.env.PORT || 5241)
const HOST = '127.0.0.1'
const PUBLIC = path.join(ROOT, 'public')
const DATOS = path.join(os.homedir(), 'Documents', 'Talaria')
const F_AJUSTES = path.join(DATOS, 'ajustes.json')
const F_HISTORIAL = path.join(DATOS, 'historial.json')
const PAGINAS = new Set(['/', '/descargar', '/historial', '/ajustes'])
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg' }

const POR_DEFECTO = {
  outDir: path.join(os.homedir(), 'Downloads', 'Talaria'),
  mode: 'video', quality: 'best', container: 'mp4', format: 'mp3',
  subs: false, sponsor: false, useAria2: false,
  parallel: 'auto', fragments: 16, rateLimit: '', cookiesFromBrowser: '', dedupe: true, autoUpdate: true,
}
const PERMITIDO = {
  mode: ['video', 'audio'], quality: ['best', '2160', '1440', '1080', '720', '480'], container: ['mp4', 'mkv'],
  format: ['mp3', 'm4a', 'opus', 'flac', 'wav', 'original'], parallel: ['auto', '2', '4', '8', '16', 'inf'],
  rateLimit: ['', '1M', '5M', '10M'], cookiesFromBrowser: ['', 'firefox', 'chrome', 'edge', 'brave'],
}

function leerJson(f, porDefecto) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return porDefecto }
}
let config = { ...POR_DEFECTO, ...leerJson(F_AJUSTES, {}) }
let historial = leerJson(F_HISTORIAL, [])
fs.mkdirSync(DATOS, { recursive: true })

const guardarConfig = () => fsp.writeFile(F_AJUSTES, JSON.stringify(config, null, 2), 'utf8').catch(() => {})
let tGuardar = null
const guardarHistorial = () => {
  clearTimeout(tGuardar)
  tGuardar = setTimeout(() => fsp.writeFile(F_HISTORIAL, JSON.stringify(historial), 'utf8').catch(() => {}), 300)
}

/** Solo valores conocidos: esto acaba en la linea de comandos de yt-dlp. */
function saneado(entrada = {}) {
  const out = {}
  for (const [k, v] of Object.entries(entrada)) {
    if (PERMITIDO[k]) { if (PERMITIDO[k].includes(String(v))) out[k] = String(v) }
    else if (['subs', 'sponsor', 'useAria2', 'dedupe', 'autoUpdate'].includes(k)) out[k] = !!v
    else if (k === 'outDir' && typeof v === 'string' && v.trim()) out.outDir = v.trim().slice(0, 400)
  }
  return out
}
const HORA = /^(\d{1,2}:)?\d{1,2}:\d{2}$|^\d+$/
function clipDe(c) {
  if (!c) return null
  const desde = HORA.test(c.desde || '') ? c.desde : ''
  const hasta = HORA.test(c.hasta || '') ? c.hasta : ''
  return desde || hasta ? { desde, hasta } : null
}

// ---------------------------------------------------------------- historial

onFinished((job) => {
  let size = null
  try { size = job.filepath ? fs.statSync(job.filepath).size : null } catch { /* movido */ }
  historial.unshift({
    key: claveDe(job), id: job.videoId, title: job.title, url: job.url, filepath: job.filepath, size,
    mode: job.mode, quality: job.quality, container: job.container, format: job.format,
    uploader: job.uploader, duration: job.duration, thumbnail: job.thumbnail, finishedAt: job.finishedAt,
  })
  historial = historial.slice(0, 2000)
  guardarHistorial()
  difundir('history', historial.slice(0, 500))
  if (!hayActivos() && pendienteActualizar) comprobarYtDlp()
})

// ------------------------------------------------------------------ eventos

const clientes = new Set()
function difundir(tipo, dato) {
  const linea = `event: ${tipo}\ndata: ${JSON.stringify(dato)}\n\n`
  for (const res of clientes) res.write(linea)
}
onToolChange((s) => difundir('tools', s))
onJobChange((j) => difundir('job', j))

// --------------------------------------------------------------- actualizar

let pendienteActualizar = false
async function comprobarYtDlp() {
  if (!config.autoUpdate) return
  const r = await updateYtDlp({ ocupado: hayActivos }).catch(() => null)
  pendienteActualizar = !!r?.pendiente
}

// -------------------------------------------------------------------- añadir

const URL_RE = /https?:\/\/[^\s"'<>]+/gi

/** La pagina responde al instante: cada enlace aparece y se resuelve detras. */
async function anadir(texto, opciones) {
  const urls = [...new Set((String(texto).match(URL_RE) || []).map((u) => u.replace(/[.,)\]]+$/, '')))]
  if (!urls.length) throw Object.assign(new Error('No se encontró ningún enlace válido'), { codigo: 400 })
  const opts = { ...config, ...saneado(opciones), clip: clipDe(opciones?.clip) }
  await fsp.mkdir(opts.outDir, { recursive: true }).catch((e) => {
    throw Object.assign(new Error(`No se pudo usar la carpeta de destino: ${e.message}`), { codigo: 400 })
  })
  for (const url of urls) {
    const fantasma = createJob({ url, title: url }, { ...opts, status: 'leyendo', phase: 'leyendo el enlace' })
    fantasma.fantasma = true
    resolver(fantasma, url, opts)
  }
  return { added: urls.length }
}

async function resolver(fantasma, url, opts) {
  try {
    await ensureTools()
    if (!toolState.ready) throw new Error('Las herramientas todavía no están listas')
    const { playlist, entries } = await resolveEntries(url, opts)
    if (!jobs.has(fantasma.id) || fantasma.status === 'cancelado') return   // lo quitaron mientras se leia
    const enPausa = fantasma.status === 'pausado'
    removeJob(fantasma.id)
    const dir = playlist ? path.join(opts.outDir, playlist.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'Playlist') : opts.outDir
    if (playlist) await fsp.mkdir(dir, { recursive: true })
    for (const entry of entries) {
      const job = createJob(entry, { ...opts, playlist, outDir: dir, status: 'leyendo' })
      const previo = opts.dedupe && historial.find((h) => h.key === claveDe(job))
      if (previo && previo.filepath && fs.existsSync(previo.filepath)) {
        Object.assign(job, { status: 'listo', phase: 'ya estaba descargado', pct: 100, filepath: previo.filepath, finishedAt: Date.now(), repetido: true })
        difundir('job', (({ proc, infoJson, log, ...r }) => r)(job))
        continue
      }
      if (enPausa) {
        job.status = 'pausado'
        job.phase = 'pausado'
        difundir('job', (({ proc, infoJson, log, ...r }) => r)(job))
        continue
      }
      encolar(job, config)
    }
  } catch (err) {
    Object.assign(fantasma, { status: 'error', phase: '', error: traducirError(String(err.message || err)), finishedAt: Date.now() })
    difundir('job', (({ proc, infoJson, log, ...r }) => r)(fantasma))
  }
}

// --------------------------------------------------------------------- tiro

/** Descarga y transcribe: manda el archivo a Tiro (eyverqt/tiro) en este equipo. */
async function aTiro(job) {
  if (!job?.filepath || !fs.existsSync(job.filepath)) throw Object.assign(new Error('Ese archivo ya no está en el disco'), { codigo: 404 })
  let r
  try {
    r = await fetch('http://127.0.0.1:5240/api/encolar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivos: [{ ruta: job.filepath, nombre: path.basename(job.filepath) }] }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw Object.assign(new Error('Tiro no está abierto: ejecuta su start.bat'), { codigo: 503 })
  }
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.encolados?.length) throw new Error(d.rechazados?.[0]?.motivo || d.error || 'Tiro no aceptó el archivo')
  return { ok: true, abrir: 'http://127.0.0.1:5240/transcribir' }
}

// ----------------------------------------------------------------- utilidades

function json(res, obj, codigo = 200) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

async function cuerpo(req) {
  let datos = ''
  for await (const trozo of req) {
    datos += trozo
    if (datos.length > 2e6) throw new Error('petición demasiado grande')
  }
  return datos ? JSON.parse(datos) : {}
}

/**
 * La API solo responde a la propia app y a la extension: sin esto, cualquier
 * web abierta podria ordenar descargas o cambiar ajustes en tu equipo.
 */
function permitido(req) {
  const host = req.headers.host || ''
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return false
  const origen = req.headers.origin
  if (!origen) return true
  if (origen === `http://${host}`) return true
  return origen.startsWith('chrome-extension://') && /^\/api\/(add|ping)/.test(req.url)
}

function abrirExplorador(filepath) {
  if (filepath && fs.existsSync(filepath)) return execFile('explorer', ['/select,', path.resolve(filepath)], { windowsHide: true }, () => {})
  fs.mkdirSync(config.outDir, { recursive: true })
  execFile('explorer', [path.resolve(config.outDir)], { windowsHide: true }, () => {})
}

function elegirCarpeta() {
  const ps = ['Add-Type -AssemblyName System.Windows.Forms', '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "Carpeta de descargas"', '$f = New-Object System.Windows.Forms.Form', '$f.TopMost = $true',
    'if ($d.ShowDialog($f) -eq "OK") { Write-Output $d.SelectedPath }'].join('; ')
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, timeout: 180000 }, (_e, out) => resolve(String(out || '').trim()))
  })
}

async function estatico(req, res, ruta) {
  const destino = PAGINAS.has(ruta) ? '/index.html' : ruta
  const archivo = path.normalize(path.join(PUBLIC, destino))
  if (!archivo.startsWith(PUBLIC)) { res.writeHead(403); return res.end() }
  try {
    const datos = await fsp.readFile(archivo)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(archivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(datos)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('No encontrado')
  }
}

// ---------------------------------------------------------------- servidor

const servidor = http.createServer(async (req, res) => {
  const { pathname: ruta } = new URL(req.url, `http://${HOST}:${PORT}`)
  try {
    if (!ruta.startsWith('/api/')) return await estatico(req, res, ruta)
    if (!permitido(req)) return json(res, { error: 'origen no permitido' }, 403)
    if (req.headers.origin?.startsWith('chrome-extension://')) res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204); return res.end()
    }

    if (req.method === 'GET') {
      if (ruta === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
        clientes.add(res)
        res.write(`event: tools\ndata: ${JSON.stringify(toolState)}\n\n`)
        res.write(`event: sync\ndata: ${JSON.stringify(snapshot())}\n\n`)
        const ping = setInterval(() => res.write(': ping\n\n'), 20000)
        req.on('close', () => { clearInterval(ping); clientes.delete(res) })
        return
      }
      if (ruta === '/api/state') return json(res, { tools: toolState, jobs: snapshot(), config, history: historial.slice(0, 500) })
      if (ruta === '/api/ping') return json(res, { ok: true, app: 'talaria' })
      return json(res, { error: 'ruta desconocida' }, 404)
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, { error: 'método no permitido' }, 405)
    const b = await cuerpo(req)
    const m = ruta.match(/^\/api\/job\/([\w-]+)\/?(\w+)?$/)
    if (m) {
      const [, id, accion] = m
      if (req.method === 'DELETE') return json(res, { ok: removeJob(id) })
      if (accion === 'cancel') return json(res, { ok: cancelJob(id) })
      if (accion === 'pause') return json(res, { ok: pauseJob(id) })
      if (accion === 'retry') return json(res, { ok: retryJob(id, config) })
      if (accion === 'transcribe') return json(res, await aTiro(jobs.get(id)))
    }
    switch (ruta) {
      case '/api/add': return json(res, await anadir(b.text, b.options))
      case '/api/config':
        config = { ...config, ...saneado(b) }
        await guardarConfig()
        setConfig(config)
        return json(res, config)
      case '/api/clear': clearFinished(); return json(res, { ok: true })
      case '/api/pause-all': pauseAll(); return json(res, { ok: true })
      case '/api/resume-all': resumeAll(config); return json(res, { ok: true })
      case '/api/retry-failed': retryFailed(config); return json(res, { ok: true })
      case '/api/history/clear':
        historial = []
        guardarHistorial()
        difundir('history', [])
        return json(res, { ok: true })
      case '/api/open':
        abrirExplorador(b.id ? jobs.get(b.id)?.filepath : b.filepath && historial.some((h) => h.filepath === b.filepath) ? b.filepath : null)
        return json(res, { ok: true })
      case '/api/pick-folder': {
        const dir = await elegirCarpeta()
        if (!dir) return json(res, { cancelled: true })
        config.outDir = dir
        await guardarConfig()
        return json(res, { outDir: dir })
      }
      case '/api/tools/update':
        return json(res, await updateYtDlp({ force: !!b.force, ocupado: hayActivos }))
      case '/api/tools/retry':
        ensureTools({ force: true }).catch(() => {})
        return json(res, { ok: true })
      default:
        return json(res, { error: 'ruta desconocida' }, 404)
    }
  } catch (err) {
    if (!res.headersSent) json(res, { error: String(err.message || err) }, err.codigo || 500)
  }
})

servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Talaria ya está abierta en http://${HOST}:${PORT}/\n`)
    process.exit(0)
  }
  throw err
})

servidor.listen(PORT, HOST, () => {
  setConfig(config)
  console.log(`\n  Talaria escuchando en http://${HOST}:${PORT}/`)
  console.log(`  Descargas en ${config.outDir}\n`)
  ensureTools().then(() => comprobarYtDlp()).catch(() => {})
  setInterval(comprobarYtDlp, 6 * 3600 * 1000).unref()
  if (process.argv.includes('--abrir')) execFile('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}/`], { windowsHide: true }, () => {})
})

process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ECONNRESET')) return console.warn('  [aviso]', err.message)
  throw err
})

export { toolPath }
