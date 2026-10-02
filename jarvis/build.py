#!/usr/bin/env python3
"""JARVIS · build.py — transforma uma pasta de notas markdown numa galáxia 3D.

Varre todo arquivo .md da pasta de notas e escreve viewer/graph-data.js:

    const GRAPH = {nodes: [...], links: [...], meta: {...}};

Cada nó tem id numérico igual à sua posição no array de nós (as funções
seguintes procuram nós pelo índice), rótulo vindo do nome do arquivo, a pasta
como grupo e um trecho de ~700 caracteres. Duas notas se ligam quando uma
menciona o título da outra ou quando as duas apontam para o mesmo [[wikilink]].

Só biblioteca padrão. Uso:

    python3 build.py               # pasta de config.json ("notes_dir", padrão ./notes)
    python3 build.py ~/meu/vault   # usa esta pasta e grava a escolha em config.json
"""

import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VIEWER = ROOT / "viewer"
GRAPH_JS = VIEWER / "graph-data.js"
CONFIG = ROOT / "config.json"

PLACEHOLDER_KEY = "PUT-YOUR-KEY-HERE"
DEFAULT_CONFIG = {
    "api_key": PLACEHOLDER_KEY,
    "model": "claude-opus-5-5",
    "notes_dir": "notes",
    "language": "pt-BR",
    "backend": "auto",
    "port": 4700,
}

EXCERPT_CHARS = 700
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules", "__pycache__", ".venv"}
# títulos genéricos demais para valer como "menção" no texto de outra nota
GENERIC_TITLES = {"readme", "index", "untitled", "sem titulo", "todo", "inbox", "notes", "notas"}
# alvo de [[wikilink]] compartilhado por mais notas que isso vira estrela, não clique
CLIQUE_MAX = 10

STOPWORDS = set("""
a o e de da do das dos em no na nos nas um uma uns umas que se por para pra com sem ao aos
e ser foi sao esta estao era como mais menos mas ou ja nao sim eu tu ele ela eles elas me te
lhe vos meu minha meus minhas seu sua seus suas isso isto aquilo esse essa este esta qual quais
quando onde quem porque pois tem ter ha sobre entre ate depois antes tambem muito muita pouco
cada todo toda todos todas outro outra ainda so bem entao la aqui ali qualquer quanto quanta faz
fazer vai vou deve pode posso tenho temos tinha fica pelo pela pelos pelas num numa diga fale
explique conte voce senhor jarvis nota notas anotacao anotacoes
the an and or of to in on at for with without by from is are was were be been being it its
this that these those what which who whom how why when where do does did done have has had i
you he she we they my your our their him her them as if then than so not no yes can could
should would will just about into over under up down out more most less very also there here
all any some each other such only own same too tell me please sir note notes
""".split())

FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n.*?\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)
# [[Alvo]], [[pasta/Alvo]], [[Alvo#Seção]], [[Alvo|apelido]]
WIKILINK_RE = re.compile(r"\[\[([^\[\]|#^]+)(?:[#^][^\[\]|]*)?(?:\|[^\[\]]*)?\]\]")
TOKEN_RE = re.compile(r"[a-z0-9]+")


# ----------------------------------------------------------------- texto ----

def fold(text):
    """Minúsculas e sem acento — 'Transfusão' e 'transfusao' viram a mesma coisa."""
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def tokens(text):
    return TOKEN_RE.findall(fold(text))


def wikilink_targets(text):
    out = []
    for m in WIKILINK_RE.finditer(text):
        target = m.group(1).strip().split("/")[-1]
        if target.lower().endswith(".md"):
            target = target[:-3]
        elif re.search(r"\.[A-Za-z0-9]{2,4}$", target):
            continue  # ![[figura.png]], [[arquivo.pdf]] — anexo, não nota
        if target:
            out.append(target)
    return out


def make_excerpt(body, title):
    text = body.strip()
    lines = text.splitlines()
    # o H1 que só repete o título não precisa ocupar o trecho
    if lines and lines[0].startswith("# ") and fold(lines[0][2:].strip()) == fold(title):
        text = "\n".join(lines[1:]).strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    if len(text) <= EXCERPT_CHARS:
        return text
    cut = text.rfind(" ", 0, EXCERPT_CHARS)
    if cut < EXCERPT_CHARS * 0.6:
        cut = EXCERPT_CHARS
    return text[:cut].rstrip() + "…"


# ----------------------------------------------------------------- notas ----

def load_note(path, notes_dir):
    path, notes_dir = Path(path), Path(notes_dir)
    raw = path.read_text(encoding="utf-8", errors="replace")
    body = FRONTMATTER_RE.sub("", raw, count=1)
    folder = path.parent.relative_to(notes_dir).as_posix()
    return {
        "path": path.relative_to(notes_dir).as_posix(),
        "label": path.stem,
        "group": notes_dir.name if folder == "." else folder,
        "text": body,
        "excerpt": make_excerpt(body, path.stem),
        "wikilinks": wikilink_targets(body),
    }


