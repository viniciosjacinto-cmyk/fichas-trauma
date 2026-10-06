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
        self.mode = None          # "cut" | "garbage" | "garbage-quip" | "incomplete-once"
        self.reject_new_search = False   # modelo que só conhece a busca básica
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                mock.requests.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                effort = body.get("output_config", {}).get("effort")
                if (mock.reject_effort and effort) or (effort and effort not in ("low", "medium", "high", "xhigh", "max")):
                    return self.reply(400, {"type": "error", "error": {"type": "invalid_request_error",
                                      "message": "output_config.effort: not supported for this model"}})
                if mock.refuse:
                    return self.reply(200, {"type": "message", "content": [], "stop_reason": "refusal",
                                            "stop_details": {"type": "refusal", "category": None}})
                quip = "format" not in body.get("output_config", {})
                tools = body.get("tools") or []
                if any(str(t.get("type", "")).startswith("web_search") for t in tools):
                    if mock.reject_new_search and tools[0]["type"] == "web_search_20260209":
                        return self.reply(400, {"type": "error", "error": {"type": "invalid_request_error",
                                          "message": "'claude-x' does not support tool types: web_search_20260209."}})
                    if not any(m["role"] == "assistant" for m in body["messages"]):
                        # 1ª rodada: a API pausou no meio da busca — o cliente reenvia e ela continua
                        return self.reply(200, {"type": "message", "stop_reason": "pause_turn", "content": [
                            {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search",
                             "input": {"query": "tranexamico trauma"}},
                            {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [
                                {"type": "web_search_result", "url": "https://example.org/wses", "title": "WSES guideline",
                                 "encrypted_content": "x", "page_age": "2023"},
                                {"type": "web_search_result", "url": "https://example.org/crash2", "title": "CRASH-2 trial",
                                 "encrypted_content": "y", "page_age": "2010"}]}]})
                    return self.reply(200, {"type": "message", "stop_reason": "end_turn", "content": [
                        {"type": "text", "text": "O CRASH-2 mostrou menos mortes com tranexâmico até 3 horas, senhor.",
                         "citations": [{"type": "web_search_result_location", "url": "https://example.org/crash2",
                                        "title": "CRASH-2 trial", "cited_text": "...", "encrypted_index": "e"}]}]})
                if mock.mode == "cut":        # raciocínio + resposta estouraram o max_tokens
                    return self.reply(200, {"type": "message", "stop_reason": "max_tokens", "content": [
                        {"type": "text", "text": '{"answer": "Senhor, pelos crit'}]})
                if mock.mode == "garbage" or (mock.mode == "garbage-quip" and quip):
                    data = b"<html>portal da rede do hospital</html>"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    return self.wfile.write(data)
                if mock.mode == "incomplete-once":   # conexão cai no meio do corpo, uma vez
                    mock.mode = None
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", "500")
                    self.end_headers()
                    self.wfile.write(b'{"type": "message", "con')
                    self.close_connection = True
                    return
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
        self.assertEqual(strip("Remember what the RABT criteria are?"), "Remember what the RABT criteria are?")

    def test_titles(self):
        sys.path.insert(0, str(ROOT))
        import server
        self.assertEqual(server.make_title("iMIST-AMBO tem 8 itens"), "iMIST-AMBO tem 8 itens")
        self.assertEqual(server.make_title("pH abaixo de 7,2 pede gasometria"), "pH abaixo de 7,2 pede gasometria")
        self.assertEqual(server.make_title("lactato acima de 4.0 é sinal de choque. Repetir."), "Lactato acima de 4.0 é sinal")
        self.assertEqual(server.make_title("o RABT pontua fratura de pelve só suspeita"), "O RABT pontua fratura de pelve")
        self.assertEqual(server.make_title("the trauma bay door code is 4471. Ask the nurse."), "The trauma bay door code")

    def test_odd_vaults(self):
        sys.path.insert(0, str(ROOT))
        import build
        v = Path(tempfile.mkdtemp(prefix="vault-"))
        try:
            (v / "a").mkdir()
            (v / "b").mkdir()
            files = {
                "bom.md": "﻿---\ntags: [hemorragia]\n---\n# bom\nCorpo com BOM.",
                "vazio.md": "---\n---\n# vazio\nParágrafo que cita Glasgow.\n\n---\n\nDepois da régua.",
                "Glasgow.md": "Escala.",
                "TC.md": "Tomografia.",
                "trauma.md": "Pedir TC de crânio; tc minúsculo não conta.",
                "a/index.md": "índice A", "b/index.md": "índice B",
                "a/trabalho.md": "Ver [[b/index]] e [[index]].",
                "v1.md": "Ver [[Protocolo v2.10]].", "v2.md": "Também [[Protocolo v2.10]].",
                "ru.md": "Viagem para [[Москва]].", "Париж.md": "Город.",
            }
            for name, text in files.items():
                (v / name).write_text(text, encoding="utf-8")
            (v / "latin.md").write_bytes("Transfusão maciça e Ácido".encode("cp1252"))
            os.symlink(v / "sumiu.md", v / "atalho.md")          # atalho quebrado: aviso, não queda
            notes = build.scan(v)
            by = {n["path"]: n for n in notes}
            self.assertNotIn("atalho.md", by)
            self.assertEqual(by["bom.md"]["excerpt"], "Corpo com BOM.")
            self.assertTrue(by["vazio.md"]["excerpt"].startswith("Parágrafo que cita Glasgow."))
            self.assertEqual(by["latin.md"]["excerpt"], "Transfusão maciça e Ácido")
            idx = {n["path"]: i for i, n in enumerate(notes)}
            pairs = {(l["source"], l["target"]) for l in build.build_links(notes)}
            linked = lambda x, y: (min(idx[x], idx[y]), max(idx[x], idx[y])) in pairs
            self.assertTrue(linked("vazio.md", "Glasgow.md"))
            self.assertTrue(linked("trauma.md", "TC.md"))                   # sigla em maiúsculas
            self.assertTrue(linked("a/trabalho.md", "b/index.md"))          # [[b/index]] respeita a pasta
            self.assertTrue(linked("a/trabalho.md", "a/index.md"))          # [[index]]: a da mesma pasta
            self.assertTrue(linked("v1.md", "v2.md"))                       # nome com ponto não é anexo
            self.assertFalse(linked("ru.md", "Париж.md"))                   # alvo não latino não liga a tudo
            self.assertFalse(linked("bom.md", "trauma.md"))
        finally:
            shutil.rmtree(v, ignore_errors=True)


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
        self.api.mode = None

    def test_cut_answer_is_an_error_not_spoken_json(self):
        self.api.mode = "cut"
        status, body = self.j.post("/chat", {"question": "critérios do RABT", "session": "cut1"})
        self.assertEqual(status, 502)
        self.assertIn("max_tokens", body["error"])

    def test_broken_responses(self):
        self.api.mode = "garbage"           # 200 que não é JSON: erro claro, não 500
        status, body = self.j.post("/chat", {"question": "critérios do RABT", "session": "g1"})
        self.assertEqual(status, 502)
        self.assertIn("não é JSON", body["error"])
        self.api.mode = "incomplete-once"   # conexão caiu no meio: tenta de novo e responde
        status, body = self.j.post("/chat", {"question": "critérios do RABT", "session": "g2"})
        self.assertEqual(status, 200, body)
        self.api.mode = "garbage-quip"      # a frase de confirmação falha, a memória continua valendo
        self.api.requests.clear()
        status, body = self.j.post("/remember", {"text": "lembre que o carrinho de parada fica no box 3"})
        self.assertEqual(status, 200, body)
        self.assertEqual(len(self.api.requests), 1)   # sem retentativa para a frase decorativa
        self.assertTrue((self.j.dir / "notes" / body["path"]).exists())

    def test_tailscale_and_allowed_hosts(self):
        ts = {"Host": "meu-mac.tail1234.ts.net"}
        self.assertEqual(self.j.get("/", ts)[0], 403)                      # desligado por padrão
        cfg = json.loads((self.j.dir / "config.json").read_text(encoding="utf-8"))
        cfg["tailscale"] = True
        cfg["allowed_hosts"] = ["meu-mac.local"]
        (self.j.dir / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
        try:
            self.assertEqual(self.j.get("/", ts)[0], 200)
            self.assertEqual(self.j.get("/graph-data.js", ts)[0], 200)
            self.assertEqual(self.j.get("/api/status", ts)[0], 200)
            self.assertEqual(self.j.get("/", {"Host": "meu-mac.local:4700"})[0], 200)
            status, body = self.j.post("/chat", {"question": "critérios do RABT", "session": "ts1"},
                                       dict(ts, Origin="https://meu-mac.tail1234.ts.net"))
            self.assertEqual(status, 200, body)
            # o que continua barrado: outros nomes, e um .ts.net disfarçado em outro domínio
            self.assertEqual(self.j.get("/", {"Host": "evil.example"})[0], 403)
            self.assertEqual(self.j.get("/", {"Host": "x.ts.net.evil.example"})[0], 403)
            status, _ = self.j.post("/chat", {"question": "oi"}, dict(ts, Origin="https://evil.example"))
            self.assertEqual(status, 403)
            status, _ = self.j.post("/chat", {"question": "oi"}, {"Origin": f"https://localhost:{self.j.port}"})
            self.assertEqual(status, 403)                                  # localhost só em http na porta certa
        finally:
            cfg.pop("tailscale"); cfg.pop("allowed_hosts")
            (self.j.dir / "config.json").write_text(json.dumps(cfg), encoding="utf-8")

    def test_remember_reports_removed_links(self):
        before = self.j.graph()
        status, body = self.j.post("/remember", {"text": "lembre que REDCap"})   # alvo antes sem nota própria
        self.assertEqual(status, 200, body)
        self.assertEqual(body["prev_build_id"], before["meta"]["build_id"])
        after = self.j.graph()
        b = {(l["source"], l["target"]) for l in before["links"]}
        a = {(l["source"], l["target"]) for l in after["links"]}
        self.assertTrue(b - a)
        self.assertEqual({(l["source"], l["target"]) for l in body["removed"]}, b - a)
        self.assertEqual({(l["source"], l["target"]) for l in body["links"]}, a - b)

    def test_static_hardening(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.j.port, timeout=10)
        conn.request("GET", "/graph-data.js", headers={"Host": f"localhost:{self.j.port}"})
        r = conn.getresponse()
        r.read()
        self.assertEqual(r.getheader("Cross-Origin-Resource-Policy"), "same-origin")
        conn.close()
        cross = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script"}
        self.assertEqual(self.j.get("/graph-data.js", cross)[0], 403)
        self.assertEqual(self.j.get("/api/status", cross)[0], 403)
        link = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        self.assertEqual(self.j.get("/", link)[0], 200)          # abrir por um link continua valendo
        (self.j.dir / "viewer" / ".DS_Store").write_text("segredo")
        for path in ("/.DS_Store", "/%2EDS_Store", "/%2eDS_Store"):
            self.assertEqual(self.j.get(path)[0], 404, path)
        status, _ = self.j.raw("POST", "/chat", b"{}", {"Content-Type": "application/json", "Content-Length": "-1"})
        self.assertEqual(status, 400)

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

    def test_bad_effort_value_recovers_after_config_fix(self):
        api = MockAPI()
        j = Jarvis({"api_key": KEY, "model": "claude-opus-5-5", "notes_dir": "notes", "api_url": api.url,
                    "effort": "lwo"})
        try:
            status, body = j.post("/chat", {"question": "critérios do NEXUS", "session": "e2"})
            self.assertEqual(status, 200, body)
            sent = [r["body"].get("output_config", {}).get("effort") for r in api.requests]
            self.assertEqual(sent, ["lwo", None])
            cfg = json.loads((j.dir / "config.json").read_text(encoding="utf-8"))
            cfg["effort"] = "low"                                 # usuário corrige o config.json
            (j.dir / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
            j.post("/chat", {"question": "critérios do NEXUS", "session": "e2"})
            self.assertEqual(api.requests[-1]["body"]["output_config"].get("effort"), "low")
        finally:
            j.close()
            api.close()


class TestJournalWindow(unittest.TestCase):
    def test_windows(self):
        import datetime as dt
        sys.path.insert(0, str(ROOT))
        import server
        today = dt.date(2026, 10, 2)   # sexta-feira
        w = lambda q: server.journal_window(q, today)
        self.assertEqual(w("O que eu fiz na terça?")[:2], (dt.date(2026, 9, 29), dt.date(2026, 9, 29)))
        self.assertEqual(w("resumo de ontem")[:2], (dt.date(2026, 10, 1), dt.date(2026, 10, 1)))
        self.assertEqual(w("o que rolou semana passada")[:2], (dt.date(2026, 9, 21), dt.date(2026, 9, 27)))
        self.assertEqual(w("o que eu perguntei dia 28")[:2], (dt.date(2026, 9, 28), dt.date(2026, 9, 28)))
        self.assertEqual(w("what did I ask last friday")[:2], (dt.date(2026, 9, 25), dt.date(2026, 9, 25)))
        self.assertEqual(w("o que eu fiz hoje")[:2], (today, today))
        self.assertIsNone(w("qual a dose de hoje do tranexâmico"))      # sem intenção de diário
        self.assertIsNone(w("o que eu fiz com o colar cervical"))        # sem data


class TestExtras(unittest.TestCase):
    """Pesquisa na web, troca de modelo, humor, diário, voz clonada e briefing."""

    @classmethod
    def setUpClass(cls):
        cls.api = MockAPI()
        cls.j = Jarvis({"api_key": KEY, "model": "claude-opus-5-5", "notes_dir": "notes", "language": "pt-BR",
                        "api_url": cls.api.url, "briefing_command": "printf 'Reuniao 9h\\n- Plantao 19h'"})

    @classmethod
    def tearDownClass(cls):
        cls.j.close()
        cls.api.close()

    def setUp(self):
        self.api.requests.clear()
        self.api.mode = None
        self.api.reject_new_search = False

    def test_research_api(self):
        status, body = self.j.post("/research", {"query": "dose do ácido tranexâmico no trauma", "session": "r1"})
        self.assertEqual(status, 200, body)
        self.assertIn("CRASH-2", body["answer"])
        self.assertEqual([s["url"] for s in body["sources"]],
                         ["https://example.org/crash2", "https://example.org/wses"])   # citada primeiro
        self.assertEqual(len(self.api.requests), 2)                                   # pause_turn -> reenvio
        first, second = self.api.requests[0]["body"], self.api.requests[1]["body"]
        self.assertEqual(first["tools"], [{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}])
        self.assertNotIn("output_config.format", json.dumps(first))
        self.assertEqual(second["messages"][1]["role"], "assistant")
        self.assertEqual(second["messages"][1]["content"][0]["type"], "server_tool_use")
        self.assertIn("research", first["system"].lower())
        # a pesquisa entra no histórico da sessão, para a pergunta seguinte fazer sentido
        self.j.post("/chat", {"question": "e a dose?", "session": "r1"})
        self.assertIn("[web research]", self.api.requests[-1]["body"]["messages"][0]["content"])

    def test_research_falls_back_to_basic_search_tool(self):
        self.api.reject_new_search = True
        status, body = self.j.post("/research", {"query": "RABT score origem", "session": "r2"})
        self.assertEqual(status, 200, body)
        types = [r["body"]["tools"][0]["type"] for r in self.api.requests]
        self.assertEqual(types, ["web_search_20260209", "web_search_20250305", "web_search_20250305"])

    def test_settings_model_and_humor(self):
        status, body = self.j.post("/settings", {"model": "haiku"})
        self.assertEqual((status, body["model"]), (200, "claude-haiku-4-5"))
        self.assertIn("Haiku", body["line"])
        cfg = json.loads((self.j.dir / "config.json").read_text(encoding="utf-8"))
        self.assertEqual((cfg["model"], cfg["api_key"]), ("claude-haiku-4-5", KEY))   # o resto do config fica
        status, body = self.j.post("/settings", {"humor": 20})
        self.assertEqual((status, body["humor"]), (200, 20))
        self.j.post("/chat", {"question": "critérios do RABT", "session": "h1"})
        self.assertIn("Wit dial: 20 of 100", self.api.requests[-1]["body"]["system"])
        self.assertEqual(self.api.requests[-1]["body"]["model"], "claude-haiku-4-5")
        self.assertEqual(self.j.post("/settings", {"model": "gpt-9"})[0], 400)
        self.assertEqual(self.j.post("/settings", {})[0], 400)
        self.j.post("/settings", {"model": "opus", "humor": 70})
        info = json.loads(self.j.get("/api/status")[1])
        self.assertEqual((info["model"], info["humor"]), ("claude-opus-5-5", 70))

    def test_journal(self):
        self.j.post("/chat", {"question": "Quais são os critérios do RABT?", "session": "j1"})
        status, cap = self.j.post("/remember", {"text": "lembre que o carrinho de parada fica no box 3"})
        self.assertEqual(status, 200, cap)
        self.api.requests.clear()
        status, body = self.j.post("/chat", {"question": "O que eu fiz hoje?", "session": "j1"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["journal"], "hoje")
        self.assertEqual(body["nodes"], [cap["node"]["id"]])        # a memória do dia vira fonte
        sent = self.api.requests[-1]["body"]
        self.assertIn("<journal", sent["messages"][-1]["content"])
        self.assertIn("asked: Quais são os critérios do RABT?", sent["messages"][-1]["content"])
        self.assertIn("captured note", sent["messages"][-1]["content"])
        self.assertNotIn("<notes>", sent["messages"][-1]["content"])
        self.api.requests.clear()
        status, body = self.j.post("/chat", {"question": "O que eu fiz anteontem?", "session": "j1"})
        self.assertEqual((status, body["nodes"]), (200, []))
        self.assertIn("Nada registrado", body["answer"])
        self.assertEqual(self.api.requests, [])                     # dia vazio não gasta token

    def test_briefing_in_status(self):
        info = json.loads(self.j.get("/api/status")[1])
        self.assertEqual(info["briefing"], "Reuniao 9h\n- Plantao 19h")
        self.assertEqual(info["tts"], "browser")

    def test_tts_proxy(self):
        got = {}

        class Eleven(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                got["path"] = self.path
                got["key"] = self.headers.get("xi-api-key")
                got["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                data = b"ID3fake-mp3-bytes"
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Eleven)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            self.assertEqual(self.j.post("/tts", {"text": "Olá"})[0], 404)      # sem chave: desligado
            cfg = json.loads((self.j.dir / "config.json").read_text(encoding="utf-8"))
            cfg.update(elevenlabs_api_key="el-test-key", elevenlabs_voice_id="voz123",
                       elevenlabs_url=f"http://127.0.0.1:{httpd.server_address[1]}")
            (self.j.dir / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
            self.assertEqual(json.loads(self.j.get("/api/status")[1])["tts"], "elevenlabs")
            status, data = self.j.raw("POST", "/tts", json.dumps({"text": "Olá, senhor."}).encode(),
                                      {"Content-Type": "application/json"})
            self.assertEqual((status, data), (200, b"ID3fake-mp3-bytes"))
            self.assertEqual(got["key"], "el-test-key")
            self.assertTrue(got["path"].startswith("/v1/text-to-speech/voz123"))
            self.assertEqual(got["body"]["text"], "Olá, senhor.")
            self.assertNotIn("el-test-key", self.j.get("/")[1].decode())   # a chave não vai ao navegador
        finally:
            httpd.shutdown()
            httpd.server_close()
            cfg.pop("elevenlabs_api_key"); cfg.pop("elevenlabs_voice_id"); cfg.pop("elevenlabs_url")
            (self.j.dir / "config.json").write_text(json.dumps(cfg), encoding="utf-8")


FAKE_TAILSCALE = r'''#!{python}
import json, sys
args = sys.argv[1:]
open({log!r}, "a").write(json.dumps(args) + "\n")
mode = open({mode!r}).read().strip()
if args[:2] == ["status", "--json"]:
    if mode == "offline":
        print(json.dumps({{"Self": {{"DNSName": "", "Online": False}}}}))
    else:
        print(json.dumps({{"Self": {{"DNSName": "meu-mac.tail1a2b.ts.net.", "Online": True}}}}))
elif args[:2] == ["serve", "status"]:
    print("https://meu-mac.tail1a2b.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:4700" if mode == "served" else "No serve config")
elif args[:2] == ["serve", "--bg"]:
    if mode == "nocert":
        sys.stderr.write("error: HTTPS certs are not enabled for this tailnet\n"); sys.exit(1)
    print("Available within your tailnet:\nhttps://meu-mac.tail1a2b.ts.net/\n|-- proxy http://127.0.0.1:" + args[2])
'''


class TestTailscaleHelper(unittest.TestCase):
    def test_tailscale_url(self):
        sys.path.insert(0, str(ROOT))
        import server
        tmp = Path(tempfile.mkdtemp(prefix="fake-tailscale-"))
        log, mode, exe = tmp / "args.log", tmp / "mode", tmp / "tailscale"
        exe.write_text(FAKE_TAILSCALE.format(python=sys.executable, log=str(log), mode=str(mode)), encoding="utf-8")
        exe.chmod(0o755)
        old = server.TAILSCALE_BINS
        server.TAILSCALE_BINS = (str(exe),)
        try:
            mode.write_text("served")                      # já configurado: não roda serve de novo
            self.assertEqual(server.tailscale_url(4700), ("https://meu-mac.tail1a2b.ts.net", None))
            self.assertNotIn(["serve", "--bg", "4700"], [json.loads(l) for l in log.read_text().splitlines()])
            mode.write_text("fresh")                       # primeira vez: liga o serve na porta certa
            self.assertEqual(server.tailscale_url(4711)[0], "https://meu-mac.tail1a2b.ts.net")
            self.assertIn(["serve", "--bg", "4711"], [json.loads(l) for l in log.read_text().splitlines()])
            mode.write_text("nocert")
            url, err = server.tailscale_url(4700)
            self.assertIsNone(url)
            self.assertIn("HTTPS Certificates", err)
            mode.write_text("offline")
            url, err = server.tailscale_url(4700)
            self.assertIsNone(url)
            self.assertIn("faça login", err)
            server.TAILSCALE_BINS = ("tailscale-que-nao-existe",)
            self.assertIn("Instale o app", server.tailscale_url(4700)[1])
        finally:
            server.TAILSCALE_BINS = old
            shutil.rmtree(tmp, ignore_errors=True)


class TestLiveRebuild(unittest.TestCase):
    def test_build_py_while_server_runs(self):
        api = MockAPI()
        j = Jarvis({"api_key": KEY, "model": "claude-opus-5-5", "notes_dir": "notes", "api_url": api.url})
        try:
            other = j.dir / "outra"
            other.mkdir()
            (other / "Plantão.md").write_text("Escala do plantão de sábado.", encoding="utf-8")
            (other / "Sala.md").write_text("A sala de trauma tem 2 leitos. Ver [[Plantão]].", encoding="utf-8")
            r = subprocess.run([sys.executable, "build.py", str(other)], cwd=j.dir, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            info = json.loads(j.get("/api/status")[1])          # o servidor percebe sozinho
            self.assertEqual((info["notes"], info["build_id"]), (2, j.graph()["meta"]["build_id"]))
            status, body = j.post("/remember", {"text": "lembre que o plantão de sábado começa às 7h"})
            self.assertEqual(status, 200, body)
            self.assertTrue((other / "captures" / Path(body["path"]).name).exists())
            self.assertEqual(len(j.graph()["nodes"]), 3)
            # caminho digitado errado não vai parar no config
            r = subprocess.run([sys.executable, "build.py", str(j.dir / "nao-existe")], cwd=j.dir,
                               capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertEqual(json.loads((j.dir / "config.json").read_text())["notes_dir"], str(other.resolve()))
        finally:
            j.close()
            api.close()


FAKE_CLAUDE = r'''#!{python}
import json, sys
args = sys.argv[1:]
open({log!r}, "a").write(json.dumps(args) + "\n")
prompt = sys.stdin.read()
for flag in {unknown!r}:          # Claude Code antigo: não conhece estas flags
    if flag in args:
        sys.stderr.write("error: unknown option '%s'\n" % flag)
        sys.exit(1)
if "--tools" in args and args[args.index("--tools") + 1] == "WebSearch":
    out = {{"type": "result", "subtype": "success", "is_error": False, "result": "",
           "structured_output": {{"answer": "Pela web, senhor.",
                                  "sources": [{{"title": "CRASH-2", "url": "https://example.org/crash2"}}]}}}}
elif "--json-schema" in args:
    out = {{"type": "result", "subtype": "success", "is_error": False, "result": "",
           "structured_output": {{"answer": "Pela CLI, senhor.", "sources": [1]}}}}
else:
    out = {{"type": "result", "subtype": "success", "is_error": False,
           "result": json.dumps({{"answer": "CLI antiga, senhor.", "sources": [1]}}) if "<notes>" in prompt else "Anotado."}}
print(json.dumps(out))
'''


class TestClaudeCLI(unittest.TestCase):
    def run_with(self, unknown=()):
        tmp = Path(tempfile.mkdtemp(prefix="fake-claude-"))
        log = tmp / "args.log"
        exe = tmp / "claude"
        exe.write_text(FAKE_CLAUDE.format(python=sys.executable, log=str(log), unknown=list(unknown)),
                       encoding="utf-8")
        exe.chmod(0o755)
        j = Jarvis({"api_key": "PUT-YOUR-KEY-HERE", "notes_dir": "notes", "claude_command": str(exe)})
        try:
            status, info = j.get("/api/status")
            self.assertEqual(json.loads(info)["brain"], "cli")
            status, body = j.post("/chat", {"question": "Quando retiro o colar pelo NEXUS?", "session": "c1"})
            return status, body, [json.loads(l) for l in log.read_text().splitlines()], j.graph()
        finally:
            j.close()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_cli_backend(self):
        status, body, calls, g = self.run_with()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["answer"], "Pela CLI, senhor.")
        self.assertEqual(body["nodes"], [index_of(g, "NEXUS")])
        args = calls[0]
        for flag in ("-p", "--output-format", "--system-prompt", "--json-schema", "--tools", "--no-session-persistence"):
            self.assertIn(flag, args)

    def test_old_cli_drops_only_the_unknown_flags(self):
        status, body, calls, g = self.run_with(unknown=["--effort", "--json-schema"])
        self.assertEqual(status, 200, body)
        self.assertEqual(body["answer"], "CLI antiga, senhor.")
        last = calls[-1]
        self.assertNotIn("--effort", last)
        self.assertNotIn("--json-schema", last)
        for lock in ("--tools", "--strict-mcp-config", "--system-prompt"):  # as travas ficam
            self.assertIn(lock, last)
        self.assertEqual(last[last.index("--tools") + 1], "")

    def test_cli_research_and_model_swap(self):
        tmp = Path(tempfile.mkdtemp(prefix="fake-claude-"))
        log = tmp / "args.log"
        exe = tmp / "claude"
        exe.write_text(FAKE_CLAUDE.format(python=sys.executable, log=str(log), unknown=[]), encoding="utf-8")
        exe.chmod(0o755)
        j = Jarvis({"api_key": "PUT-YOUR-KEY-HERE", "notes_dir": "notes", "claude_command": str(exe)})
        try:
            status, body = j.post("/research", {"query": "CRASH-2 tranexâmico", "session": "c2"})
            self.assertEqual(status, 200, body)
            self.assertEqual(body["answer"], "Pela web, senhor.")
            self.assertEqual(body["sources"], [{"title": "CRASH-2", "url": "https://example.org/crash2"}])
            args = json.loads(log.read_text().splitlines()[-1])
            self.assertEqual(args[args.index("--tools") + 1], "WebSearch")   # só a busca, nada local
            self.assertIn("--strict-mcp-config", args)
            status, body = j.post("/settings", {"model": "sonnet"})
            self.assertEqual(status, 200, body)
            cfg = json.loads((j.dir / "config.json").read_text(encoding="utf-8"))
            self.assertEqual(cfg.get("cli_model"), "sonnet")                 # no claude -p vai o apelido
            self.assertEqual(json.loads(j.get("/api/status")[1])["model"], "sonnet")
        finally:
            j.close()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_cli_without_lockdown_flag_is_refused(self):
        status, body, calls, g = self.run_with(unknown=["--tools"])
        self.assertEqual(status, 503)
        self.assertIn("claude update", body["error"])
        self.assertEqual(len(calls), 1)   # não tenta rodar sem a trava


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
