#!/usr/bin/env node
// Validates the test harness and the fake viewer runtime (mock-claude.js) against the platform
// contracts, using a tiny stub page instead of jarvis.html. Run: node test/mock-selftest.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const H = require("./harness.cjs");

const STUB = `<title>JARVIS</title>
<style>:root{color-scheme:dark}body{background:#02040a;color:#dde}</style>
<div id="galaxy" style="width:300px;height:200px"></div>
<p id="status">stub</p>
<script src="https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/dist/3d-force-graph.min.js"></script>
<script>
  window.__stub = { typeofClaude: typeof window.claude };
  try {
    const g = new ForceGraph3D(document.getElementById("galaxy")).graphData({ nodes: [{ id: 0, label: "A" }, { id: 1, label: "B" }], links: [{ source: 0, target: 1 }] });
    window.__jarvis = Object.freeze({ graph: g });
  } catch (e) { window.__stub.graphError = String(e); }
  try { fetch("https://evil.example/x").catch(() => {}); } catch (e) {}
  const img = new Image(); img.src = "https://evil.example/pixel.png";
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/nothing/1.0/nothing.min.js"></script>`;

const results = [];
const ok = (name, cond, detail) => results.push({ name, ok: !!cond, detail: cond ? "" : detail || "" });

(async () => {
  const dir = path.join(__dirname, "fixtures", "out");
  fs.mkdirSync(dir, { recursive: true });
  const stubFile = path.join(dir, "stub.html");
  fs.writeFileSync(stubFile, STUB);
  const browser = await H.launch();
  try {
    // ------------------------------------------------------------- full runtime ----
    const s = await H.open(browser, { file: stubFile, mock: { probes: ["stub"] } });
    await s.goto();
    await s.waitFor(() => window.__t && window.__t.info() && window.__t.info().nodes === 2, null, { timeout: 15000, desc: "stub graph" })
      .then(() => ok("ForceGraph3D from the local CDN copy is captured (__t.info)", true), e => ok("ForceGraph3D captured", false, e.message));
    const r = await s.page.evaluate(async () => {
      const out = {};
      const t = (k, v) => { out[k] = v; };
      const rej = p => p.then(v => ({ resolved: v }), e => ({ rejected: e }));
      // claude.use
      t("claudeFrozen", Object.isFrozen(window.claude));
      let v = "unset";
      const p = window.claude.use("db");
      p.then(x => { v = x; });
      await Promise.resolve();
      t("useAsync", v === "unset");
      t("useMemo", window.claude.use("db") === p);
      t("useUnknownNull", (await window.claude.use("nope")) === null);
      const sample = await window.claude.use("sample"), db = await window.claude.use("db"), user = await window.claude.use("user"),
        mcp = await window.claude.use("mcp"), perms = await window.claude.use("permissions");
      t("namespacesFrozen", [sample, db, user, mcp, perms].every(Object.isFrozen));
      t("assignIgnored", (() => { try { db.doc = null; } catch (e) { /* strict mode throws */ } return typeof db.doc === "function"; })());
      // sample streaming invariants
      const ups = [];
      const res = await sample("Olá, tudo bem?", { onText: u => ups.push(u), modelTier: "quick", cache: false });
      let prev = "", inv = ups.length > 1;
      for (const u of ups) { if (u.text !== prev + u.delta || !u.delta) inv = false; prev = u.text; }
      t("streamInvariants", inv && ups[0].text.trim().length > 0 && res.text === prev);
      t("tierApplied", res.modelTierApplied === "quick" && (await sample("x")).modelTierApplied === "default");
      t("resultShape", typeof res.truncated === "boolean");
      // validation
      const bad = [await rej(sample({ prompt: "x" })), await rej(sample([{ role: "assistant", content: "x" }])), await rej(sample([{ role: "user", content: "" }])),
        await rej(sample([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])), await rej(sample("x", { signal: new AbortController() })),
        await rej(sample("x", "opts")), await rej(sample("x", { modelTier: "turbo" })), await rej(sample("x", { cache: { gcTime: 0 } }))];
      t("invalidRequest", bad.every(b => b.rejected && b.rejected.code === "invalid_request"));
      let sync = false;
      try { sample(undefined).catch(() => {}); } catch (e) { sync = true; }
      t("neverSyncThrow", !sync);
      t("tooLarge", (await rej(sample("x".repeat(262145))))?.rejected?.code === "prompt_too_large");
      // abort
      const ctl = new AbortController();
      const ab = await rej(sample("Conte uma história longa, senhor.", { signal: ctl.signal, onText: () => ctl.abort() }));
      t("abortCancelled", ab.rejected && ab.rejected.code === "cancelled" && typeof ab.rejected.text === "string");
      const pre = new AbortController(); pre.abort();
      t("preAborted", (await rej(sample("x", { signal: pre.signal })))?.rejected?.code === "cancelled");
      // json
      const j = await sample.json('Responda só {"query": "..."}', { modelTier: "quick" });
      t("jsonQuery", j && j.query === "damage control laparotomy");
      window.__mockConfig.responder = c => (c.verb === "json" ? "Claro: {\"a\": 1} pronto." : undefined);
      t("jsonTolerant", (await sample.json("x")).a === 1);
      window.__mockConfig.responder = c => (c.verb === "json" ? "nada aqui" : undefined);
      const ij = await rej(sample.json("x"));
      t("invalidJson", ij.rejected && ij.rejected.code === "invalid_json" && ij.rejected.text === "nada aqui");
      window.__mockConfig.responder = null;
      t("limits", (await sample.limits()).maxPromptBytes === 262144);
      // error injection
      window.__mockConfig.sampleError = { code: "rate_limited", message: "slow" };
      const rl = await rej(sample("x"));
      t("errorInjected", rl.rejected && rl.rejected.code === "rate_limited" && !(rl.rejected instanceof Error));
      window.__mockConfig.sampleError = { code: "upstream_error", afterChunks: 2 };
      const ue = await rej(sample("Uma resposta comprida o bastante para vários pedaços de texto, senhor."));
      t("errorAfterChunks", ue.rejected && ue.rejected.code === "upstream_error" && ue.rejected.text && ue.rejected.text.length > 0);
      window.__mockConfig.sampleError = null;
      // findId heuristic on several instruction formats
      const F = window.__mockFindId;
      t("findId", F('<note id="n10" title="RABT" folder="escores">', "RABT") === "n10" && F("[n12] Shock Index (escores)", "Shock Index") === "n12" &&
        F("### n3 · Glasgow — escores", "Glasgow") === "n3" && F('{"id":"m2","title":"RABT"}', "RABT") === "m2" && F("RABT sem id", "RABT") === null &&
        F("Nota n7: RTS (pasta escores)", "RTS") === "n7");
      // db grammar
      const throwsType = f => { try { f(); return false; } catch (e) { return e instanceof TypeError; } };
      t("dbGrammar", throwsType(() => db.doc("a")) && throwsType(() => db.collection("a/b")) && throwsType(() => db.doc("a/../b/c")) &&
        throwsType(() => db.collection(user.id())) && !throwsType(() => db.doc("data/users/u_test123/settings")) &&
        !throwsType(() => db.doc("data/users/u_test123/profile").collection("memories")) && throwsType(() => db.doc("data/users/u_test123/profile").collection("a/b")));
      const prof = db.doc("data/users/u_test123/profile");
      const mem = prof.collection("memories");
      const snaps = [];
      let syncCall = true;
      const unsub = mem.onSnapshot(sn => snaps.push({ sync: syncCall, size: sn.size, ch: sn.docChanges().map(c => c.type + ":" + c.doc.id) }));
      syncCall = false;
      await new Promise(r => setTimeout(r, 60));
      const m1 = await mem.add({ text: "a", createdAt: "2026-10-06T10:00:00.000Z" });
      await new Promise(r => setTimeout(r, 40));
      await mem.doc(m1.id).update({ text: "b", nested: { x: 1 } });
      await mem.doc(m1.id).update({ nested: { y: 2 } });
      await new Promise(r => setTimeout(r, 40));
      const got = await mem.doc(m1.id).get();
      t("dbUpdateMerge", got.exists && got.data().text === "b" && got.data().nested.x === 1 && got.data().nested.y === 2 && Object.isFrozen(got.data()));
      await mem.doc(m1.id).delete();
      await mem.doc(m1.id).delete();
      await new Promise(r => setTimeout(r, 40));
      unsub();
      await mem.add({ text: "after unsubscribe" });
      await new Promise(r => setTimeout(r, 40));
      t("dbSnapshots", JSON.stringify(snaps.map(x => [x.sync, x.size, x.ch.map(c => c.split(":")[0])])) ===
        JSON.stringify([[false, 0, []], [false, 1, ["added"]], [false, 1, ["modified"]], [false, 1, ["modified"]], [false, 0, ["removed"]]]));
      t("dbUpdateMissing", (await rej(db.doc("x/y").update({ a: 1 })))?.rejected?.code === "invalid_argument");
      t("dbSetArray", (await rej(db.doc("x/y").set([1])))?.rejected?.code === "invalid_argument");
      t("dbOtherUser", (await rej(db.doc("data/users/u_other/profile").set({ a: 1 })))?.rejected?.code === "invalid_argument" &&
        (await db.doc("data/users/u_other/profile").get()).exists === false);
      await db.doc("data/users/u_test123/settings").set({ humor: 30, tier: "complex" });
      await db.collection("t").doc("b").set({ n: 2 }); await db.collection("t").doc("a").set({ n: 1 }); await db.collection("t").doc("c").set({ n: 3, k: "x" });
      const q = await db.collection("t").where("n", ">=", 2).orderBy("n", "desc").limit(1).get();
      t("dbQuery", q.size === 1 && q.docs[0].id === "c" && (await db.collection("t").get()).docs.map(d => d.id).join() === "a,b,c");
      t("dbBadLimit", (await rej(db.collection("t").limit(0).get()))?.rejected?.code === "invalid_argument");
      const exp = window.__dbExport();
      t("dbExport", exp["data/users/u_test123/settings"].humor === 30 && Object.keys(exp).some(k => k.startsWith("data/users/u_test123/profile/memories/")));
      // user
      t("user", (await user.id()) === "u_test123" && (await user.me()).id === "u_test123" && (await user.isOwner()) === true && (await user.can("data.write")) === true);
      // mcp
      const ev = await mcp.callTool("Google Calendar", "list_events", { startTime: "2026-10-06T00:00:00-03:00", endTime: "2026-10-07T00:00:00-03:00", timeZone: "America/Sao_Paulo", orderBy: "startTime", pageSize: 20 });
      const evs = ev.payload.events;
      t("calendar", ev.payload.accessRole && ev.payload.timeZone === "America/Sao_Paulo" && evs.length === 5 && evs[0].summary === "📚 R+ UNIFESP — Cirurgia Torácica" &&
        evs[0].start.dateTime === "2026-10-06T05:30:00-03:00" && evs[0].description.length > 6000 && evs[0].description.includes(window.__calendarSentinel) &&
        evs[4].start.date === "2026-10-06" && typeof ev.content[0].text === "string" && evs[0].htmlLink && evs[0].status === "confirmed");
      const sa = await mcp.callTool("PubMed", "search_articles", { query: "damage control laparotomy", max_results: 5, sort: "relevance" });
      const md = await mcp.callTool("PubMed", "get_article_metadata", { pmids: sa.payload.pmids });
      t("pubmed", sa.payload.pmids.length === 3 && sa.payload.total_count > 3 && sa.payload.has_more === true && md.payload.count === 3 &&
        md.payload.articles[0].identifiers.doi && !md.payload.articles[2].identifiers.doi && md.payload.articles[0].journal.iso_abbreviation &&
        md.payload.articles[0].publication_date.year === "2019");
      t("mcpNotInManifest", (await rej(mcp.callTool("PubMed", "find_related_articles", {})))?.rejected?.code === "not_in_manifest");
      t("mcpBadRequest", (await rej(mcp.callTool("PubMed", "search_articles", { when: new Date() })))?.rejected?.code === "bad_request");
      window.__mockConfig.mcpErrors = { "Google Calendar": { code: "server_not_connected", message: "x" }, "PubMed/search_articles": [{ code: "server_unavailable", retryable: true, retryAfterMs: 50 }, null] };
      const e1 = await rej(mcp.callTool("Google Calendar", "list_events", {}));
      const e2 = await rej(mcp.callTool("PubMed", "search_articles", { query: "x" }));
      const e3 = await rej(mcp.callTool("PubMed", "search_articles", { query: "x" }));
      t("mcpErrors", e1.rejected.code === "server_not_connected" && e1.rejected.server === "Google Calendar" && e2.rejected.code === "server_unavailable" &&
        e2.rejected.retryable === true && e2.rejected.retryAfterMs === 50);
      t("mcpErrorSequence", !!e3.resolved, JSON.stringify(e3));
      window.__mockConfig.mcpErrors = null;
      const ac = new AbortController();
      const pc = rej(mcp.callTool("PubMed", "search_articles", { query: "x" }, { signal: ac.signal }));
      ac.abort();
      t("mcpAbort", (await pc).rejected.code === "cancelled");
      t("permissions", (await perms.state("sample")) === "granted" && (await perms.request(["mcp:PubMed"]))["mcp:PubMed"] === "granted");
      // speech
      const evts = [];
      const u = new SpeechSynthesisUtterance("Bom dia, senhor. Vinte e seis notas.");
      u.onstart = () => evts.push("start"); u.onboundary = () => evts.push("b"); u.onend = () => evts.push("end");
      speechSynthesis.speak(u);
      const u2 = new SpeechSynthesisUtterance("segunda");
      u2.onend = () => evts.push("end2");
      speechSynthesis.speak(u2);
      const speakingNow = speechSynthesis.speaking;
      await new Promise(r => setTimeout(r, 2500));
      t("speechEvents", speakingNow && evts[0] === "start" && evts.includes("b") && evts.indexOf("end") < evts.indexOf("end2") && !speechSynthesis.speaking);
      const u3 = new SpeechSynthesisUtterance("uma fala que vai ser cortada no meio, senhor");
      let err3 = null;
      u3.onerror = e => { err3 = e.error; };
      speechSynthesis.speak(u3);
      await new Promise(r => setTimeout(r, 50));
      speechSynthesis.cancel();
      t("speechCancel", err3 === "interrupted" && !speechSynthesis.speaking && window.__spoken.length === 3 && speechSynthesis.getVoices().some(v => v.lang === "pt-BR"));
      // forbidden
      const a = alert("x"), c = confirm("x"), pr = prompt("x"), w = window.open("https://x.example");
      try { new webkitSpeechRecognition(); } catch (e) {}
      const gum = await rej(navigator.mediaDevices.getUserMedia({ audio: true }));
      t("forbidden", a === undefined && c === false && pr === null && w === null && !!gum.rejected &&
        ["alert", "confirm", "prompt", "window.open", "SpeechRecognition.new", "getUserMedia"].every(k => window.__forbidden.some(f => f.what === k)));
      // instrumentation
      const el = document.createElement("div"); el.textContent = "texto ⟦fon"; document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 30));
      t("bracketWatcher", window.__bracket.length === 1);
      el.remove();
      t("probe", !!window.__probesSeen.stub);
      t("cam", !!(window.__t.cam() && window.__t.cam().pos));
      t("calls", window.__calls.some(x => x.cap === "sample" && x.method === "sample" && x.opts && x.opts.modelTier === "quick") &&
        window.__calls.some(x => x.cap === "mcp" && x.tool === "list_events" && x.tEnd > x.t));
      t("csp", window.__csp.some(v => /evil\.example/.test(v.blockedURI) && /connect-src/.test(v.directive)) && window.__csp.some(v => /img-src/.test(v.directive)));
      t("stubSawClaudeAtFirstRun", window.__stub.typeofClaude === "object" && !window.__stub.graphError);
      return out;
    });
    for (const [k, v] of Object.entries(r)) ok("in-page: " + k, v === true, JSON.stringify(v));
    ok("cdnjs request answered locally and noted (allowed host, no local copy)", s.cdnMissing.some(u => /cdnjs\.cloudflare\.com/.test(u)), JSON.stringify(s.cdnMissing));
    const p2 = await s.context.newPage();
    await p2.goto("https://elsewhere.example/").catch(() => {});
    await p2.close();
    ok("requests to other hosts are aborted and recorded", s.blocked.some(u => /elsewhere\.example/.test(u)), JSON.stringify(s.blocked));
    ok("no page errors on the stub", s.errors.length === 0, s.errors.join(" | "));
    const cssErrs = s.consoleErrors.filter(e => !/evil\.example|nothing\.min\.js|404|Refused to connect|Refused to load|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(e));
    ok("no unexpected console errors on the stub", cssErrs.length === 0, cssErrs.join(" | "));
    const shot = await s.shot("selftest-stub");
    ok("screenshot written", shot && fs.existsSync(shot));
    await s.close();

    // ---------------------------------------------------------- degraded modes ----
    const n = await H.open(browser, { file: stubFile, mock: { noClaude: true } });
    await n.goto();
    ok("noClaude: window.claude is undefined at first run", (await n.evaluate(() => window.__stub.typeofClaude)) === "undefined");
    await n.close();
    const a = await H.open(browser, { file: stubFile, mock: { allNull: true } });
    await a.goto();
    ok("allNull: every use() resolves null", (await a.evaluate(async () => (await Promise.all(["sample", "db", "user", "mcp", "permissions"].map(x => window.claude.use(x)))).every(v => v === null))));
    await a.close();
    const d = await H.open(browser, { file: stubFile, mock: { dbState: { "data/users/u_test123/profile/memories/abc": { text: "x", title: "X" } }, caps: { mcp: false } } });
    await d.goto();
    ok("dbState import and caps:false", (await d.evaluate(async () => {
      const db = await window.claude.use("db");
      const sn = await db.doc("data/users/u_test123/profile").collection("memories").get();
      return sn.size === 1 && sn.docs[0].data().title === "X" && (await window.claude.use("mcp")) === null;
    })));
    await d.close();
    // CSP header present on the served page
    const c = await H.open(browser, { file: stubFile });
    const resp = await c.page.goto(H.URL_ROOT);
    ok("served with the platform-like CSP header", (resp.headers()["content-security-policy"] || "").includes("default-src 'none'"));
    ok("served inside the platform skeleton", (await c.page.content()).startsWith("<!DOCTYPE html><html><head><meta charset=\"utf8\">"));
    await c.close();
  } finally {
    await browser.close();
  }
  let fail = 0;
  for (const x of results) {
    if (!x.ok) fail++;
    console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  -> " + x.detail}`);
  }
  console.log(`\n${results.length - fail}/${results.length} self-checks passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SELFTEST CRASHED", e); process.exit(2); });
