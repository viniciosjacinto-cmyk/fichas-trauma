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
# [[x.png]] é anexo; [[Protocolo v2.10]] e [[Node.js]] são notas
ATTACHMENT_EXT = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "tif", "tiff", "heic", "pdf", "mp3", "mp4",
                  "m4a", "wav", "ogg", "webm", "mov", "mkv", "avi", "zip", "csv", "xls", "xlsx", "doc", "docx",
                  "ppt", "pptx", "canvas", "excalidraw"}

STOPWORDS = set("""
a o e de da do das dos em no na nos nas um uma uns umas que se por para pra com sem ao aos
e ser foi sao esta estao era como mais menos mas ou ja nao sim eu tu ele ela eles elas me te
lhe vos meu minha meus minhas seu sua seus suas isso isto aquilo esse essa este esta qual quais
quando onde quem porque pois tem ter ha sobre entre ate depois antes tambem muito muita pouco
cada todo toda todos todas outro outra ainda so bem entao la aqui ali qualquer quanto quanta faz
fazer vai vou deve pode posso tenho temos tinha fica pelo pela pelos pelas num numa diga fale
explique conte voce senhor jarvis nota notas anotacao anotacoes os estes estas esses essas aquele
aqueles aquela aquelas dele dela deles delas nem ver veja vejo sera seria foram sido sendo estar estava
havia houve apenas mesmo mesma assim agora sempre nunca lembre lembra lembrar
the an and or of to in on at for with without by from is are was were be been being it its
this that these those what which who whom how why when where do does did done have has had i
you he she we they my your our their him her them as if then than so not no yes can could
should would will just about into over under up down out more most less very also there here
all any some each other such only own same too tell me please sir note notes
""".split())

# frontmatter YAML no topo, inclusive vazio (---\n---)
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(?:.*?\r?\n)??---[ \t]*(?:\r?\n|\Z)", re.S)
# [[Alvo]], [[pasta/Alvo]], [[Alvo#Seção]], [[Alvo|apelido]]
WIKILINK_RE = re.compile(r"\[\[([^\[\]|#^]+)(?:[#^][^\[\]|]*)?(?:\|[^\[\]]*)?\]\]")
TOKEN_RE = re.compile(r"[^\W_]+")  # letras e dígitos de qualquer alfabeto


class NotesError(Exception):
    """A pasta de notas não pôde ser lida."""


def warn(msg):
    print(f"Aviso: {msg}", file=sys.stderr)


# ----------------------------------------------------------------- texto ----

def fold(text):
    """Minúsculas e sem acento — 'Transfusão' e 'transfusao' viram a mesma coisa."""
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def tokens(text):
    return TOKEN_RE.findall(fold(text))


def clean(name):
    """Nome de arquivo com bytes fora do UTF-8 (Linux) não pode derrubar o JSON da galáxia."""
    return name.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def read_note_text(path):
    data = Path(path).read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):  # BOM de editor do Windows
        data = data[3:]
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
        # muitos bytes inválidos = nota salva em cp1252 (Windows antigo); um ou dois = arquivo com defeito
        return text if text.count("�") <= 2 else data.decode("cp1252", errors="replace")


def wikilink_targets(text):
    out = []
    for m in WIKILINK_RE.finditer(text):
        target = m.group(1).strip().replace("\\", "/").strip("/")
        name = target.split("/")[-1]
        if name.lower().endswith(".md"):
            target = target[:-3]
        elif "." in name and name.rsplit(".", 1)[1].lower() in ATTACHMENT_EXT:
            continue  # ![[figura.png]], [[laudo.pdf]] — anexo, não nota
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
    body = FRONTMATTER_RE.sub("", read_note_text(path), count=1)
    folder = clean(path.parent.relative_to(notes_dir).as_posix())
    label = clean(path.stem)
    return {
        "path": clean(path.relative_to(notes_dir).as_posix()),
        "label": label,
        "group": clean(notes_dir.name) if folder == "." else folder,
        "text": body,
        "excerpt": make_excerpt(body, label),
        "wikilinks": wikilink_targets(body),
    }


