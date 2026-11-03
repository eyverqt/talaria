// Talaria - gestor de descargas.
//
// Cada video es un proceso de yt-dlp, pero no se lanzan todos a la vez: una
// playlist de 200 tumbaria el equipo y YouTube responderia con 429. Un
// planificador abre tantos huecos como permita el ajuste de simultaneas y va
// sacando de la cola. Si algo falla, se intenta arreglar solo antes de avisar.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { toolPath, updateYtDlp } from './tools.mjs'

export const jobs = new Map()

const listeners = new Set()
export function onJobChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const publicJob = ({ proc, infoJson, log, ...rest }) => rest
function emit(job) {
  for (const fn of listeners) fn(publicJob(job))
}
function update(job, patch) {
  Object.assign(job, patch)
  emit(job)
}

export const snapshot = () => [...jobs.values()].map(publicJob).sort((a, b) => a.createdAt - b.createdAt)

const TERMINADOS = ['listo', 'error', 'cancelado', 'pausado']
const activos = () => [...jobs.values()].filter((j) => j.proc || j.status === 'esperando')
export const hayActivos = () => activos().length > 0

// ------------------------------------------------------------------ formatos

const ALTURAS = { 4320: 4320, 2160: 2160, 1440: 1440, 1080: 1080, 720: 720, 480: 480 }

function videoFormat(quality, container) {
  const h = ALTURAS[quality]
  const cap = h ? `[height<=${h}]` : ''
  if (container === 'mp4') {
    // Pistas ya compatibles con MP4: asi no hay que recodificar nada.
    return [`bv*${cap}[vcodec^=avc1][ext=mp4]+ba[ext=m4a]`, `bv*${cap}[ext=mp4]+ba[ext=m4a]`, `bv*${cap}+ba`, `b${cap}`, 'b'].join('/')
  }
  return [`bv*${cap}+ba`, `b${cap}`, 'b'].join('/')    // MKV: AV1/VP9 + Opus, lo mejor que haya
}

function audioArgs(format) {
  const base = ['-f', 'ba[acodec=opus]/ba/b', '-x', '--audio-quality', '0']
  return [...base, '--audio-format', format === 'original' ? 'best' : format]
}

const PROGRESO =
  'download:@@%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s'

export function buildArgs(job, cfg) {
  const ffmpeg = toolPath('ffmpeg')
  const args = [
    '--ignore-config', '--no-playlist', '--newline', '--no-warnings', '--no-color',
    '--no-quiet', '--progress', '--progress-template', PROGRESO,
    '--print', 'after_move:@@F%(filepath)s',
    '--retries', '10', '--fragment-retries', '10', '--continue',
    '--windows-filenames', '--trim-filenames', '180',
    // Node ya esta aqui: yt-dlp lo usa para resolver el reto de YouTube y asi
    // ver todos los formatos sin instalar otro runtime de JavaScript.
    '--js-runtimes', `node:${process.execPath}`,
    '-P', job.outDir,
    '-o', '%(title)s [%(id)s].%(ext)s',
    '--embed-metadata',
  ]
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg))
  if (!(job.mode === 'audio' && job.format === 'wav')) args.push('--embed-thumbnail')

  // Un recorte lo baja ffmpeg, no se puede acelerar con aria2c
  const seccion = job.clip && (job.clip.desde || job.clip.hasta)
  if (job.useAria2 && !seccion && toolPath('aria2c')) {
    args.push('--downloader', toolPath('aria2c'),
      '--downloader-args', 'aria2c:-x16 -s16 -k1M --min-split-size=1M --file-allocation=none --console-log-level=warn')
  } else if (!seccion) {
    args.push('-N', String(cfg.fragments || 16), '--http-chunk-size', '10M')
  }

  if (job.mode === 'audio') {
    args.push(...audioArgs(job.format || 'mp3'))
  } else {
    args.push('-f', videoFormat(job.quality || 'best', job.container || 'mp4'))
    args.push('--merge-output-format', job.container || 'mp4')
    if (job.subs) args.push('--embed-subs', '--sub-langs', 'es.*,en.*', '--write-auto-subs')
  }

  if (seccion) args.push('--download-sections', `*${job.clip.desde || '0:00'}-${job.clip.hasta || 'inf'}`, '--force-keyframes-at-cuts')
  if (job.sponsor) args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction')
  if (cfg.rateLimit) args.push('-r', String(cfg.rateLimit))
  if (cfg.cookiesFromBrowser) args.push('--cookies-from-browser', cfg.cookiesFromBrowser)
  if (job.cliente) args.push('--extractor-args', `youtube:player_client=${job.cliente}`)

  // La informacion ya leida al resolver evita repetir la extraccion: arranca antes.
  if (job.infoJson && fs.existsSync(job.infoJson) && !job.intentos) args.push('--load-info-json', job.infoJson)
  else args.push('--', job.url)
  return args
}

