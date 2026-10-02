"""Bateria do JARVIS — só biblioteca padrão.

    cd jarvis && python3 -m unittest discover tests -v

Cada grupo roda numa cópia temporária do projeto, com uma API falsa da Anthropic
e um `claude` falso: não gasta token, não precisa de internet e não toca nas suas notas.
"""

import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEY = "sk-ant-test-0000-nao-e-uma-chave-real"
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ------------------------------------------------------------ API falsa ----

class MockAPI:
    """Imita POST /v1/messages e guarda cada pedido para conferência."""

    def __init__(self):
        self.requests = []
        self.refuse = False
        self.reject_effort = False
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                mock.requests.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                if mock.reject_effort and "effort" in body.get("output_config", {}):
                    return self.reply(400, {"type": "error", "error": {"type": "invalid_request_error",
                                      "message": "output_config.effort: not supported for this model"}})
                if mock.refuse:
                    return self.reply(200, {"type": "message", "content": [], "stop_reason": "refusal",
                                            "stop_details": {"type": "refusal", "category": None}})
                if "format" in body.get("output_config", {}):
                    last = body["messages"][-1]["content"]
                    notes = re.findall(r'<note number="(\d+)" title="([^"]+)"', last)
                    if notes:
                        out = {"answer": f"Resposta de teste sobre {notes[0][1]}.", "sources": [int(notes[0][0])]}
                    else:
                        out = {"answer": "Conversa fiada, senhor.", "sources": []}
                    text = json.dumps(out, ensure_ascii=False)
                else:
                    text = "Anotado, senhor, com a devida pompa."
                # bloco de raciocínio vazio antes do texto, como nos modelos com thinking sempre ligado
                self.reply(200, {"type": "message", "stop_reason": "end_turn", "content": [
                    {"type": "thinking", "thinking": "", "signature": "x"}, {"type": "text", "text": text}]})

            def reply(self, status, payload):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1/messages"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


# ------------------------------------------------------- JARVIS isolado ----

