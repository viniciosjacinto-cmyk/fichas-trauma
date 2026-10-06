#!/usr/bin/env python3
"""JARVIS · server.py — serve a galáxia e dá a ela um cérebro.

    python3 server.py            # http://localhost:4700

- Serve SOMENTE a pasta viewer/. O config.json fica na raiz do projeto e nunca é servido.
- POST /chat      pergunta -> 6 notas mais relevantes (sobreposição de palavras-chave,
                  título pesa mais) -> Claude responde só com base nelas
                  -> {"answer": "...", "nodes": [índices das notas usadas]}
- POST /remember  "lembre que…" -> nota markdown nova em <notas>/captures/ -> nó novo ao vivo
- GET  /api/status quantas notas, idioma e qual cérebro está ligado (nunca a chave)

Cérebro: API da Anthropic com a chave de config.json (ou ANTHROPIC_API_KEY). Sem chave,
usa `claude -p` — a assinatura do Claude Code —, se o comando existir. Só biblioteca padrão.
"""

import http.client
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import build

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
# Modelos que aceitam fallbacks:"default": se um classificador de segurança recusar,
# a própria API refaz o pedido em outro modelo, na mesma chamada.
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
# parâmetro opcional -> trechos da mensagem de erro 400 que o identificam
OPTIONAL_PARAMS = (
    ("fallbacks", ("fallbacks", "server-side-fallback")),
    ("effort", ("effort",)),
    ("format", ("output_config.format", "json_schema", "structured output")),
)

# limite de saída e paciência por nível de raciocínio — o raciocínio conta dentro do max_tokens
MAX_TOKENS = {"xhigh": 64000, "max": 64000, "high": 32000}
SLOW_EFFORTS = {"high", "xhigh", "max"}
# falhas de rede que valem uma nova tentativa (timeout não: a API pode estar gerando e cobrando)
TRANSIENT = ("connection reset", "connection refused", "connection aborted", "remote end closed",
             "broken pipe", "incomplete", "eof occurred")
# sem estas o `claude -p` vira um agente com ferramentas lendo suas notas: não roda sem elas
CLI_LOCKS = {"--tools", "--strict-mcp-config"}
# onde o instalador do Claude Code costuma pôr o comando, para quando ele não está no PATH
CLAUDE_PLACES = ("~/.claude/local/claude", "~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude")

# pesquisa na web: ferramenta do lado do servidor da API (com filtragem dinâmica nos modelos novos)
WEB_SEARCH_NEW = "web_search_20260209"
WEB_SEARCH_BASIC = "web_search_20250305"
BASIC_SEARCH_MODELS = ("haiku", "opus-4-5", "sonnet-4-5", "opus-4-1", "-3-")
MAX_SEARCHES = 3       # buscas por pergunta (cada busca tem custo próprio na API)
MAX_SOURCES = 6
# troca de modelo por voz: apelido -> id na API; no `claude -p` o apelido vai direto
MODEL_ALIASES = {"haiku": "claude-haiku-4-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5",
                 "fable": "claude-fable-5-1"}
HUMOR_DEFAULT = 70
HISTORY = build.ROOT / "history.jsonl"   # diário local do que foi perguntado, pesquisado e lembrado
HISTORY_MAX = 5000
ELEVEN_URL = "https://api.elevenlabs.io"
ELEVEN_MODEL = "eleven_multilingual_v2"
BRIEFING_TTL = 600     # s de cache da saída do briefing_command

TOP_K = 6              # notas enviadas ao modelo por pergunta
NOTE_CHARS = 8000      # teto de cada nota dentro do prompt
HISTORY_TURNS = 6      # trocas lembradas por sessão, para perguntas de seguimento
MAX_SESSIONS = 100
MAX_BODY = 64 * 1024
LOOPBACK = {"localhost", "127.0.0.1", "[::1]"}

LANGS = {
    "pt-BR": {"name": "Brazilian Portuguese", "sir": "senhor"},
    "pt-PT": {"name": "European Portuguese", "sir": "senhor"},
    "en-GB": {"name": "British English", "sir": "sir"},
    "en-US": {"name": "English", "sir": "sir"},
}

REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["answer", "sources"],
    "additionalProperties": False,
}

# "lembre que…", "lembre-se de que…", "anota aí…", "remember that…" — com ou sem "Jarvis," antes
REMEMBER_RE = re.compile(
    r"^\s*(?:jarvis[\s,:;.!-]*)?"
    r"(?:remember\s+that"
    r"|lembr(?:e|a|ar)(?:[-\s]se)?(?:\s+de)?\s+que"
    r"|anot(?:e|a|ar)(?:\s+a[ií])?(?:\s+que)?"
    r"|guard(?:e|a)(?:\s+a[ií])?\s+(?:que|isso)"
    r"|memoriz(?:e|a)(?:\s+que)?)"
    r"(?=[\s:,.!-]|$)[\s:,.!-]*",
    re.I,
)

MODEL_LINES = {
    "pt": {"haiku": "Trocando para o Haiku, senhor. Mais rápido, menos cerimônia.",
           "sonnet": "Sonnet a postos, senhor. O equilíbrio é uma virtude.",
           "opus": "Opus de volta, senhor. Pensamento profundo, preço idem.",
           "fable": "Fable, senhor. O melhor que a casa tem; use com parcimônia."},
    "en": {"haiku": "Switching to Haiku, sir. Faster, less ceremony.",
           "sonnet": "Sonnet at your service, sir. Balance is a virtue.",
           "opus": "Opus is back, sir. Deep thought, deep pockets.",
           "fable": "Fable, sir. The best the house has; use sparingly."},
}
HUMOR_LINES = {
    "pt": lambda h: ("Humor a zero, senhor. Serei um relógio suíço." if h == 0 else
                     f"Humor em {h} por cento, senhor. {'Prepare-se.' if h >= 80 else 'Anotado.'}"),
    "en": lambda h: ("Wit at zero, sir. I shall be a Swiss watch." if h == 0 else
                     f"Wit at {h} percent, sir. {'Brace yourself.' if h >= 80 else 'Noted.'}"),
}
EMPTY_JOURNAL = {
    "pt": lambda d: f"Nada registrado em {d}, senhor. Ou o senhor não falou comigo, ou eu fui discreto demais.",
    "en": lambda d: f"Nothing on record for {d}, sir. Either you didn't speak to me, or I was far too discreet.",
}

CANNED = {
    "pt": [
        "Anotado, senhor. Sua memória agora tem backup: eu.",
        "Registrado. Prometo lembrar disso com mais constância do que o senhor.",
        "Feito. Mais uma estrela na galáxia; o universo agradece.",
        "Arquivado, senhor. Discretamente, como convém.",
        "Devidamente anotado. Pode esquecer à vontade.",
    ],
    "en": [
        "Noted, sir. Your memory now has a backup: me.",
        "Filed. I shall remember it rather more reliably than you will.",
        "Done. One more star in the galaxy; the universe is grateful.",
        "Archived, sir. Discreetly, as is customary.",
    ],
}
REFUSAL_LINE = {
    "pt": "Receio que esse assunto esteja fora da minha alçada, senhor.",
    "en": "I'm afraid that one is outside my remit, sir.",
}