// ----------------------------------------------------------------- resolver

const entorno = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

function limpiarError(texto) {
  const linea = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^error/i.test(l)).pop()
  return (linea || '').replace(/^ERROR:\s*/i, '')
}

// Leer un enlace resuelve el reto de JavaScript de YouTube y gasta CPU: con todos
// a la vez, el primero tarda el triple en empezar.
const LECTORES = Math.max(2, Math.min(4, Math.floor((os.cpus().length || 4) / 2)))
let leyendo = 0
const turnos = []
async function conTurno(fn) {
  if (leyendo >= LECTORES) await new Promise((r) => turnos.push(r))
  leyendo++
  try {
    return await fn()
  } finally {
    leyendo--
    turnos.shift()?.()
  }
}

/** Devuelve 1 entrada o N si es playlist o canal. */
export const resolveEntries = (url, cfg = {}) => conTurno(() => leerEnlace(url, cfg))

async function leerEnlace(url, cfg) {
  const yt = toolPath('yt-dlp')
  if (!yt) throw new Error('yt-dlp no esta disponible')
  const args = ['--ignore-config', '--no-warnings', '--no-color', '--flat-playlist', '--dump-single-json',
    '--skip-download', '--js-runtimes', `node:${process.execPath}`]
  if (cfg.cookiesFromBrowser) args.push('--cookies-from-browser', cfg.cookiesFromBrowser)
  args.push('--', url)
  let errores = ''
  const salida = await new Promise((resolve, reject) => {
    execFile(yt, args, { windowsHide: true, maxBuffer: 1 << 27, env: entorno, encoding: 'utf8' }, (err, stdout, stderr) => {
      errores = stderr
      if (err && !stdout) return reject(new Error(traducirError(limpiarError(stderr) || err.message)))
      resolve(stdout)
    })
  })
  let data = null
  try {
    data = JSON.parse(salida)
  } catch { /* abajo */ }
  // yt-dlp escribe "null" cuando no puede con el enlace: el motivo esta en stderr
  if (!data) throw new Error(traducirError(limpiarError(errores) || 'No se pudo leer la información del enlace'))
  const aEntrada = (e) => ({
    url: e.webpage_url || e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : url),
    title: e.title || 'Sin titulo',
    id: e.id || null,
    duration: e.duration || null,
    uploader: e.uploader || e.channel || e.playlist_uploader || null,
    thumbnail: e.thumbnail || (e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1].url : e.id && /youtu/.test(url) ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : null),
  })
  if (Array.isArray(data.entries)) {
    return { playlist: data.title || null, entries: data.entries.filter(Boolean).map(aEntrada) }
  }
  let infoJson = null
  if (data.formats) {
    infoJson = path.join(os.tmpdir(), `talaria-info-${randomUUID()}.json`)
    await fsp.writeFile(infoJson, salida, 'utf8').catch(() => { infoJson = null })
  }
  return { playlist: null, entries: [{ ...aEntrada(data), infoJson }] }
}

// ---------------------------------------------------------------- errores

const MENSAJES = [
  [/sign in to confirm|not a bot/i, 'YouTube pide iniciar sesión. Elige un navegador en Ajustes → Cookies y reintenta.'],
  [/logged.?in|login required|use --cookies/i, 'Este sitio pide iniciar sesión. Elige un navegador en Ajustes → Cookies y reintenta.'],
  [/age.?restrict|confirm your age/i, 'Vídeo con restricción de edad. Elige un navegador en Ajustes → Cookies y reintenta.'],
  [/could not copy .*cookie|could not find .*cookies/i, 'No se pudieron leer las cookies: cierra ese navegador o usa Firefox.'],
  [/private video/i, 'Vídeo privado. Si tienes acceso, activa las cookies en Ajustes.'],
  [/video unavailable|not available in your country/i, 'El vídeo no está disponible (borrado o bloqueado en tu país).'],
  [/unsupported url/i, 'Este sitio todavía no está soportado por yt-dlp.'],
  [/no space left/i, 'No queda espacio en el disco de destino.'],
]
export function traducirError(msg) {
  for (const [re, txt] of MENSAJES) if (re.test(msg)) return txt
  return msg
}

const ES_COOKIES = /sign in|logged.?in|login required|age.?restrict|private video|cookie|members.only/i
const ES_LIMITE = /HTTP Error 429|too many requests/i
const ES_ROTURA = /HTTP Error 403|requested format is not available|unable to extract|nsig|signature|player response|SABR/i

// --------------------------------------------------------------- planificador

let cfgActual = {}