def scan(notes_dir):
    """Todas as notas .md, em ordem estável de caminho — o índice de cada uma é o id do nó."""
    notes_dir = Path(notes_dir)
    try:
        os.listdir(notes_dir)
    except OSError as e:
        raise NotesError(f"sem acesso à pasta de notas {notes_dir} ({e.strerror or e}). No Mac: Ajustes do "
                         "Sistema → Privacidade e Segurança → Arquivos e Pastas → libere o Terminal.") from None
    files, seen = [], set()

    def unreadable(err):
        warn(f"pasta ignorada, sem acesso: {err.filename} ({err.strerror})")

    # segue pastas-atalho como o Obsidian, mas nunca visita a mesma pasta duas vezes (sem loop)
    for dirpath, dirnames, filenames in os.walk(notes_dir, onerror=unreadable, followlinks=True):
        try:
            st = os.stat(dirpath)
        except OSError:
            dirnames[:] = []
            continue
        if (st.st_dev, st.st_ino) in seen:
            dirnames[:] = []
            continue
        seen.add((st.st_dev, st.st_ino))
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for fn in filenames:
            if fn.lower().endswith(".md") and not fn.startswith("."):
                files.append(Path(dirpath) / fn)
    files.sort(key=lambda p: p.relative_to(notes_dir).as_posix().lower())
    notes = []
    for p in files:
        try:
            notes.append(load_note(p, notes_dir))
        except OSError as e:  # atalho quebrado, sem permissão, apagada no meio da leitura
            warn(f"nota ignorada: {clean(str(p))} ({e.strerror or e})")
    return notes


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

    by_key, by_tuple, sizes = {}, {}, {}
    for i, n in enumerate(notes):
        key = title_key(n["label"])
        if key:
            by_key.setdefault(key, []).append(i)
        if mentionable(n["label"]):
            tt = tuple(tokens(n["label"]))
            by_tuple.setdefault(tt, []).append(i)
            sizes.setdefault(tt[0], set()).add(len(tt))  # tamanhos de título que começam por esta palavra

    # sigla curta (TC, RX, US) só vale escrita em maiúsculas — "tc" e "us" soltos não contam
    acronyms = {}
    for i, n in enumerate(notes):
        label = n["label"].strip()
        if not mentionable(label) and len(label) >= 2 and label.isupper() and TOKEN_RE.fullmatch(label):
            acronyms.setdefault(label, []).append(i)

    # 1. uma nota menciona o título de outra — uma consulta por posição e tamanho possível,
    #    em vez de comparar com cada título ("Caso 001"…"Caso 600" não explodem mais)
    for i, n in enumerate(notes):
        tk = tokens(n["text"])
        for pos, t in enumerate(tk):
            for size in sizes.get(t, ()):
                for j in by_tuple.get(tuple(tk[pos:pos + size]), ()):
                    add(i, j)
        if acronyms:
            for t in set(TOKEN_RE.findall(n["text"])):  # texto original, maiúsculas preservadas
                for j in acronyms.get(t, ()):
                    add(i, j)

    # 2. [[wikilink]] para uma nota que existe liga direto nela. Notas que compartilham um
    #    alvo SEM nota própria ([[REDCap]], [[tag-solta]]) se ligam entre si — quando o alvo
    #    existe, as duas já se encontram nele, e o par direto só embolaria a galáxia.
    paths = [fold(n["path"][:-3]) for n in notes]
    folders = [n["path"].rpartition("/")[0] for n in notes]

    def resolve(i, target):
        cands = by_key.get(title_key(target.split("/")[-1]), [])
        if "/" in target:  # [[pasta/Alvo]]: o caminho decide
            want = fold(target)
            cands = [j for j in cands if paths[j] == want or paths[j].endswith("/" + want)] or cands
        if len(cands) > 1:  # nome repetido: a da mesma pasta, senão a de caminho mais curto (como o Obsidian)
            same = [j for j in cands if folders[j] == folders[i]]
            cands = same or sorted(cands, key=lambda j: (len(notes[j]["path"]), notes[j]["path"]))
        return cands[0] if cands else None

    sharers = {}
    for i, n in enumerate(notes):
        for target in n["wikilinks"]:
            j = resolve(i, target)
            if j is not None:
                add(i, j)
            else:
                key = title_key(target.split("/")[-1])
                if key:
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
            "folder": clean(Path(notes_dir).name),
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
            data = json.loads(CONFIG.read_text(encoding="utf-8-sig"))  # o Bloco de Notas grava com BOM
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
        chosen = Path(os.path.expanduser(argv[1])).resolve()
        if not chosen.is_dir():  # caminho digitado errado não vai parar no config
            sys.exit(f"Pasta de notas não encontrada: {chosen}")
        cfg["notes_dir"] = str(chosen)
        save_config(cfg)
    notes_dir = notes_path(cfg)
    if not notes_dir.is_dir():
        sys.exit(f"Pasta de notas não encontrada: {notes_dir}")
    try:
        notes, links = build(notes_dir)
    except NotesError as e:
        sys.exit(f"Erro: {e}")
    if not notes:
        warn("nenhuma nota .md nessa pasta")
    print(f"{len(notes)} notas · {len(links)} ligações · {notes_dir}")
    print(f"Gravado em {GRAPH_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv)