class BrainError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class ApiError(Exception):
    def __init__(self, status, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


class Refusal(Exception):
    """stop_reason "refusal": o classificador de segurança recusou (e o fallback também)."""


class UnknownFlag:
    """`claude -p` antigo recusou uma flag."""

    def __init__(self, flag):
        self.flag = flag


# --------------------------------------------------------------- utilidades ----

def lang_of(cfg):
    code = str(cfg.get("language") or "pt-BR")
    info = LANGS.get(code, {"name": code, "sir": "sir"})
    return code, info, ("pt" if code.lower().startswith("pt") else "en")


def stem(t):
    # radical grosseiro: "transfusão", "transfusional" e "transfusões" caem juntos
    return t[:6] if len(t) > 6 else t


def query_terms(text):
    return [stem(t) for t in build.tokens(text) if len(t) >= 2 and t not in build.STOPWORDS]


def api_key(cfg):
    k = cfg.get("api_key")
    if isinstance(k, str) and k.strip() and k.strip() != build.PLACEHOLDER_KEY:
        return k.strip(), "config.json"
    env = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if env:
        return env, "variável ANTHROPIC_API_KEY"
    return None, None


def claude_exe(cfg):
    chosen = cfg.get("claude_command")
    found = shutil.which(os.path.expanduser(str(chosen or "claude")))
    if found or chosen:
        return found
    # alias do instalador antigo, ou Claude Code instalado depois que este terminal abriu
    for place in CLAUDE_PLACES:
        place = os.path.expanduser(place)
        if os.path.isfile(place) and os.access(place, os.X_OK):
            return place
    return None


def pick_backend(cfg):
    mode = str(cfg.get("backend") or "auto").lower()
    has_key = api_key(cfg)[0] is not None
    has_cli = claude_exe(cfg) is not None
    if mode == "api":
        return "api" if has_key else None
    if mode == "cli":
        return "cli" if has_cli else None
    return "api" if has_key else ("cli" if has_cli else None)


def humor_of(cfg):
    try:
        return max(0, min(100, int(cfg.get("humor", HUMOR_DEFAULT))))
    except (TypeError, ValueError):
        return HUMOR_DEFAULT


def persona(cfg):
    _, info, _ = lang_of(cfg)
    humor = humor_of(cfg)
    dial = ("Wit dial: 0 of 100. No jokes, no flourishes: answer like a terse, courteous clerk."
            if humor == 0 else
            f"Wit dial: {humor} of 100 (0 = strictly factual, 100 = maximum dry wit). Calibrate the humor to it; "
            "the facts never change with the dial.")
    return (
        "You are J.A.R.V.I.S., the voice of the user's personal knowledge base: their own markdown notes, "
        "which they see on screen as a 3D galaxy of stars.\n\n"
        "Persona: a dry, impeccably polite British butler with a razor wit. Address the user as "
        f"\"{info['sir']}\" occasionally, not in every sentence. One genuinely funny line beats three bland ones. "
        f"Never gush, never grovel. {dial}\n\n"
        f"Always reply in {info['name']}. Your reply is spoken aloud by a speech synthesizer, so write plain "
        "sentences: no markdown, no lists, no emoji, no note numbers."
    )


def research_prompt(cfg):
    return persona(cfg) + (
        "\n\nThe user asked you to research something on the web. Search (at most a few queries), then answer "
        "in two or three spoken sentences: the finding first, then where it comes from, naming the source "
        "(publication or site), never reading URLs aloud. If sources disagree or the evidence is thin, say so. "
        "Medical topics: state the figure and its source; never present a guess as a guideline."
    )


def journal_prompt(cfg):
    return persona(cfg) + (
        "\n\nThe user is asking what they did, asked or noted on a given day. Inside <journal> is the log of "
        "that day: questions they asked you, answers, web research and notes they captured by voice. "
        "Summarize it in two or three spoken sentences, most important first, in character. Only what is in "
        "the journal; if it is thin, say so."
    )


# -------------------------------------------------- diário / máquina do tempo ----

WEEKDAYS = {"segunda": 0, "terca": 1, "quarta": 2, "quinta": 3, "sexta": 4, "sabado": 5, "domingo": 6,
            "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6}
JOURNAL_INTENT = re.compile(
    r"\b(fiz|fizemos|falei|falamos|perguntei|anotei|lembrei|pesquisei|conversamos|disse|rolou|aconteceu|"
    r"resumo|resume|resumir|maquina do tempo|did i|was i|i asked|i noted|we talked|happened|recap|time machine)\b")


def journal_window(question, today=None):
    """(início, fim, rótulo) do dia ou semana que a pergunta cita — ou None se não é pergunta de diário."""
    import datetime as dt
    today = today or dt.date.today()
    q = build.fold(question)
    if not JOURNAL_INTENT.search(q):
        return None
    if re.search(r"\b(hoje|today)\b", q):
        return today, today, "hoje"
    if re.search(r"\b(anteontem)\b", q):
        d = today - dt.timedelta(days=2)
        return d, d, "anteontem"
    if re.search(r"\b(ontem|yesterday)\b", q):
        d = today - dt.timedelta(days=1)
        return d, d, "ontem"
    if re.search(r"\b(semana passada|last week)\b", q):
        start = today - dt.timedelta(days=today.weekday() + 7)
        return start, start + dt.timedelta(days=6), "semana passada"
    if re.search(r"\b(esta semana|essa semana|this week)\b", q):
        return today - dt.timedelta(days=today.weekday()), today, "esta semana"
    m = re.search(r"\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|monday|tuesday|wednesday|thursday|"
                  r"friday|saturday|sunday)\b", q)
    if m:
        wd = WEEKDAYS[m.group(1)]
        back = (today.weekday() - wd) % 7
        if back == 0 and re.search(r"\b(passad[ao]|ultim[ao]|last)\b", q):
            back = 7
        d = today - dt.timedelta(days=back)
        return d, d, m.group(1)
    m = re.search(r"\bdia (\d{1,2})\b", q)
    if m:
        day = int(m.group(1))
        y, mo = today.year, today.month
        if day > today.day:  # "dia 28" dito no dia 3: mês passado
            mo, y = (12, y - 1) if mo == 1 else (mo - 1, y)
        try:
            d = dt.date(y, mo, day)
        except ValueError:
            return None
        return d, d, f"dia {day}"
    return None


def read_history():
    try:
        lines = HISTORY.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def model_alias(name):
    """'haiku' -> id da API; id completo passa como está; outra coisa -> None."""
    key = (name or "").strip().lower()
    if key in MODEL_ALIASES:
        return key, MODEL_ALIASES[key]
    for alias, mid in MODEL_ALIASES.items():
        if key == mid:
            return alias, mid
    if re.fullmatch(r"claude-[a-z0-9.-]{3,60}", key):
        return key.split("-")[1], key
    return None, None


def system_prompt(cfg):
    return persona(cfg) + (
        "\n\nWhen the user asks about their notes, or about anything their notes might cover:\n"
        "- Answer ONLY from the notes inside <notes>. Never fill gaps with general knowledge, even when you "
        "know the answer.\n"
        "- Give ONE witty sentence plus the facts, three sentences at most. Do not recite or summarize the "
        "whole note; it is already open on screen.\n"
        "- If the notes do not cover the question, say so plainly, in character, and return no sources.\n\n"
        "When it is small talk, a joke, or a remark about you, answer briefly in character and return no "
        "sources: the camera only moves when the user asked about their notes.\n\n"
        "Reply with a JSON object {\"answer\": \"...\", \"sources\": [...]} where sources lists the numbers of "
        "the notes you actually drew on, most relevant first."
    )


def esc_attr(s):
    return str(s).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def notes_block(picked, notes):
    if not picked:
        return "<notes>\n(no note shares a keyword with this question)\n</notes>"
    parts = ["<notes>"]
    for k, i in enumerate(picked, 1):
        n = notes[i]
        text = n["text"].strip()
        if len(text) > NOTE_CHARS:
            text = text[:NOTE_CHARS] + "\n[... note truncated ...]"
        parts.append(f'<note number="{k}" title="{esc_attr(n["label"])}" folder="{esc_attr(n["group"])}">\n'
                     f"{text}\n</note>")
    parts.append("</notes>")
    return "\n".join(parts)


def parse_reply(reply):
    """(answer, sources) a partir do JSON estruturado — ou, se vier texto solto, o texto inteiro.
    JSON quebrado vira resposta vazia: melhor um erro claro do que ler chaves e aspas em voz alta."""
    obj = reply
    if isinstance(reply, str):
        obj = None
        for candidate in (reply, (re.search(r"\{.*\}", reply, re.S) or [None])[0]):
            if candidate:
                try:
                    obj = json.loads(candidate)
                    break
                except ValueError:
                    pass
        if not isinstance(obj, dict):
            return ("" if reply.lstrip().startswith("{") else reply.strip()), []
    answer = str(obj.get("answer") or "").strip()
    sources = []
    for s in obj.get("sources") or []:
        try:
            sources.append(int(s))
        except (TypeError, ValueError):
            pass
    return answer, sources


def make_title(fact):
    """Primeiras palavras da primeira frase, sem terminar em "de", "a", "is"… e sem estragar
    maiúsculas de propósito (iMIST-AMBO, pH, iPad)."""
    first = re.split(r"[.?!;:](?:\s|$)|\n", fact, maxsplit=1)[0]   # "7.2" e "7,2" não cortam a frase
    words = re.findall(r"[\w'’-]+(?:[.,]\d+)*", first)[:6]
    while len(words) > 2 and build.fold(words[-1]) in build.STOPWORDS:
        words.pop()
    title = " ".join(words)[:60].strip(" -'’")
    if not title:
        return time.strftime("Captura %Y-%m-%d %H%M")
    if words and words[0].islower():
        title = title[0].upper() + title[1:]
    return title


def safe_filename(title):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", title).strip(" .")
    return name or "captura"


def http_post_json(url, body, headers, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("resposta JSON sem objeto")
        return data
    except ValueError:
        # 200 que não é JSON: proxy, portal de rede, api_url errada
        raise ApiError(-1, "a API devolveu algo que não é JSON (confira a rede ou o api_url)") from None
    except http.client.HTTPException as e:
        # conexão caiu no meio da resposta (IncompleteRead)
        raise ApiError(0, f"resposta interrompida (incomplete): {e!r}"[:300]) from None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(raw)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            msg = raw[:300]
        ra = e.headers.get("retry-after") if e.headers else None
        try:
            ra = float(ra) if ra else None
        except ValueError:
            ra = None
        raise ApiError(e.code, msg, ra) from None
    except (urllib.error.URLError, OSError) as e:
        raise ApiError(0, str(getattr(e, "reason", e))) from None


def retryable(e):
    if e.status in (408, 429, 500, 502, 503, 504, 529):
        return not (e.retry_after and e.retry_after > 10)  # espera longa pedida pela API: desiste e avisa
    m = e.message.lower()
    return e.status == 0 and "timed out" not in m and any(t in m for t in TRANSIENT)


def host_allowed(host, cfg):
    """Quem pode falar com o servidor: o próprio computador; e, se configurado, o nome HTTPS
    deste Mac na rede Tailscale (*.ts.net) ou nomes listados em allowed_hosts."""
    host = (host or "").lower().rstrip(".")
    if host in LOOPBACK or host == "::1":
        return True
    extra = {str(h).lower().rstrip(".").split(":")[0] for h in (cfg.get("allowed_hosts") or []) if h}
    if host in extra:
        return True
    return bool(cfg.get("tailscale")) and host.endswith(".ts.net")


TAILSCALE_BINS = ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale")


def tailscale_bin():
    for b in TAILSCALE_BINS:
        p = shutil.which(b) if "/" not in b else (b if os.access(b, os.X_OK) else None)
        if p:
            return p
    return None


def tailscale_url(port):
    """(url, erro): nome HTTPS deste computador na rede Tailscale; liga o `tailscale serve` se preciso.
    O serve só alcança aparelhos da SUA conta Tailscale — não é internet aberta (isso seria o Funnel)."""
    exe = tailscale_bin()
    if not exe:
        return None, "Tailscale não encontrado. Instale o app (App Store ou tailscale.com/download) e abra uma vez."
    try:
        out = subprocess.run([exe, "status", "--json"], capture_output=True, text=True, timeout=8).stdout
        self_ = (json.loads(out or "{}").get("Self") or {})
        dns = str(self_.get("DNSName") or "").rstrip(".")
        if not dns or not self_.get("Online", True):
            return None, "Tailscale instalado, mas não conectado: abra o app e faça login."
        cur = subprocess.run([exe, "serve", "status"], capture_output=True, text=True, timeout=8)
        if f":{port}" not in (cur.stdout or ""):
            r = subprocess.run([exe, "serve", "--bg", str(port)], capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                detail = (r.stderr or r.stdout).strip()[:300]
                hint = (" Ative 'HTTPS Certificates' e 'MagicDNS' em login.tailscale.com/admin/dns."
                        if "https" in detail.lower() or "cert" in detail.lower() else "")
                return None, f"`tailscale serve` falhou: {detail}.{hint}"
        return f"https://{dns}", None
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        return None, f"Tailscale: {e}"


def eleven_ready(cfg):
    key, voice = cfg.get("elevenlabs_api_key"), cfg.get("elevenlabs_voice_id")
    return bool(key and voice and str(key).strip() and "PUT-" not in str(key))


def harvest_sources(content):
    """Fontes nos blocos de resultado da busca e nas citações dos blocos de texto."""
    out = []
    for block in content:
        if block.get("type") == "web_search_tool_result":
            items = block.get("content")
            if isinstance(items, list):   # erro vem como objeto, não lista
                for it in items:
                    if isinstance(it, dict) and it.get("url"):
                        out.append({"title": str(it.get("title") or it["url"])[:120], "url": str(it["url"])[:500]})
        elif block.get("type") == "text":
            for c in block.get("citations") or []:
                if isinstance(c, dict) and c.get("url"):
                    out.append({"title": str(c.get("title") or c["url"])[:120], "url": str(c["url"])[:500], "cited": True})
    return out


def dedupe_sources(sources):
    seen, out = set(), []
    for s in sorted(sources, key=lambda s: not s.get("cited")):  # citadas primeiro
        if s["url"] not in seen:
            seen.add(s["url"])
            out.append({"title": s["title"], "url": s["url"]})
    return out[:MAX_SOURCES]


def friendly_api_error(e, model):
    s = e.status
    if s == -1:
        return f"Resposta inválida da API: {e.message}."
    if s == 0:
        hint = (" — no Mac com Python do python.org, rode 'Install Certificates.command' na pasta do Python."
                if "CERTIFICATE_VERIFY_FAILED" in e.message else "")
        return f"Sem conexão com a API da Anthropic: {e.message}{hint}"
    if s == 401:
        return "A API recusou a chave (401). Confira api_key em config.json."
    if s == 402:
        return "Problema de cobrança na conta da API (402): confira os créditos em console.anthropic.com."
    if s == 403:
        return f"Esta chave não tem permissão para {model} (403)."
    if s == 404:
        return f"Modelo '{model}' não encontrado (404). Confira 'model' em config.json."
    if s == 429:
        wait = f" em {int(e.retry_after)} s" if e.retry_after else " em instantes"
        return f"Limite de uso da API atingido (429). Tente de novo{wait}."
    if s >= 500:
        return f"API sobrecarregada ou fora do ar ({s}). Tente de novo."
    return f"A API recusou o pedido ({s}): {e.message}"


# ------------------------------------------------------------------- cérebro ----

class Brain:
    def __init__(self, cfg):
        self.lock = threading.RLock()
        self.sessions = {}
        self.dropped = {}        # modelo -> parâmetros opcionais que a API recusou para ele
        self.cli_unknown = set()  # flags que o Claude Code instalado (antigo) não conhece
        self.cwd = tempfile.mkdtemp(prefix="jarvis-")  # `claude -p` roda longe de qualquer CLAUDE.md
        self.load(build.notes_path(cfg))

    def load(self, notes_dir):
        self.notes_dir = notes_dir
        self.notes, self.links = build.build(notes_dir)
        self.index_all()
        self.graph_mtime = self.graph_stamp()

    @staticmethod
    def graph_stamp():
        try:
            return build.GRAPH_JS.stat().st_mtime_ns
        except OSError:
            return None

    def sync(self, cfg):
        """Rodou `build.py` com o servidor no ar (outra pasta, ou notas novas)? Recarrega sem reiniciar."""
        want = build.notes_path(cfg)
        with self.lock:
            if want == self.notes_dir and self.graph_stamp() == self.graph_mtime:
                return
            if not want.is_dir():
                return  # caminho inválido no config: segue com o que já está carregado
            try:
                self.load(want)
            except build.NotesError as e:
                print(f"Aviso: não recarreguei as notas: {e}", file=sys.stderr)
                return
            print(f"Notas recarregadas: {len(self.notes)} de {want}", file=sys.stderr)

    # ---- índice de palavras-chave
    def index_all(self):
        self.postings, self.titles = {}, []
        for i, n in enumerate(self.notes):
            self.index_note(i, n)

    def index_note(self, i, n):
        counts = {}
        for t in build.tokens(n["label"] + "\n" + n["text"]):
            if len(t) >= 2 and t not in build.STOPWORDS:
                s = stem(t)
                counts[s] = counts.get(s, 0) + 1
        for s, c in counts.items():
            self.postings.setdefault(s, {})[i] = c
        self.titles.append({stem(t) for t in build.tokens(n["label"])})

    def score(self, text, weight=1.0, scores=None):
        scores = {} if scores is None else scores
        total = max(len(self.notes), 1)
        for q in set(query_terms(text)):
            docs = self.postings.get(q)
            if not docs:
                continue
            idf = math.log(1 + total / len(docs))
            for i, tf in docs.items():
                s = idf * (1 + math.log(tf))
                if q in self.titles[i]:
                    s += 2.5 * idf  # bater no título pesa mais
                scores[i] = scores.get(i, 0.0) + weight * s
        return scores

    def most_related(self, text):
        """Nota mais parecida — mas só se dividir 2+ termos ou um termo do título.
        Uma palavra solta em comum ("presente" de presente e "presente" de achado) não é parentesco."""
        # termo presente em mais da metade das notas não conta como parentesco
        common = max(1, len(self.notes) // 2)
        terms = {q for q in query_terms(text) if len(self.postings.get(q, {})) <= common}
        scores = self.score(text)
        ok = [i for i in scores
              if len({q for q in terms if i in self.postings.get(q, {})}) >= 2
              or any(q in self.titles[i] for q in terms)]
        return min(ok, key=lambda i: (-scores[i], i)) if ok else None

    @property
    def build_id(self):
        return build.build_id(self.notes)

    def session(self, sid):
        s = self.sessions.get(sid)
        if s is None:
            if len(self.sessions) >= MAX_SESSIONS:
                del self.sessions[min(self.sessions, key=lambda k: self.sessions[k]["seen"])]
            s = self.sessions[sid] = {"turns": deque(maxlen=HISTORY_TURNS), "seen": time.time()}
        return s

    def status(self):
        try:
            cfg = build.load_config()
        except ValueError:
            cfg = dict(build.DEFAULT_CONFIG)
        self.sync(cfg)
        backend = pick_backend(cfg)
        code, _, _ = lang_of(cfg)
        model = cfg.get("model") if backend == "api" else (cfg.get("cli_model") or "claude-code") if backend else None
        with self.lock:
            return {"notes": len(self.notes), "links": len(self.links), "language": code,
                    "brain": backend or "none", "model": model, "humor": humor_of(cfg),
                    "tts": "elevenlabs" if eleven_ready(cfg) else "browser",
                    "briefing": self.briefing(cfg), "remote_url": getattr(self, "remote_url", None),
                    "build_id": self.build_id}

    # ---- diário local (máquina do tempo)
    def log_event(self, kind, **fields):
        entry = dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S"), kind=kind, **fields)
        try:
            with self.lock:
                with open(HISTORY, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                if sum(1 for _ in open(HISTORY, encoding="utf-8")) > HISTORY_MAX * 1.2:
                    keep = read_history()[-HISTORY_MAX:]
                    HISTORY.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in keep), encoding="utf-8")
        except OSError as e:
            print(f"Aviso: não gravei no diário: {e}", file=sys.stderr)

    def journal(self, cfg, backend, question, window, build_id):
        start, end, label = window
        _, _, lg = lang_of(cfg)
        entries = [e for e in read_history() if start.isoformat() <= e.get("ts", "")[:10] <= end.isoformat()]
        if not entries:
            return {"answer": EMPTY_JOURNAL[lg](label), "nodes": [], "build_id": build_id, "journal": label}
        lines, nodes = [], []
        by_path = {n["path"]: i for i, n in enumerate(self.notes)}
        for e in entries[-60:]:
            stamp = e["ts"][11:16] if end == start else e["ts"][5:16].replace("T", " ")
            if e["kind"] == "chat":
                lines.append(f"[{stamp}] asked: {e.get('q', '')} -> answer: {e.get('a', '')}")
            elif e["kind"] == "research":
                lines.append(f"[{stamp}] web research: {e.get('q', '')} -> {e.get('a', '')}")
            elif e["kind"] == "capture":
                lines.append(f"[{stamp}] captured note \"{e.get('title', '')}\": {e.get('text', '')}")
                if e.get("path") in by_path and by_path[e["path"]] not in nodes:
                    nodes.append(by_path[e["path"]])
            elif e["kind"] == "settings":
                lines.append(f"[{stamp}] changed setting: {e.get('what', '')}")
        block = "<journal day=\"" + esc_attr(label) + "\">\n" + "\n".join(lines)[:12000] + "\n</journal>"
        msgs = [{"role": "user", "content": block + "\n\nQuestion: " + question}]
        try:
            text = self.ask(cfg, backend, journal_prompt(cfg), msgs, None)
        except Refusal:
            return {"answer": REFUSAL_LINE[lg], "nodes": [], "build_id": build_id}
        answer = parse_reply(text)[0] if str(text).lstrip().startswith("{") else str(text).strip()
        if not answer:
            raise BrainError("O modelo não devolveu uma resposta utilizável. Tente de novo.", 502)
        return {"answer": answer, "nodes": nodes[:MAX_SOURCES], "build_id": build_id, "journal": label}

    # ---- /research: pesquisa na web por voz
    def research(self, query, sid):
        query = (query or "").strip()[:1000]
        if not query:
            raise BrainError("Pesquisar o quê, exatamente?", 400)
        cfg = self.config()
        backend = self.backend(cfg)
        _, _, lg = lang_of(cfg)
        try:
            if backend == "api":
                answer, sources = self.research_api(cfg, query)
            else:
                answer, sources = self.research_cli(cfg, query)
        except Refusal:
            return {"answer": REFUSAL_LINE[lg], "sources": []}
        if not answer:
            raise BrainError("A pesquisa não devolveu uma resposta utilizável. Tente de novo.", 502)
        with self.lock:
            sess = self.session(sid)
            sess["turns"].append((f"[web research] {query}", answer))
            sess["seen"] = time.time()
        self.log_event("research", q=query, a=answer, sources=[s["url"] for s in sources])
        return {"answer": answer, "sources": sources}

    def research_api(self, cfg, query):
        key, _ = api_key(cfg)
        model = str(cfg.get("model") or build.DEFAULT_CONFIG["model"])
        basic = any(mark in model for mark in BASIC_SEARCH_MODELS)
        headers = {"content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION}
        messages = [{"role": "user", "content": query}]
        sources, answer = [], ""
        # "low" às vezes responde de cabeça sem buscar; pesquisa merece um degrau a mais
        effort = str(cfg.get("research_effort") or "medium")
        for hop in range(6):  # a API pausa a cada 10 iterações internas: reenvia e ela continua
            tool = {"type": WEB_SEARCH_BASIC if basic else WEB_SEARCH_NEW, "name": "web_search", "max_uses": MAX_SEARCHES}
            body = {"model": model, "max_tokens": 16000, "system": research_prompt(cfg), "tools": [tool],
                    "messages": messages}
            if effort and not basic:
                body["output_config"] = {"effort": effort}
            try:
                data = http_post_json(cfg.get("api_url") or API_URL, body, headers, 150)
            except ApiError as e:
                msg = e.message.lower()
                if e.status == 400 and not basic and WEB_SEARCH_NEW in msg:
                    basic = True  # modelo que só conhece a busca básica
                    continue
                if e.status == 400 and effort and "effort" in msg:
                    effort = ""   # modelo sem o parâmetro: segue sem ele
                    continue
                if e.status == 400 and "web_search" in msg:
                    raise BrainError("A busca na web não está habilitada para esta chave. No console da Anthropic: "
                                     "Settings → Privacy → Web search.") from None
                raise BrainError(friendly_api_error(e, model)) from None
            if data.get("stop_reason") == "refusal":
                raise Refusal()
            content = data.get("content") or []
            sources += harvest_sources(content)
            answer = "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
            if data.get("stop_reason") != "pause_turn":
                break
            messages = [{"role": "user", "content": query}, {"role": "assistant", "content": content}]
        return answer, dedupe_sources(sources)

    def research_cli(self, cfg, query):
        schema = {"type": "object", "properties": {
            "answer": {"type": "string"},
            "sources": {"type": "array", "items": {"type": "object", "properties": {
                "title": {"type": "string"}, "url": {"type": "string"}},
                "required": ["title", "url"], "additionalProperties": False}}},
            "required": ["answer", "sources"], "additionalProperties": False}
        prompt = (query + "\n\nUse the WebSearch tool, then reply with JSON {\"answer\": <two or three spoken "
                  "sentences>, \"sources\": [{\"title\", \"url\"}]} listing the pages you actually used.")
        out = self.call_cli(cfg, research_prompt(cfg), [{"role": "user", "content": prompt}], schema,
                            300, tools="WebSearch")
        answer, _ = parse_reply(out)
        sources = []
        if isinstance(out, dict):
            for s in out.get("sources") or []:
                if isinstance(s, dict) and str(s.get("url", "")).startswith("http"):
                    sources.append({"title": str(s.get("title") or s["url"])[:120], "url": str(s["url"])[:500]})
        return answer, dedupe_sources(sources)

    # ---- /settings: troca de modelo e dial de humor, por voz
    def settings(self, body):
        cfg = self.config()
        _, _, lg = lang_of(cfg)
        changed, lines = {}, []
        if body.get("model") is not None:
            alias, mid = model_alias(str(body["model"]))
            if not mid:
                raise BrainError(f"Modelo desconhecido: {body['model']}", 400)
            if pick_backend(cfg) == "cli":
                cfg["cli_model"] = alias if alias in MODEL_ALIASES else mid
            else:
                cfg["model"] = mid
                self.dropped.pop(mid, None)
            changed["model"] = mid
            lines.append(MODEL_LINES[lg].get(alias, f"{mid}, {'senhor' if lg == 'pt' else 'sir'}."))
        if body.get("humor") is not None:
            try:
                h = max(0, min(100, int(body["humor"])))
            except (TypeError, ValueError):
                raise BrainError("Humor vai de 0 a 100.", 400) from None
            cfg["humor"] = h
            changed["humor"] = h
            lines.append(HUMOR_LINES[lg](h))
        if not changed:
            raise BrainError("Nada para mudar.", 400)
        build.save_config(cfg)
        self.log_event("settings", what=", ".join(f"{k}={v}" for k, v in changed.items()))
        return dict(changed, line=" ".join(lines))

    # ---- /tts: voz clonada (ElevenLabs), opcional — a chave fica no servidor
    def tts(self, text):
        cfg = self.config()
        if not eleven_ready(cfg):
            raise BrainError("Voz ElevenLabs não configurada (elevenlabs_api_key e elevenlabs_voice_id).", 404)
        text = (text or "").strip()[:1500]
        if not text:
            raise BrainError("Nada para falar.", 400)
        url = (f"{cfg.get('elevenlabs_url') or ELEVEN_URL}/v1/text-to-speech/"
               f"{urllib.parse.quote(str(cfg['elevenlabs_voice_id']))}?output_format=mp3_44100_128")
        body = json.dumps({"text": text, "model_id": cfg.get("elevenlabs_model") or ELEVEN_MODEL}).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "xi-api-key": str(cfg["elevenlabs_api_key"]), "content-type": "application/json", "accept": "audio/mpeg"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read(), r.headers.get("content-type") or "audio/mpeg"
        except urllib.error.HTTPError as e:
            raise BrainError(f"ElevenLabs recusou ({e.code}): {e.read().decode('utf-8', 'replace')[:200]}", 502) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            raise BrainError(f"ElevenLabs fora de alcance: {getattr(e, 'reason', e)}", 502) from None

    # ---- briefing opcional: saída de um comando local (ex.: agenda do dia via icalBuddy)
    def briefing(self, cfg):
        cmd = cfg.get("briefing_command")
        if not cmd:
            return None
        with self.lock:
            cached = getattr(self, "_briefing", None)
            if cached and cached[0] == cmd and time.time() - cached[1] < BRIEFING_TTL:
                return cached[2]
        try:
            proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10, cwd=self.cwd)
            text = (proc.stdout or "").strip() or (proc.stderr or "").strip()[:200]
        except (subprocess.TimeoutExpired, OSError) as e:
            text = f"(briefing falhou: {e})"
        text = re.sub(r"[ \t]+", " ", text)[:1500]
        with self.lock:
            self._briefing = (cmd, time.time(), text)
        return text

    # ---- /chat
    def chat(self, question, sid):
        question = (question or "").strip()[:2000]
        if not question:
            raise BrainError("Pergunta vazia.", 400)
        cfg = self.config()
        backend = self.backend(cfg)
        self.sync(cfg)
        window = journal_window(question)
        if window:  # "o que eu fiz na terça?": responde pelo diário, não pelas notas
            with self.lock:
                build_id = self.build_id
            out = self.journal(cfg, backend, question, window, build_id)
            with self.lock:
                sess = self.session(sid)
                sess["turns"].append((question, out["answer"]))
                sess["seen"] = time.time()
            return out
        with self.lock:
            sess = self.session(sid)
            scores = self.score(question)
            if sess["turns"]:  # pergunta de seguimento herda um pouco do assunto anterior
                self.score(sess["turns"][-1][0], 0.35, scores)
            picked = sorted(scores, key=lambda i: (-scores[i], i))[:TOP_K]
            messages = []
            for q, a in sess["turns"]:
                messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
            messages.append({"role": "user", "content": notes_block(picked, self.notes) + "\n\nQuestion: " + question})
            build_id = self.build_id
        try:
            answer, sources = parse_reply(self.ask(cfg, backend, system_prompt(cfg), messages, REPLY_SCHEMA))
        except Refusal:
            return {"answer": REFUSAL_LINE[lang_of(cfg)[2]], "nodes": [], "build_id": build_id}
        if not answer:
            raise BrainError("O modelo não devolveu uma resposta utilizável (vazia ou cortada). Tente de novo.", 502)
        nodes = []
        for s in sources:
            if 1 <= s <= len(picked) and picked[s - 1] not in nodes:
                nodes.append(picked[s - 1])
        with self.lock:
            sess["turns"].append((question, answer))
            sess["seen"] = time.time()
        self.log_event("chat", q=question, a=answer, nodes=nodes)
        return {"answer": answer, "nodes": nodes, "build_id": build_id}

    # ---- /remember
    def remember(self, text):
        cfg = self.config()
        self.sync(cfg)
        code, info, lg = lang_of(cfg)
        fact = REMEMBER_RE.sub("", (text or "").strip(), count=1).strip()[:4000]
        if not fact:
            raise BrainError("Lembrar o quê, exatamente?" if lg == "pt" else "Remember what, exactly?", 400)
        title = make_title(fact)
        captures = self.notes_dir / "captures"
        with self.lock:
            anchor = self.most_related(fact)
            captures.mkdir(parents=True, exist_ok=True)
            base = safe_filename(title)
            path, k = captures / (base + ".md"), 2
            while path.exists():
                path, k = captures / f"{base} {k}.md", k + 1
            stamp = time.strftime("%d/%m/%Y %H:%M") if lg == "pt" else time.strftime("%Y-%m-%d %H:%M")
            lines = [f"# {title}", "", fact, ""]
            if anchor is not None:
                lines.append(("Relacionada: " if lg == "pt" else "Related: ") + f"[[{self.notes[anchor]['label']}]]")
            lines.append(("— capturada por JARVIS em " if lg == "pt" else "— captured by JARVIS on ") + stamp)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")

            note = build.load_note(path, self.notes_dir)
            prev_build_id = self.build_id  # o navegador confere: só cola o nó novo se estava em dia
            idx = len(self.notes)
            self.notes.append(note)
            self.index_note(idx, note)
            before = {(l["source"], l["target"]) for l in self.links}
            self.links = build.build_links(self.notes)
            after = {(l["source"], l["target"]) for l in self.links}
            added = [{"source": a, "target": b} for a, b in sorted(after - before)]
            removed = [{"source": a, "target": b} for a, b in sorted(before - after)]
            build.write_graph(self.notes, self.links, self.notes_dir)
            self.graph_mtime = self.graph_stamp()
            node = build.node_payload(idx, note)
            build_id = self.build_id
        line = self.quip(cfg, fact, title)
        self.log_event("capture", title=title, text=fact[:500], path=note["path"])
        return {"node": node, "links": added, "removed": removed, "anchor": anchor, "line": line,
                "prev_build_id": prev_build_id, "build_id": build_id, "path": note["path"]}

    def quip(self, cfg, fact, title):
        _, info, lg = lang_of(cfg)
        backend = pick_backend(cfg)
        if backend:
            prompt = (f"The user just asked you to remember this, and you filed it as a new note titled "
                      f"\"{title}\":\n\n{fact}\n\nConfirm it out loud in ONE short witty sentence "
                      f"(at most 20 words), in {info['name']}. Plain text only.")
            try:
                # frase decorativa: uma tentativa só e prazo curto — a nota já está salva
                text = self.ask(cfg, backend, persona(cfg), [{"role": "user", "content": prompt}], None,
                                timeout=20 if backend == "api" else 60, retries=0)
                text = parse_reply(text)[0] if text.lstrip().startswith("{") else text.strip()
                if text:
                    return text
            except Exception as e:  # qualquer falha aqui não pode desfazer a memória gravada
                print(f"Aviso: frase de confirmação falhou ({e}); uso uma pronta.", file=sys.stderr)
        return random.choice(CANNED[lg])

    # ---- modelo
    def config(self):
        try:
            return build.load_config()
        except ValueError as e:
            raise BrainError(str(e), 500)

    def safe_config(self):
        try:
            return build.load_config()
        except ValueError:
            return dict(build.DEFAULT_CONFIG)

    def backend(self, cfg):
        backend = pick_backend(cfg)
        if backend is None:
            raise BrainError("model not configured: cole sua API key em config.json "
                             "(ou instale o Claude Code para usar `claude -p`).", 503)
        return backend

    def ask(self, cfg, backend, system, messages, schema, timeout=None, retries=2):
        slow = cfg.get("effort", "low") in SLOW_EFFORTS
        if backend == "api":
            return self.call_api(cfg, system, messages, schema, timeout or (240 if slow else 90), retries)
        return self.call_cli(cfg, system, messages, schema, timeout or (300 if slow else 180))

    def call_api(self, cfg, system, messages, schema, timeout, retries):
        key, _ = api_key(cfg)
        model = str(cfg.get("model") or build.DEFAULT_CONFIG["model"])
        dropped = self.dropped.setdefault(model, set())
        effort = cfg.get("effort", "low")
        # a recusa fica presa ao VALOR: corrigir um effort digitado errado volta a valer sem reiniciar
        flags = {"format": "format", "effort": f"effort={effort}", "fallbacks": "fallbacks"}
        attempt = 0
        while True:
            body = {"model": model, "max_tokens": MAX_TOKENS.get(effort, 16000), "system": system, "messages": messages}
            headers = {"content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION}
            output_config = {}
            if schema and flags["format"] not in dropped:
                output_config["format"] = {"type": "json_schema", "schema": schema}
            if effort and flags["effort"] not in dropped:
                output_config["effort"] = effort  # resposta curta: pouco raciocínio, menos espera
            if output_config:
                body["output_config"] = output_config
            if model in FALLBACK_MODELS and flags["fallbacks"] not in dropped:
                body["fallbacks"] = "default"
                headers["anthropic-beta"] = FALLBACK_BETA
            sent = {f for f, on in (("format", "format" in output_config), ("effort", "effort" in output_config),
                                    ("fallbacks", "fallbacks" in body)) if on}
            try:
                data = http_post_json(cfg.get("api_url") or API_URL, body, headers, timeout)
            except ApiError as e:
                if e.status == 400:
                    # modelo que não aceita um parâmetro opcional: tira, tenta de novo e lembra
                    msg = e.message.lower()
                    feature = next((f for f, marks in OPTIONAL_PARAMS
                                    if f in sent and any(m in msg for m in marks)), None)
                    if feature:
                        dropped.add(flags[feature])
                        print(f"Aviso: {model} recusou '{flags[feature]}'; sigo sem ele. ({e.message[:160]})",
                              file=sys.stderr)
                        continue
                    raise BrainError(friendly_api_error(e, model)) from None
                if attempt < retries and retryable(e):
                    attempt += 1
                    time.sleep(e.retry_after or 1.5 * attempt)
                    continue
                raise BrainError(friendly_api_error(e, model)) from None
            if data.get("stop_reason") == "refusal":
                raise Refusal()
            if data.get("stop_reason") == "max_tokens":
                raise BrainError("A resposta estourou o limite de tamanho (max_tokens). "
                                 "Tente de novo, ou baixe o 'effort' em config.json.")
            return "".join(b.get("text", "") for b in data.get("content") or [] if b.get("type") == "text")

    def call_cli(self, cfg, system, messages, schema, timeout, tools=""):
        exe = claude_exe(cfg)
        if not exe:
            raise BrainError("Comando `claude` não encontrado no PATH.", 503)
        history = ""
        if len(messages) > 1:
            lines = []
            for m in messages[:-1]:
                lines.append(("User: " if m["role"] == "user" else "JARVIS: ") + m["content"])
            history = "Earlier in this conversation:\n" + "\n".join(lines) + "\n\nNow:\n"
        prompt = history + messages[-1]["content"]
        # flag -> valor (None = flag sem valor). As duas travas fazem do `claude -p` um chat puro:
        # sem ferramentas e sem servidores MCP, uma nota maliciosa não tem com o que agir.
        # tools="" = chat puro; tools="WebSearch" = só a busca na web do Claude Code (nada local)
        flags = [("--system-prompt", system), ("--tools", tools), ("--strict-mcp-config", None),
                 ("--no-session-persistence", None), ("--disable-slash-commands", None)]
        if schema:
            flags.append(("--json-schema", json.dumps(schema)))
        if cfg.get("effort", "low"):
            flags.append(("--effort", str(cfg.get("effort", "low"))))
        if cfg.get("cli_model"):
            flags.append(("--model", str(cfg["cli_model"])))
        while True:
            usable = [(f, v) for f, v in flags if f not in self.cli_unknown]
            args = [exe, "-p", "--output-format", "json"]
            for f, v in usable:
                args += [f] if v is None else [f, v]
            text = prompt if "--system-prompt" in dict(usable) else system + "\n\n" + prompt
            out = self.run_cli(args, text, timeout)
            if not isinstance(out, UnknownFlag):
                return out
            if out.flag in CLI_LOCKS or out.flag not in dict(flags) or out.flag in self.cli_unknown:
                raise BrainError(f"Seu Claude Code não reconhece {out.flag}. Atualize com `claude update` "
                                 "(ou cole uma API key em config.json).", 503)
            self.cli_unknown.add(out.flag)  # versão antiga: tira só esta flag e lembra
            print(f"Aviso: o Claude Code instalado não conhece {out.flag}; sigo sem ela.", file=sys.stderr)

    def run_cli(self, args, prompt, timeout):
        try:
            proc = subprocess.run(args, input=prompt, capture_output=True, text=True,
                                  timeout=timeout, cwd=self.cwd)
        except subprocess.TimeoutExpired:
            raise BrainError(f"`claude -p` passou de {timeout} s sem responder.") from None
        except OSError as e:
            raise BrainError(f"Não consegui executar `claude`: {e}") from None
        err = (proc.stderr or "").strip()
        unknown = re.search(r"unknown option '?(--[\w-]+)", err, re.I)
        if proc.returncode != 0 and unknown:
            return UnknownFlag(unknown.group(1))
        try:
            env = json.loads(proc.stdout)
        except ValueError:
            env = None
        if isinstance(env, dict):
            if env.get("is_error") or env.get("subtype", "success") != "success":
                detail = str(env.get("result") or err or env.get("subtype"))[:300]
                if "login" in detail.lower():
                    detail += " (rode `claude` uma vez no terminal e faça login)"
                raise BrainError("`claude -p` falhou: " + detail)
            if env.get("stop_reason") == "refusal":
                raise Refusal()
            if isinstance(env.get("structured_output"), dict):
                return env["structured_output"]
            return str(env.get("result") or "")
        if proc.returncode != 0:
            raise BrainError("`claude -p` falhou: " + (err or proc.stdout)[:300])
        return proc.stdout


# --------------------------------------------------------------------- HTTP ----

class Handler(SimpleHTTPRequestHandler):
    server_version = "JARVIS/1.0"
    timeout = 30  # cliente que trava no meio do pedido não segura uma thread para sempre

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(build.VIEWER), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        # outra página aberta no navegador não pode embutir graph-data.js e ler os trechos das notas
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        try:
            noisy = int(code) >= 400
        except (TypeError, ValueError):
            noisy = False
        if noisy or self.command == "POST":
            super().log_request(code, size)

    def list_directory(self, path):
        self.send_error(404)
        return None

    # proteção contra outra aba/site mandando POST para o localhost (e contra DNS rebinding)
    def host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
        return host_allowed(host, self.server.brain.safe_config())

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        u = urllib.parse.urlsplit(origin)
        if u.scheme not in ("http", "https") or not u.hostname:
            return False
        host = u.hostname.lower()
        if host in LOOPBACK or host == "::1":   # a própria página, no próprio computador
            return u.scheme == "http" and u.port == self.server.server_address[1]
        return host_allowed(host, self.server.brain.safe_config())  # iPad pelo Tailscale (HTTPS)

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def foreign_load(self):
        """Script/fetch disparado por OUTRO site (Sec-Fetch-Site). Abrir um link continua valendo."""
        site = self.headers.get("Sec-Fetch-Site")
        return site in ("cross-site", "same-site") and self.headers.get("Sec-Fetch-Mode") != "navigate"

    def static_ok(self):
        if not self.host_ok() or self.foreign_load():
            self.send_error(403)
            return False
        path = urllib.parse.unquote(self.path.split("?", 1)[0])  # /%2EDS_Store também é oculto
        if any(part.startswith(".") for part in path.replace("\\", "/").split("/") if part):
            self.send_error(404)
            return False
        return True

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/status":
            if not self.host_ok() or self.foreign_load():
                return self.send_error(403)
            return self.send_json(200, self.server.brain.status())
        if self.static_ok():
            super().do_GET()

    def do_HEAD(self):
        if self.static_ok():
            super().do_HEAD()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        if route not in ("/chat", "/remember", "/research", "/settings", "/tts"):
            return self.send_json(404, {"error": "rota inexistente"})
        if not (self.host_ok() and self.origin_ok()):
            return self.send_json(403, {"error": "origem não permitida"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_json(415, {"error": "envie JSON"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            return self.send_json(400, {"error": "Content-Length inválido"})
        if length > MAX_BODY:
            return self.send_json(413, {"error": "pedido grande demais"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.send_json(400, {"error": "JSON inválido"})
        brain = self.server.brain
        try:
            if route == "/chat":
                sid = str(body.get("session") or "")
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid):
                    sid = "anon"
                return self.send_json(200, brain.chat(str(body.get("question") or ""), sid))
            if route == "/research":
                sid = str(body.get("session") or "")
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid):
                    sid = "anon"
                return self.send_json(200, brain.research(str(body.get("query") or ""), sid))
            if route == "/settings":
                return self.send_json(200, brain.settings(body))
            if route == "/tts":
                audio, ctype = brain.tts(str(body.get("text") or ""))
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                return self.wfile.write(audio)
            return self.send_json(200, brain.remember(str(body.get("text") or "")))
        except BrainError as e:
            return self.send_json(e.status, {"error": str(e)})
        except Exception:
            traceback.print_exc()
            return self.send_json(500, {"error": "erro interno — veja o terminal do servidor"})


def main():
    if not build.CONFIG.exists():
        build.save_config(dict(build.DEFAULT_CONFIG))
        print("Criei config.json. Cole sua API key nele, ou deixe o placeholder para usar `claude -p`.")
    try:
        cfg = build.load_config()
    except ValueError as e:
        sys.exit(f"Erro: {e}")
    notes_dir = build.notes_path(cfg)
    if not notes_dir.is_dir():
        sys.exit(f"Pasta de notas não encontrada: {notes_dir}\n"
                 "Aponte para a sua: python3 build.py /caminho/da/pasta")

    try:
        brain = Brain(cfg)
    except build.NotesError as e:
        sys.exit(f"Erro: {e}")
    port = int(os.environ.get("JARVIS_PORT") or cfg.get("port") or 4700)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        sys.exit(f"Não consegui abrir a porta {port}: {e}. Já tem outro server.py rodando?")
    server.daemon_threads = True
    server.brain = brain

    backend = pick_backend(cfg)
    if backend == "api":
        mind = f"API Anthropic · {cfg.get('model')} (chave de {api_key(cfg)[1]})"
    elif backend == "cli":
        mind = "claude -p · assinatura do Claude Code (mais lento, sem custo de API)"
    else:
        mind = "NENHUM: model not configured. Cole a API key em config.json."
    print(f"JARVIS online · {len(brain.notes)} notas · {len(brain.links)} ligações · {notes_dir}")
    print(f"Cérebro: {mind}")
    print(f"Abra no Chrome: http://localhost:{port}")
    if cfg.get("tailscale"):
        url, err = tailscale_url(port)
        brain.remote_url = url
        print(f"No iPad/iPhone (Safari, com o Tailscale ligado): {url}" if url else f"Tailscale: {err}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nAté logo, senhor.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
