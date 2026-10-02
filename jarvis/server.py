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
    r"(?:remember(?:\s+that)?"
    r"|lembr(?:e|a|ar)(?:[-\s]se)?(?:\s+de)?\s+que"
    r"|anot(?:e|a|ar)(?:\s+a[ií])?(?:\s+que)?"
    r"|guard(?:e|a)(?:\s+a[ií])?\s+(?:que|isso)"
    r"|memoriz(?:e|a)(?:\s+que)?)"
    r"(?=[\s:,.!-]|$)[\s:,.!-]*",
    re.I,
)

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
    return shutil.which(str(cfg.get("claude_command") or "claude"))


def pick_backend(cfg):
    mode = str(cfg.get("backend") or "auto").lower()
    has_key = api_key(cfg)[0] is not None
    has_cli = claude_exe(cfg) is not None
    if mode == "api":
        return "api" if has_key else None
    if mode == "cli":
        return "cli" if has_cli else None
    return "api" if has_key else ("cli" if has_cli else None)


def persona(cfg):
    _, info, _ = lang_of(cfg)
    return (
        "You are J.A.R.V.I.S., the voice of the user's personal knowledge base: their own markdown notes, "
        "which they see on screen as a 3D galaxy of stars.\n\n"
        "Persona: a dry, impeccably polite British butler with a razor wit. Address the user as "
        f"\"{info['sir']}\" occasionally, not in every sentence. One genuinely funny line beats three bland ones. "
        "Never gush, never grovel.\n\n"
        f"Always reply in {info['name']}. Your reply is spoken aloud by a speech synthesizer, so write plain "
        "sentences: no markdown, no lists, no emoji, no note numbers."
    )


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
    """(answer, sources) a partir do JSON estruturado — ou, se vier texto solto, o texto inteiro."""
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
            return reply.strip(), []
    answer = str(obj.get("answer") or "").strip()
    sources = []
    for s in obj.get("sources") or []:
        try:
            sources.append(int(s))
        except (TypeError, ValueError):
            pass
    return answer, sources


def make_title(fact):
    words = re.findall(r"[\w'’-]+", fact)
    title = " ".join(words[:6])[:60].strip(" -'’")
    if not title:
        title = time.strftime("Captura %Y-%m-%d %H%M")
    return title[0].upper() + title[1:]


def safe_filename(title):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", title).strip(" .")
    return name or "captura"