def scan(notes_dir):
    """Todas as notas .md, em ordem estável de caminho — o índice de cada uma é o id do nó."""
    notes_dir = Path(notes_dir)
    files = []
    for dirpath, dirnames, filenames in os.walk(notes_dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if fn.lower().endswith(".md") and not fn.startswith("."):
                files.append(Path(dirpath) / fn)
    files.sort(key=lambda p: p.relative_to(notes_dir).as_posix().lower())
    return [load_note(p, notes_dir) for p in files]


def title_key(label):
    return " ".join(tokens(label))


def mentionable(label):
    tt = tokens(label)
    key = " ".join(tt)
    return bool(tt) and len(key) >= 3 and key not in GENERIC_TITLES and not (len(tt) == 1 and tt[0] in STOPWORDS)


def build_links(notes):
    pairs = set()

    def add(a, b):
        if a != b:
            pairs.add((min(a, b), max(a, b)))

    # índice de títulos: primeira palavra -> [(sequência de palavras do título, nó)]
    by_first, by_key = {}, {}
    for i, n in enumerate(notes):
        by_key.setdefault(title_key(n["label"]), []).append(i)
        if mentionable(n["label"]):
            tt = tuple(tokens(n["label"]))
            by_first.setdefault(tt[0], []).append((tt, i))

    # 1. uma nota menciona o título de outra
    for i, n in enumerate(notes):
        tk = tokens(n["text"])
        for pos, t in enumerate(tk):
            for tt, j in by_first.get(t, ()):
                if j != i and tuple(tk[pos:pos + len(tt)]) == tt:
                    add(i, j)

    # 2. [[wikilink]] para uma nota que existe liga direto nela. Notas que compartilham um
    #    alvo SEM nota própria ([[REDCap]], [[tag-solta]]) se ligam entre si — quando o alvo
    #    existe, as duas já se encontram nele, e o par direto só embolaria a galáxia.
    sharers = {}
    for i, n in enumerate(notes):
        for target in n["wikilinks"]:
            key = title_key(target)
            if key in by_key:
                for j in by_key[key]:
                    add(i, j)
            elif key:
                sharers.setdefault(key, set()).add(i)
    for members in sharers.values():
        m = sorted(members)
        if len(m) <= CLIQUE_MAX:
            for x in range(len(m)):
                for y in range(x + 1, len(m)):
                    add(m[x], m[y])
        else:
            for y in m[1:]:
                add(m[0], y)

    return [{"source": a, "target": b} for a, b in sorted(pairs)]


def build_id(notes):
    """Muda quando muda a lista ou a ordem dos nós — o navegador usa para saber se está defasado."""
    return hashlib.sha1("\n".join(n["path"] for n in notes).encode("utf-8")).hexdigest()[:12]


def node_payload(i, note):
    return {"id": i, "label": note["label"], "group": note["group"],
            "path": note["path"], "excerpt": note["excerpt"]}


def write_graph(notes, links, notes_dir, out=GRAPH_JS):
    payload = {
        "nodes": [node_payload(i, n) for i, n in enumerate(notes)],
        "links": links,
        "meta": {
            "count": len(notes),
            "links": len(links),
            "folder": Path(notes_dir).name,
            "build_id": build_id(notes),
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text("// Gerado por build.py — não edite à mão.\nconst GRAPH = "
                   + json.dumps(payload, ensure_ascii=False) + ";\n", encoding="utf-8")
    os.replace(tmp, out)
    return payload


# ---------------------------------------------------------------- config ----

def load_config():
    """config.json mesclado sobre os padrões. Arquivo ausente = padrões; JSON inválido = ValueError."""
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG.exists():
        try:
            data = json.loads(CONFIG.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"config.json não é JSON válido (linha {e.lineno}, coluna {e.colno})") from None
        if isinstance(data, dict):
            cfg.update(data)
    return cfg


def save_config(cfg):
    tmp = CONFIG.with_name(CONFIG.name + ".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CONFIG)


def notes_path(cfg):
    p = Path(os.path.expanduser(str(cfg.get("notes_dir") or "notes")))
    return (p if p.is_absolute() else ROOT / p).resolve()


def build(notes_dir):
    notes = scan(notes_dir)
    links = build_links(notes)
    write_graph(notes, links, notes_dir)
    return notes, links


def main(argv):
    try:
        cfg = load_config()
    except ValueError as e:
        sys.exit(f"Erro: {e}")
    if len(argv) > 1:
        cfg["notes_dir"] = str(Path(os.path.expanduser(argv[1])).resolve())
        save_config(cfg)
    notes_dir = notes_path(cfg)
    if not notes_dir.is_dir():
        sys.exit(f"Pasta de notas não encontrada: {notes_dir}")
    notes, links = build(notes_dir)
    print(f"{len(notes)} notas · {len(links)} ligações · {notes_dir}")
    print(f"Gravado em {GRAPH_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv)