class Jarvis:
    def __init__(self, config):
        self.dir = Path(tempfile.mkdtemp(prefix="jarvis-test-"))
        for name in ("build.py", "server.py", "viewer", "notes"):
            src = ROOT / name
            if src.is_dir():
                shutil.copytree(src, self.dir / name, ignore=shutil.ignore_patterns("captures", "graph-data.js*"))
            else:
                shutil.copy2(src, self.dir / name)
        self.port = free_port()
        (self.dir / "config.json").write_text(json.dumps(dict(config, port=self.port)), encoding="utf-8")
        env = dict(os.environ, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
        env.pop("ANTHROPIC_API_KEY", None)
        self.proc = subprocess.Popen([sys.executable, "server.py"], cwd=self.dir, env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(100):
            try:
                if self.get("/api/status")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        self.close()
        raise RuntimeError("server.py não subiu")

    def raw(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        hdrs = {"Host": f"localhost:{self.port}"}
        hdrs.update(headers or {})
        conn.request(method, path, body=body, headers=hdrs)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, data

    def get(self, path, headers=None):
        return self.raw("GET", path, headers=headers)

    def post(self, path, payload, headers=None):
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        status, data = self.raw("POST", path, json.dumps(payload).encode(), hdrs)
        return status, json.loads(data or b"{}")

    def graph(self):
        src = (self.dir / "viewer" / "graph-data.js").read_text(encoding="utf-8")
        return json.loads(src[src.index("{"):src.rindex("}") + 1])

    def close(self):
        self.proc.terminate()
        try:
            self.proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


def index_of(graph, label):
    return next(n["id"] for n in graph["nodes"] if n["label"] == label)


# ----------------------------------------------------------------- testes ----

class TestBuild(unittest.TestCase):
    def test_graph_shape(self):
        sys.path.insert(0, str(ROOT))
        import build
        notes = build.scan(ROOT / "notes")
        notes = [n for n in notes if not n["path"].startswith("captures/")]
        links = build.build_links(notes)
        labels = [n["label"] for n in notes]
        self.assertGreaterEqual(len(notes), 25)
        self.assertEqual(len(labels), len(set(labels)))
        ends = {(l["source"], l["target"]) for l in links}
        self.assertTrue(all(0 <= a < b < len(notes) for a, b in ends))
        idx = {n["label"]: i for i, n in enumerate(notes)}
        pair = lambda a, b: (min(idx[a], idx[b]), max(idx[a], idx[b]))
        self.assertIn(pair("RABT", "Shock Index"), ends)            # [[Shock Index]] no texto
        self.assertIn(pair("TRISS", "RTS"), ends)                   # título mencionado
        self.assertIn(pair("Exportação de dados", "Limitações do app"), ends)  # [[REDCap]] em comum, sem nota
        self.assertTrue(all(len(n["excerpt"]) <= 701 for n in notes))
        degree = {i: 0 for i in range(len(notes))}
        for a, b in ends:
            degree[a] += 1
            degree[b] += 1
        self.assertFalse([labels[i] for i, d in degree.items() if d == 0], "nota isolada")

    def test_remember_phrases(self):
        sys.path.insert(0, str(ROOT))
        import server
        strip = lambda s: server.REMEMBER_RE.sub("", s, count=1)
        self.assertEqual(strip("remember that prompt packs make excellent free gifts"),
                         "prompt packs make excellent free gifts")
        self.assertEqual(strip("Lembre que o PTM tem 4 ciclos"), "o PTM tem 4 ciclos")
        self.assertEqual(strip("Jarvis, lembre-se de que a TC fecha às 22h"), "a TC fecha às 22h")
        self.assertEqual(strip("anota aí: trocar a capa do iPad"), "trocar a capa do iPad")
        self.assertEqual(strip("anotações do RTS?"), "anotações do RTS?")  # pergunta, não comando


class TestServerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = MockAPI()
        cls.j = Jarvis({"api_key": KEY, "model": "claude-opus-5-5", "notes_dir": "notes",
                        "language": "pt-BR", "api_url": cls.api.url})
        cls.g = cls.j.graph()

    @classmethod
    def tearDownClass(cls):
        cls.j.close()
        cls.api.close()

    def setUp(self):
        self.api.requests.clear()
        self.api.refuse = False

    def test_serves_only_viewer(self):
        status, html = self.j.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"J.A.R.V.I.S.", html)
        self.assertEqual(self.j.get("/graph-data.js")[0], 200)
        for path in ("/config.json", "/../config.json", "/%2e%2e/config.json", "/server.py",
                     "/notes/escores/RABT.md", "/../notes/escores/RABT.md", "/.hidden"):
            self.assertEqual(self.j.get(path)[0], 404, path)

    def test_key_never_leaves_the_server(self):
        for path in ("/", "/graph-data.js", "/api/status"):
            self.assertNotIn(KEY.encode(), self.j.get(path)[1], path)
        status, body = self.j.post("/chat", {"question": "critérios do RABT", "session": "k1"})
        self.assertNotIn(KEY, json.dumps(body))
        self.assertEqual(self.api.requests[-1]["headers"]["x-api-key"], KEY)

    def test_status(self):
        status, data = self.j.get("/api/status")
        info = json.loads(data)
        self.assertEqual((info["brain"], info["language"], info["model"]), ("api", "pt-BR", "claude-opus-5-5"))
        current = self.j.graph()   # outro teste pode ter acrescentado uma memória
        self.assertEqual((info["notes"], info["build_id"]), (len(current["nodes"]), current["meta"]["build_id"]))

    def test_chat_request_shape_and_sources(self):
        status, body = self.j.post("/chat", {"question": "Quais são os critérios do RABT?", "session": "s1"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["answer"], "Resposta de teste sobre RABT.")
        self.assertEqual(body["nodes"], [index_of(self.g, "RABT")])
        req = self.api.requests[-1]
        h, b = req["headers"], req["body"]
        self.assertEqual(h["anthropic-version"], "2023-06-01")
        self.assertEqual(h["anthropic-beta"], "server-side-fallback-2026-07-01")
        self.assertEqual(b["model"], "claude-opus-5-5")
        self.assertEqual(b["fallbacks"], "default")
        self.assertEqual(b["output_config"]["effort"], "low")
        self.assertEqual(b["output_config"]["format"]["type"], "json_schema")
        self.assertFalse({"temperature", "top_p", "top_k", "thinking"} & set(b))
        self.assertIn("ONLY from the notes", b["system"])
        self.assertIn("Brazilian Portuguese", b["system"])
        last = b["messages"][-1]["content"]
        self.assertTrue(last.startswith("<notes>"))
        self.assertEqual(last.count("<note number="), 6)
        self.assertIn('<note number="1" title="RABT"', last)

    def test_follow_up_keeps_history(self):
        self.j.post("/chat", {"question": "Como se calcula o TRISS?", "session": "s2"})
        self.j.post("/chat", {"question": "E para menores de 15 anos?", "session": "s2"})
        msgs = self.api.requests[-1]["body"]["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant", "user"])
        self.assertEqual(msgs[0]["content"], "Como se calcula o TRISS?")
        self.assertIn('title="TRISS"', msgs[2]["content"])  # o assunto anterior ajuda a busca

    def test_small_talk_does_not_move_camera(self):
        status, body = self.j.post("/chat", {"question": "xyzzy plugh", "session": "s3"})
        self.assertEqual((status, body["nodes"]), (200, []))
        self.assertIn("no note shares a keyword", self.api.requests[-1]["body"]["messages"][-1]["content"])

    def test_refusal_returns_line_in_character(self):
        self.api.refuse = True
        status, body = self.j.post("/chat", {"question": "critérios do RABT", "session": "s4"})
        self.assertEqual(status, 200)
        self.assertEqual(body["nodes"], [])
        self.assertIn("alçada", body["answer"])

    def test_request_guards(self):
        status, _ = self.j.raw("POST", "/chat", b"{}", {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _ = self.j.post("/chat", {"question": "oi"}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.j.post("/chat", {"question": "oi"}, {"Host": "evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(self.j.get("/", {"Host": "rebind.evil.example"})[0], 403)
        status, _ = self.j.raw("POST", "/chat", b"x" * 70000, {"Content-Type": "application/json"})
        self.assertEqual(status, 413)
        status, body = self.j.post("/chat", {"question": "   "})
        self.assertEqual(status, 400)

    def test_remember_adds_live_node(self):
        before = self.j.graph()
        status, body = self.j.post("/remember", {"text": "Lembre que o RABT pontua fratura de pelve só suspeita"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["node"]["id"], len(before["nodes"]))
        self.assertEqual(body["node"]["group"], "captures")
        self.assertEqual(body["anchor"], index_of(before, "RABT"))
        self.assertIn({"source": body["anchor"], "target": body["node"]["id"]}, body["links"])
        self.assertEqual(body["line"], "Anotado, senhor, com a devida pompa.")
        note = self.j.dir / "notes" / body["path"]
        text = note.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# O RABT pontua fratura de pelve"))
        self.assertIn("[[RABT]]", text)
        after = self.j.graph()
        self.assertEqual(len(after["nodes"]), len(before["nodes"]) + 1)
        self.assertEqual(after["meta"]["build_id"], body["build_id"])
        status, data = self.j.get("/api/status")
        self.assertEqual(json.loads(data)["notes"], len(after["nodes"]))
        # a nota nova já responde perguntas
        status, chat = self.j.post("/chat", {"question": "fratura de pelve suspeita conta no RABT?", "session": "s5"})
        self.assertEqual(chat["build_id"], body["build_id"])


class TestOptionalParams(unittest.TestCase):
    def test_unsupported_effort_is_dropped_and_remembered(self):
        api = MockAPI()
        api.reject_effort = True
        j = Jarvis({"api_key": KEY, "model": "claude-haiku-4-5", "notes_dir": "notes", "api_url": api.url})
        try:
            status, body = j.post("/chat", {"question": "critérios do NEXUS", "session": "e1"})
            self.assertEqual(status, 200, body)
            first, second = api.requests[0]["body"], api.requests[1]["body"]
            self.assertIn("effort", first["output_config"])
            self.assertNotIn("effort", second["output_config"])
            self.assertNotIn("fallbacks", first)               # Haiku não recebe fallbacks
            self.assertNotIn("anthropic-beta", api.requests[0]["headers"])
            j.post("/chat", {"question": "critérios do NEXUS", "session": "e1"})
            self.assertEqual(len(api.requests), 3)              # não tenta o effort de novo
        finally:
            j.close()
            api.close()


FAKE_CLAUDE = r'''#!{python}
import json, sys
args = sys.argv[1:]
open({log!r}, "a").write(json.dumps(args) + "\n")
prompt = sys.stdin.read()
if {old} and len(args) > 3:
    sys.stderr.write("error: unknown option '--system-prompt'\n")
    sys.exit(1)
if "--json-schema" in args:
    out = {{"type": "result", "subtype": "success", "is_error": False, "result": "",
           "structured_output": {{"answer": "Pela CLI, senhor.", "sources": [1]}}}}
else:
    out = {{"type": "result", "subtype": "success", "is_error": False,
           "result": json.dumps({{"answer": "CLI antiga, senhor.", "sources": [1]}}) if "<notes>" in prompt else "Anotado."}}
print(json.dumps(out))
'''


class TestClaudeCLI(unittest.TestCase):
    def run_with(self, old):
        tmp = Path(tempfile.mkdtemp(prefix="fake-claude-"))
        log = tmp / "args.log"
        exe = tmp / "claude"
        exe.write_text(FAKE_CLAUDE.format(python=sys.executable, log=str(log), old=old), encoding="utf-8")
        exe.chmod(0o755)
        j = Jarvis({"api_key": "PUT-YOUR-KEY-HERE", "notes_dir": "notes", "claude_command": str(exe)})
        try:
            status, info = j.get("/api/status")
            self.assertEqual(json.loads(info)["brain"], "cli")
            status, body = j.post("/chat", {"question": "Quando retiro o colar pelo NEXUS?", "session": "c1"})
            self.assertEqual(status, 200, body)
            return body, [json.loads(l) for l in log.read_text().splitlines()], j.graph()
        finally:
            j.close()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_cli_backend(self):
        body, calls, g = self.run_with(old=False)
        self.assertEqual(body["answer"], "Pela CLI, senhor.")
        self.assertEqual(body["nodes"], [index_of(g, "NEXUS")])
        args = calls[0]
        for flag in ("-p", "--output-format", "--system-prompt", "--json-schema", "--tools", "--no-session-persistence"):
            self.assertIn(flag, args)

    def test_old_cli_falls_back_to_minimal_flags(self):
        body, calls, g = self.run_with(old=True)
        self.assertEqual(body["answer"], "CLI antiga, senhor.")
        self.assertEqual(calls[-1], ["-p", "--output-format", "json"])


class TestNoBrain(unittest.TestCase):
    def test_model_not_configured_but_remember_still_works(self):
        j = Jarvis({"api_key": "PUT-YOUR-KEY-HERE", "notes_dir": "notes", "claude_command": "claude-que-nao-existe"})
        try:
            self.assertEqual(json.loads(j.get("/api/status")[1])["brain"], "none")
            status, body = j.post("/chat", {"question": "RABT?", "session": "n1"})
            self.assertEqual(status, 503)
            self.assertIn("model not configured", body["error"])
            # "presentes" bate com "critério presente" do NEXUS, mas uma palavra solta não é parentesco
            status, first = j.post("/remember", {"text": "Lembre que prompt packs são ótimos presentes"})
            self.assertEqual((status, first["anchor"], first["links"]), (200, None, []))
            self.assertTrue(first["line"])
            self.assertNotIn("[[", (j.dir / "notes" / first["path"]).read_text(encoding="utf-8"))
            # já "prompt packs" de novo é parentesco: a memória nova nasce ao lado da anterior
            status, second = j.post("/remember", {"text": "remember that prompt packs make excellent free gifts"})
            self.assertEqual((status, second["anchor"]), (200, first["node"]["id"]))
            self.assertTrue((j.dir / "notes" / second["path"]).exists())
        finally:
            j.close()


if __name__ == "__main__":
    unittest.main()
