#!/usr/bin/env python3
"""Monta jarvis.html (conteúdo de body) a partir das partes em src/. Notas de exemplo embutidas byte a byte."""
import pathlib, re, sys
SRC = pathlib.Path(__file__).resolve().parent
APP = SRC.parent
read = lambda p: (SRC / p).read_text(encoding="utf-8")
notes = (APP / "ref" / "notes.json").read_text(encoding="utf-8")
core, app, bloom, css, markup = read("core.js"), read("app.js"), read("bloom.js"), read("style.css"), read("markup.html")
for name, code in (("core", core), ("app", app), ("bloom", bloom), ("notes", notes)):
    low = code.lower()
    if "</script" in low or "<!--" in low or "<script" in low:
        sys.exit(f"{name}: sequência proibida dentro de <script>")
    if " " in code or " " in code:
        sys.exit(f"{name}: separador de linha literal")
importmap = ('{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",'
             '"three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}')
html = (
    "<title>JARVIS</title>\n"
    "<style>\n" + css.rstrip() + "\n</style>\n"
    '<script type="importmap">' + importmap + "</script>\n"
    + markup.rstrip() + "\n"
    '<script type="application/json" id="sample-notes">' + notes + "</script>\n"
    '<script id="jarvis-core">\n' + core.rstrip() + "\n</script>\n"
    '<script id="jarvis-app">\n' + app.rstrip() + "\n</script>\n"
    '<script type="module" id="jarvis-bloom">\n' + bloom.rstrip() + "\n</script>\n"
)
out = APP / "jarvis.html"
out.write_text(html, encoding="utf-8")
print(out, len(html.encode("utf-8")), "bytes")