function limite(cfg) {
  const p = cfg.parallel
  if (p === 'inf') return Infinity
  const n = Number(p)
  if (n > 0) return n
  return Math.max(3, Math.min(8, Math.floor((os.cpus().length || 4) / 2)))     // auto
}

function bombear() {
  const cupo = limite(cfgActual)
  let enMarcha = [...jobs.values()].filter((j) => j.proc).length
  for (const job of jobs.values()) {
    if (enMarcha >= cupo) break
    if (job.status === 'en cola' && !job.proc && !(job.noAntes > Date.now())) {
      arrancar(job, cfgActual)
      enMarcha++
    }
  }
}

setInterval(bombear, 2000).unref()      // despierta a los que esperaban por un 429

// ----------------------------------------------------------------- ejecucion

export function createJob(entry, opts) {
  const job = {
    id: randomUUID(),
    url: entry.url, videoId: entry.id || null,
    title: entry.title || entry.url,
    thumbnail: entry.thumbnail || null,
    duration: entry.duration || null,
    uploader: entry.uploader || null,
    playlist: opts.playlist || null,
    infoJson: entry.infoJson || null,
    mode: opts.mode || 'video', quality: opts.quality || 'best', container: opts.container || 'mp4',
    format: opts.format || 'mp3', subs: !!opts.subs, useAria2: !!opts.useAria2, sponsor: !!opts.sponsor,
    clip: opts.clip || null,
    outDir: opts.outDir,
    status: opts.status || 'en cola', phase: opts.phase || '', pct: 0, speed: null, eta: null,
    downloaded: 0, total: null, filepath: null, error: null,
    log: [], intentos: 0, cliente: null, actualizado: false, noAntes: 0,
    createdAt: Date.now(), finishedAt: null, proc: null,
  }
  jobs.set(job.id, job)
  emit(job)
  return job
}

export function encolar(job, cfg) {
  cfgActual = cfg
  update(job, { status: 'en cola', phase: '', error: null })
  bombear()
}

export function setConfig(cfg) {
  cfgActual = cfg
  bombear()
}

export const claveDe = (j) => [j.videoId || j.url, j.mode, j.mode === 'audio' ? j.format : j.quality, j.mode === 'audio' ? '' : j.container, j.clip ? `${j.clip.desde}-${j.clip.hasta}` : ''].join('|')

let alTerminar = () => {}
export function onFinished(fn) { alTerminar = fn }

function terminarBien(job) {
  update(job, { status: 'listo', phase: '', pct: 100, speed: null, eta: null, finishedAt: Date.now() })
  alTerminar(job)
  borrarInfo(job)
}

function borrarInfo(job) {
  if (job.infoJson) fsp.rm(job.infoJson, { force: true }).catch(() => {})
  job.infoJson = null
}

function arrancar(job, cfg) {
  const yt = toolPath('yt-dlp')
  if (!yt) return update(job, { status: 'error', error: 'yt-dlp no está disponible' })
  update(job, { status: 'descargando', phase: 'iniciando', error: null })
  const proc = spawn(yt, buildArgs(job, cfg), { windowsHide: true, env: entorno })
  job.proc = proc

  const alLinea = (linea) => {
    if (!linea) return
    // taskkill tarda: lo que aun llegue de un proceso parado no cambia su estado
    if (job.proc !== proc || job.status === 'pausado' || job.status === 'cancelado') return
    if (linea.startsWith('@@F')) { job.filepath = linea.slice(3).trim(); return }
    if (linea.startsWith('@@')) {
      const [estado, bajado, total, estimado, veloc, eta, fi, fc] = linea.slice(2).split('|')
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
      const tot = num(total) ?? num(estimado)
      const dl = num(bajado) ?? 0
      let pct = tot ? (dl / tot) * 100 : job.pct
      if (!tot && num(fc)) pct = ((num(fi) || 0) / num(fc)) * 100
      const ahora = Date.now()
      if (estado !== 'finished' && ahora - (job._ultimo || 0) < 200) return    // no saturar la pagina
      job._ultimo = ahora
      update(job, { status: 'descargando', phase: 'descargando', pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)), speed: num(veloc), eta: num(eta), downloaded: dl, total: tot })
      return
    }
    if (/\[Merger\]|Merging formats/.test(linea)) update(job, { status: 'uniendo', phase: 'uniendo vídeo y audio', pct: 99, speed: null, eta: null })
    else if (linea.includes('[ExtractAudio]')) update(job, { status: 'convirtiendo', phase: 'extrayendo audio', pct: 99, speed: null, eta: null })
    else if (/\[EmbedThumbnail\]|\[Metadata\]|\[EmbedSubtitle\]/.test(linea)) update(job, { status: 'convirtiendo', phase: 'incrustando metadatos', pct: 99, speed: null, eta: null })
    else if (linea.includes('[ModifyChapters]') || linea.includes('[SponsorBlock]')) update(job, { status: 'convirtiendo', phase: 'quitando patrocinios', speed: null, eta: null })
    job.log.push(linea)
    if (job.log.length > 200) job.log.shift()
  }
  const conectar = (flujo) => {
    let resto = ''
    flujo.setEncoding('utf8')
    flujo.on('data', (trozo) => {
      resto += trozo
      const lineas = resto.split(/\r?\n/)
      resto = lineas.pop() ?? ''
      for (const l of lineas) alLinea(l.trim())
    })
  }
  conectar(proc.stdout)
  conectar(proc.stderr)

  proc.on('error', (err) => {
    job.proc = null
    update(job, { status: 'error', error: err.message, finishedAt: Date.now() })
    bombear()
  })
  proc.on('close', async (codigo) => {
    job.proc = null
    try {
      if (job.status === 'cancelado' || job.status === 'pausado') return
      if (codigo === 0) return terminarBien(job)
      await recuperar(job, cfg, codigo)
    } finally {
      bombear()
    }
  })
}

