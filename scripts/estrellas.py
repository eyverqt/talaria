"""
Talaria - grafica de estrellas con el estilo eyverqt.

La genera una GitHub Action cada dia y cada vez que alguien da una estrella:
lee la fecha de cada estrella en la API de GitHub y dibuja docs/estrellas.svg
(blanco, tinta casi negra, un solo acento rojo, mono en mayusculas).

    GITHUB_REPOSITORY=eyverqt/talaria GITHUB_TOKEN=... python scripts/estrellas.py
"""

import datetime as dt
import json
import os
import urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "eyverqt/talaria")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
SALIDA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "estrellas.svg")
MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"]

ANCHO, ALTO = 920, 380
IZQ, DER, ARRIBA, ABAJO = 20, 20, 150, 50
MONO = "'Chivo Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
DISPLAY = "'Archivo', 'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif"


def pedir(ruta, aceptar="application/vnd.github+json"):
    req = urllib.request.Request("https://api.github.com" + ruta, headers={
        "Accept": aceptar, "User-Agent": "tiro-estrellas",
        **({"Authorization": "Bearer " + TOKEN} if TOKEN else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fechas_de_estrellas():
    fechas, pagina = [], 1
    while True:
        lote = pedir("/repos/%s/stargazers?per_page=100&page=%d" % (REPO, pagina),
                     "application/vnd.github.star+json")
        if not lote:
            break
        fechas += [dt.datetime.fromisoformat(s["starred_at"].replace("Z", "+00:00")).date() for s in lote]
        if len(lote) < 100:
            break
        pagina += 1
    return sorted(fechas)


def fecha_txt(d):
    return "%02d %s %d" % (d.day, MESES[d.month - 1], d.year)


def dibujar(fechas, creado, hoy):
    inicio = min([creado] + fechas)
    dias = max(1, (hoy - inicio).days)
    total = len(fechas)
    tope = max(5, total)
    tope = int(((tope + 4) // 5) * 5)                 # eje en multiplos de 5
    ancho_g, alto_g = ANCHO - IZQ - DER, ALTO - ARRIBA - ABAJO

    def x(d):
        return IZQ + ancho_g * (d - inicio).days / dias

    def y(n):
        return ARRIBA + alto_g * (1 - n / tope)

    # Escalera: la linea sube justo el dia de cada estrella
    puntos, n = [(x(inicio), y(0))], 0
    for d in fechas:
        puntos.append((x(d), y(n)))
        n += 1
        puntos.append((x(d), y(n)))
    puntos.append((x(hoy), y(n)))
    linea = " ".join("%.1f,%.1f" % p for p in puntos)
    area = linea + " %.1f,%.1f %.1f,%.1f" % (x(hoy), y(0), x(inicio), y(0))

    rejilla = "".join(
        '<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#e6e6e6"/>'
        '<text x="%d" y="%.1f" font-family="%s" font-size="11" fill="#8a8a8e" text-anchor="end">%d</text>'
        % (IZQ, y(v), ANCHO - DER, y(v), ANCHO - DER, y(v) - 6, MONO, v)
        for v in range(0, tope + 1, max(1, tope // 5)))
    ux, uy = x(hoy), y(total)
    vacio = ""
    if not total:
        vacio = ('<text x="%d" y="%.1f" font-family="%s" font-size="12" font-weight="700" fill="#2e2e30">'
                 'SÉ LA PRIMERA ESTRELLA ↗</text>' % (IZQ, y(0) - 14, MONO))

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{ANCHO}" height="{ALTO}" viewBox="0 0 {ANCHO} {ALTO}" role="img" aria-label="Estrellas de {REPO}: {total}">
<rect width="{ANCHO}" height="{ALTO}" fill="#ffffff"/>
<text x="{IZQ}" y="34" font-family="{MONO}" font-size="12" font-weight="700" fill="#2e2e30" letter-spacing=".5">ESTRELLAS · {REPO.upper()}</text>
<text x="{ANCHO - DER}" y="34" font-family="{MONO}" font-size="12" fill="#8a8a8e" text-anchor="end">ACTUALIZADO {fecha_txt(hoy)}</text>
<line x1="{IZQ}" y1="46" x2="{ANCHO - DER}" y2="46" stroke="#2e2e30"/>
<text x="{IZQ - 3}" y="122" font-family="{DISPLAY}" font-size="84" font-weight="800" font-stretch="condensed" fill="#1d1d1f" letter-spacing="-3">{total}</text>
<circle cx="{IZQ + 6}" cy="{136}" r="3" fill="#ff2400"><animate attributeName="opacity" values="1;.25;1" dur="2s" repeatCount="indefinite"/></circle>
<text x="{IZQ + 16}" y="140" font-family="{MONO}" font-size="12" font-weight="700" fill="#ff2400">{"EN VIVO" if total else "RECIÉN PUBLICADO"}</text>
{rejilla}
<polygon points="{area}" fill="#ff2400" fill-opacity=".05"/>
<polyline points="{linea}" fill="none" stroke="#2e2e30" stroke-width="1.6" stroke-linejoin="round"/>
<circle cx="{ux:.1f}" cy="{uy:.1f}" r="4.5" fill="#ff2400"/>
{vacio}
<line x1="{IZQ}" y1="{ALTO - ABAJO + 0.5}" x2="{ANCHO - DER}" y2="{ALTO - ABAJO + 0.5}" stroke="#2e2e30"/>
<text x="{IZQ}" y="{ALTO - ABAJO + 24}" font-family="{MONO}" font-size="11" fill="#8a8a8e">{fecha_txt(inicio)}</text>
<text x="{ANCHO - DER}" y="{ALTO - ABAJO + 24}" font-family="{MONO}" font-size="11" fill="#8a8a8e" text-anchor="end">{fecha_txt(hoy)}</text>
</svg>
"""


def main():
    hoy = dt.date.today()
    try:
        info = pedir("/repos/%s" % REPO)
        creado = dt.datetime.fromisoformat(info["created_at"].replace("Z", "+00:00")).date()
        fechas = fechas_de_estrellas()
    except Exception as e:                            # sin red o sin repo: grafica vacia
        print("aviso: %s" % e)
        creado, fechas = hoy, []
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8", newline="\n") as f:
        f.write(dibujar(fechas, creado, hoy))
    print("%d estrellas -> %s" % (len(fechas), SALIDA))


if __name__ == "__main__":
    main()
