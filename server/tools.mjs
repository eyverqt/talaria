// Talaria - herramientas: instala yt-dlp, FFmpeg y aria2c en paralelo la primera
// vez y mantiene yt-dlp al dia, porque es lo que se rompe cuando YouTube cambia.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const run = promisify(execFile)

export const ROOT = path.resolve(import.meta.dirname, '..')
export const BIN_DIR = path.join(ROOT, 'bin')

export const toolState = {
  ready: false,
  tools: {
    'yt-dlp': { label: 'yt-dlp', status: 'pendiente', pct: 0, path: null, version: null, required: true },
    ffmpeg: { label: 'FFmpeg', status: 'pendiente', pct: 0, path: null, version: null, required: true },
    aria2c: { label: 'aria2c', status: 'pendiente', pct: 0, path: null, version: null, required: false },
  },
}

const listeners = new Set()
export function onToolChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function emit() {
  for (const fn of listeners) fn(toolState)
}
function set(name, patch) {
  Object.assign(toolState.tools[name], patch)
  emit()
}

const SOURCES = {
  'yt-dlp': ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'],
  ffmpeg: [
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  ],
  aria2c: ['https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'],
}

async function which(exe) {
  try {
    const { stdout } = await run('where', [exe], { windowsHide: true })
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null
  } catch {
    return null
  }
}

const exists = (p) => fsp.access(p).then(() => true, () => false)

async function download(url, dest, onPct) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Talaria/1.0' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} en ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let seen = 0
  const tmp = dest + '.part'
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    seen += c.length
    if (total && onPct) onPct(Math.min(99, Math.round((seen / total) * 100)))
  })
  await pipeline(body, fs.createWriteStream(tmp))
  await fsp.rename(tmp, dest)
}

async function unzip(zip, outDir) {
  await fsp.mkdir(outDir, { recursive: true })
  const cmd = `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, maxBuffer: 1 << 25 })
}

async function findExe(dir, name) {
  const pila = [dir]
  while (pila.length) {
    const cur = pila.pop()
    const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) pila.push(full)
      else if (e.name.toLowerCase() === name.toLowerCase()) return full
    }
  }
  return null
}

async function fromSources(name, handler) {
  let ultimo
  for (const url of SOURCES[name]) {
    try {
      return await handler(url)
    } catch (err) {
      ultimo = err
    }
  }
  throw ultimo || new Error(`No se pudo instalar ${name}`)
}

// yt-dlp siempre en bin/: solo asi Talaria puede actualizarlo sin depender de
// como se instalo el del sistema.
async function installYtDlp() {
  const local = path.join(BIN_DIR, 'yt-dlp.exe')
  if (await exists(local)) return local
  set('yt-dlp', { status: 'descargando', pct: 1 })
  await fromSources('yt-dlp', (url) => download(url, local, (p) => set('yt-dlp', { pct: p })))
  return local
}

async function installZip(name, exes) {
  const local = path.join(BIN_DIR, exes[0])
  if (await exists(local)) return local
  const sys = await which(exes[0].replace('.exe', ''))
  if (sys) return sys
  set(name, { status: 'descargando', pct: 1 })
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `talaria-${name}-`))
  try {
    const zip = path.join(tmp, 'paquete.zip')
    await fromSources(name, (url) => download(url, zip, (p) => set(name, { pct: Math.round(p * 0.85) })))
    set(name, { status: 'extrayendo', pct: 88 })
    const out = path.join(tmp, 'x')
    await unzip(zip, out)
    for (const exe of exes) {
      const found = await findExe(out, exe)
      if (found) await fsp.copyFile(found, path.join(BIN_DIR, exe))
    }
    if (!(await exists(local))) throw new Error(`No se encontro ${exes[0]} en el paquete`)
    return local
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

const INSTALLERS = {
  'yt-dlp': installYtDlp,
  ffmpeg: () => installZip('ffmpeg', ['ffmpeg.exe', 'ffprobe.exe']),
  aria2c: () => installZip('aria2c', ['aria2c.exe']),
}

async function versionOf(name, exe) {
  try {
    const flag = name === 'yt-dlp' ? '--version' : name === 'ffmpeg' ? '-version' : '--version'
    const { stdout } = await run(exe, [flag], { windowsHide: true, timeout: 20000 })
    const primera = stdout.split(/\r?\n/)[0].trim()
    if (name === 'yt-dlp') return primera
    return (primera.match(/version\s+(\S+)/i) || [])[1] || primera.slice(0, 24)
  } catch {
    return null
  }
}

let bootstrap = null

export function ensureTools({ force = false } = {}) {
  if (bootstrap && !force) return bootstrap
  bootstrap = (async () => {
    await fsp.mkdir(BIN_DIR, { recursive: true })
    const names = Object.keys(INSTALLERS)
    await Promise.all(names.map(async (name) => {
      try {
        set(name, { status: 'buscando', pct: 0, error: null })
        const p = await INSTALLERS[name]()
        set(name, { status: 'listo', pct: 100, path: p, version: await versionOf(name, p) })
      } catch (err) {
        set(name, { status: 'error', pct: 0, error: String((err && err.message) || err) })
      }
    }))
    toolState.ready = toolState.tools['yt-dlp'].status === 'listo' && toolState.tools.ffmpeg.status === 'listo'
    emit()
    return toolState
  })()
  return bootstrap
}

export const toolPath = (name) => toolState.tools[name]?.path || null

// ---------------------------------------------------------------- actualizar

/** La ultima version publicada de yt-dlp, sin gastar cuota de la API de GitHub. */
export async function latestYtDlp() {
  const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest', { redirect: 'manual', headers: { 'User-Agent': 'Talaria/1.0' } })
  const destino = res.headers.get('location') || ''
  return (destino.match(/\/tag\/([^/?#]+)/) || [])[1] || null
}

let actualizando = null

/**
 * Pone yt-dlp al dia si hay otra version. `ocupado()` dice si hay descargas
 * usando el .exe: en Windows no se puede reemplazar mientras corre.
 */
export function updateYtDlp({ force = false, ocupado = () => false } = {}) {
  if (actualizando) return actualizando
  actualizando = (async () => {
    const local = path.join(BIN_DIR, 'yt-dlp.exe')
    const actual = toolState.tools['yt-dlp'].version
    const ultima = await latestYtDlp().catch(() => null)
    if (!force && (!ultima || ultima === actual)) return { actualizado: false, version: actual }
    if (ocupado()) return { actualizado: false, version: actual, pendiente: true }
    set('yt-dlp', { status: 'descargando', pct: 1 })
    try {
      await fromSources('yt-dlp', (url) => download(url, local, (p) => set('yt-dlp', { pct: p })))
    } finally {
      set('yt-dlp', { status: 'listo', pct: 100, path: local, version: await versionOf('yt-dlp', local) })
    }
    return { actualizado: true, version: toolState.tools['yt-dlp'].version }
  })().finally(() => { actualizando = null })
  return actualizando
}