/** Antes de dar un error por bueno se prueba lo que suele arreglarlo. */
async function recuperar(job, cfg, codigo) {
  const texto = job.log.join('\n')
  const msg = limpiarError(texto) || `yt-dlp terminó con código ${codigo}`
  job.intentos++
  const otraVez = (fase, extra = {}) => update(job, { status: 'en cola', phase: fase, pct: 0, speed: null, eta: null, log: [], ...extra })

  if (ES_COOKIES.test(msg)) return update(job, { status: 'error', error: traducirError(msg), finishedAt: Date.now() })

  if (ES_LIMITE.test(msg) && job.intentos <= 3) {
    const espera = 30000 * job.intentos
    return otraVez(`el sitio pidió bajar el ritmo: reintento en ${espera / 1000} s`, { noAntes: Date.now() + espera })
  }
  if (job.useAria2 && !job.sinAria) {
    job.sinAria = true
    return otraVez('reintentando sin Turbo', { useAria2: false })
  }
  if (ES_ROTURA.test(msg)) {
    if (!job.actualizado) {
      // Casi siempre es que el sitio cambio: se pone yt-dlp al dia y se repite.
      job.actualizado = true
      update(job, { status: 'esperando', phase: 'actualizando yt-dlp' })
      const otros = () => [...jobs.values()].some((j) => j.proc)
      await updateYtDlp({ ocupado: otros }).catch(() => {})
      return otraVez('reintentando con yt-dlp al día')
    }
    if (!job.cliente && /youtu/.test(job.url)) return otraVez('probando otro cliente', { cliente: 'tv,mweb' })
  }
  if (job.intentos === 1) return otraVez('reintentando')
  update(job, { status: 'error', error: traducirError(msg), finishedAt: Date.now() })
  borrarInfo(job)
}

function matar(proc) {
  if (proc?.pid) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
}

export function cancelJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  const proc = job.proc
  update(job, { status: 'cancelado', phase: '', speed: null, eta: null })
  matar(proc)
  borrarInfo(job)
  return true
}

/** Pausar es parar el proceso: --continue retoma el .part al reanudar. */
export function pauseJob(id) {
  const job = jobs.get(id)
  if (!job || TERMINADOS.includes(job.status)) return false
  const proc = job.proc
  update(job, { status: 'pausado', phase: 'pausado', speed: null, eta: null })
  matar(proc)
  return true
}

export function retryJob(id, cfg) {
  const job = jobs.get(id)
  if (!job || job.proc) return false
  // Se pauso mientras se leia el enlace: la lectura sigue y al acabar lo encola
  if (job.fantasma && job.status === 'pausado') {
    update(job, { status: 'leyendo', phase: 'leyendo el enlace' })
    return true
  }
  Object.assign(job, { error: null, log: [], intentos: 0, sinAria: false, actualizado: false, cliente: null, finishedAt: null, noAntes: 0, infoJson: job.infoJson })
  encolar(job, cfg)
  return true
}

export function removeJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  if (job.proc) matar(job.proc)
  borrarInfo(job)
  jobs.delete(id)
  for (const fn of listeners) fn({ id, removed: true })
  bombear()
  return true
}

export function clearFinished() {
  for (const j of [...jobs.values()]) if (['listo', 'error', 'cancelado'].includes(j.status)) removeJob(j.id)
}

export function pauseAll() {
  for (const j of [...jobs.values()]) if (j.proc || j.status === 'en cola' || j.status === 'leyendo') pauseJob(j.id)
}

export function resumeAll(cfg) {
  for (const j of [...jobs.values()]) if (j.status === 'pausado') retryJob(j.id, cfg)
}

export function retryFailed(cfg) {
  for (const j of [...jobs.values()]) if (j.status === 'error') retryJob(j.id, cfg)
}