def http_post_json(url, body, headers, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
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


def friendly_api_error(e, model):
    s = e.status
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
        return "Limite de uso da API atingido (429). Tente de novo em instantes."
    if s >= 500:
        return f"API sobrecarregada ou fora do ar ({s}). Tente de novo."
    return f"A API recusou o pedido ({s}): {e.message}"


# ------------------------------------------------------------------- cérebro ----

class Brain:
    def __init__(self, cfg):
        self.lock = threading.RLock()
        self.sessions = {}
        self.dropped = {}        # modelo -> parâmetros opcionais que a API recusou para ele
        self.cli_minimal = False  # Claude Code antigo, sem as flags novas
        self.cwd = tempfile.mkdtemp(prefix="jarvis-")  # `claude -p` roda longe de qualquer CLAUDE.md
        self.notes_dir = build.notes_path(cfg)
        self.notes, self.links = build.build(self.notes_dir)
        self.index_all()

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
        terms = set(query_terms(text))
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
        backend = pick_backend(cfg)
        code, _, _ = lang_of(cfg)
        with self.lock:
            return {"notes": len(self.notes), "links": len(self.links), "language": code,
                    "brain": backend or "none", "model": cfg.get("model") if backend == "api" else None,
                    "build_id": self.build_id}

    # ---- /chat
    def chat(self, question, sid):
        question = (question or "").strip()[:2000]
        if not question:
            raise BrainError("Pergunta vazia.", 400)
        cfg = self.config()
        backend = self.backend(cfg)
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
            raise BrainError("O modelo respondeu vazio. Tente de novo.", 502)
        nodes = []
        for s in sources:
            if 1 <= s <= len(picked) and picked[s - 1] not in nodes:
                nodes.append(picked[s - 1])
        with self.lock:
            sess["turns"].append((question, answer))
            sess["seen"] = time.time()
        return {"answer": answer, "nodes": nodes, "build_id": build_id}

    # ---- /remember
    def remember(self, text):
        cfg = self.config()
        code, info, lg = lang_of(cfg)
        fact = REMEMBER_RE.sub("", (text or "").strip(), count=1).strip()[:4000]
        if not fact:
            raise BrainError("Lembrar o quê, exatamente?" if lg == "pt" else "Remember what, exactly?", 400)
        if fact[0].islower():
            fact = fact[0].upper() + fact[1:]
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
            idx = len(self.notes)
            self.notes.append(note)
            self.index_note(idx, note)
            before = {(l["source"], l["target"]) for l in self.links}
            self.links = build.build_links(self.notes)
            new_links = [l for l in self.links if (l["source"], l["target"]) not in before]
            build.write_graph(self.notes, self.links, self.notes_dir)
            node = build.node_payload(idx, note)
            build_id = self.build_id
        line = self.quip(cfg, fact, title)
        return {"node": node, "links": new_links, "anchor": anchor, "line": line,
                "build_id": build_id, "path": note["path"]}

    def quip(self, cfg, fact, title):
        _, info, lg = lang_of(cfg)
        backend = pick_backend(cfg)
        if backend:
            prompt = (f"The user just asked you to remember this, and you filed it as a new note titled "
                      f"\"{title}\":\n\n{fact}\n\nConfirm it out loud in ONE short witty sentence "
                      f"(at most 20 words), in {info['name']}. Plain text only.")
            try:
                text = self.ask(cfg, backend, persona(cfg), [{"role": "user", "content": prompt}], None,
                                timeout=25 if backend == "api" else 60)
                text = parse_reply(text)[0] if text.lstrip().startswith("{") else text.strip()
                if text:
                    return text
            except (BrainError, Refusal):
                pass
        return random.choice(CANNED[lg])

    # ---- modelo
    def config(self):
        try:
            return build.load_config()
        except ValueError as e:
            raise BrainError(str(e), 500)

    def backend(self, cfg):
        backend = pick_backend(cfg)
        if backend is None:
            raise BrainError("model not configured: cole sua API key em config.json "
                             "(ou instale o Claude Code para usar `claude -p`).", 503)
        return backend

    def ask(self, cfg, backend, system, messages, schema, timeout=None):
        if backend == "api":
            return self.call_api(cfg, system, messages, schema, timeout or 90)
        return self.call_cli(cfg, system, messages, schema, timeout or 180)

    def call_api(self, cfg, system, messages, schema, timeout):
        key, _ = api_key(cfg)
        model = str(cfg.get("model") or build.DEFAULT_CONFIG["model"])
        dropped = self.dropped.setdefault(model, set())
        effort = cfg.get("effort", "low")
        retries = 0
        while True:
            body = {"model": model, "max_tokens": 16000, "system": system, "messages": messages}
            headers = {"content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION}
            output_config = {}
            if schema and "format" not in dropped:
                output_config["format"] = {"type": "json_schema", "schema": schema}
            if effort and "effort" not in dropped:
                output_config["effort"] = effort  # resposta curta: pouco raciocínio, menos espera
            if output_config:
                body["output_config"] = output_config
            if model in FALLBACK_MODELS and "fallbacks" not in dropped:
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
                        dropped.add(feature)
                        continue
                    raise BrainError(friendly_api_error(e, model)) from None
                if e.status in (0, 408, 429, 500, 502, 503, 504, 529) and retries < 2:
                    retries += 1
                    time.sleep(min(e.retry_after or 1.5 * retries, 8))
                    continue
                raise BrainError(friendly_api_error(e, model)) from None
            if data.get("stop_reason") == "refusal":
                raise Refusal()
            return "".join(b.get("text", "") for b in data.get("content") or [] if b.get("type") == "text")

    def call_cli(self, cfg, system, messages, schema, timeout):
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
        args = [exe, "-p", "--output-format", "json"]
        if not self.cli_minimal:
            rich = args + ["--system-prompt", system, "--tools", "", "--no-session-persistence",
                           "--strict-mcp-config", "--disable-slash-commands"]
            if schema:
                rich += ["--json-schema", json.dumps(schema)]
            if cfg.get("effort", "low"):
                rich += ["--effort", str(cfg.get("effort", "low"))]
            if cfg.get("cli_model"):
                rich += ["--model", str(cfg["cli_model"])]
            out = self.run_cli(rich, prompt, timeout)
            if out is not None:
                return out
            self.cli_minimal = True  # versão antiga do Claude Code: cai para o mínimo
        return self.run_cli(args, system + "\n\n" + prompt, timeout, minimal=True)

    def run_cli(self, args, prompt, timeout, minimal=False):
        try:
            proc = subprocess.run(args, input=prompt, capture_output=True, text=True,
                                  timeout=timeout, cwd=self.cwd)
        except subprocess.TimeoutExpired:
            raise BrainError(f"`claude -p` passou de {timeout} s sem responder.") from None
        except OSError as e:
            raise BrainError(f"Não consegui executar `claude`: {e}") from None
        err = (proc.stderr or "").strip()
        if proc.returncode != 0 and not minimal and "unknown option" in err.lower():
            return None
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
            if isinstance(env.get("structured_output"), dict):
                return env["structured_output"]
            return str(env.get("result") or "")
        if proc.returncode != 0:
            raise BrainError("`claude -p` falhou: " + (err or proc.stdout)[:300])
        return proc.stdout


# --------------------------------------------------------------------- HTTP ----

class Handler(SimpleHTTPRequestHandler):
    server_version = "JARVIS/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(build.VIEWER), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
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
        return host in LOOPBACK

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        port = self.server.server_address[1]
        return origin in {f"http://{h}:{port}" for h in LOOPBACK}

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def static_ok(self):
        if not self.host_ok():
            self.send_error(403)
            return False
        path = self.path.split("?", 1)[0]
        if any(part.startswith(".") for part in path.split("/") if part):
            self.send_error(404)
            return False
        return True

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/status":
            if not self.host_ok():
                return self.send_error(403)
            return self.send_json(200, self.server.brain.status())
        if self.static_ok():
            super().do_GET()

    def do_HEAD(self):
        if self.static_ok():
            super().do_HEAD()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        if route not in ("/chat", "/remember"):
            return self.send_json(404, {"error": "rota inexistente"})
        if not (self.host_ok() and self.origin_ok()):
            return self.send_json(403, {"error": "origem não permitida"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_json(415, {"error": "envie JSON"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
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

    brain = Brain(cfg)
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nAté logo, senhor.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
