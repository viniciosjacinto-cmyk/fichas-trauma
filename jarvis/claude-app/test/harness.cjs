// JARVIS test harness: serves jarvis.html inside the claude.ai platform skeleton with a CSP that
// approximates the platform, routes the jsdelivr CDN to local copies, blocks (and records) every
// other host, injects the fake viewer runtime (mock-claude.js) and collects page errors.
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const TEST_DIR = __dirname;
const APP_DIR = path.resolve(TEST_DIR, "..");
const SCRATCH = path.resolve(APP_DIR, "..");
const NM = process.env.JARVIS_CDN_DIR || path.join(SCRATCH, "cdn", "node_modules");
const SHOTS = path.join(TEST_DIR, "shots");
const DEFAULT_APP = path.join(APP_DIR, "jarvis.html");
const ORIGIN = "https://jarvis.test";
const URL_ROOT = ORIGIN + "/";

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob: https://jarvis.test",
  "connect-src https://jarvis.test https://cdn.jsdelivr.net",
  "worker-src blob:",
  "media-src data: blob:",
].join("; ");

const SKELETON_HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui;background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style></head><body>";
const SKELETON_TAIL = "</body></html>";

const LAUNCH_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

const LOCAL_PACKAGES = [
  { re: /^\/npm\/3d-force-graph@1\.80\.1\/(.*)$/, dir: path.join(NM, "3d-force-graph") },
  { re: /^\/npm\/three@0\.186\.1\/(.*)$/, dir: path.join(NM, "three") },
];
const ALLOWED_CDN_HOSTS = new Set(["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com"]);
const MIME = { ".js": "application/javascript", ".mjs": "application/javascript", ".cjs": "application/javascript", ".json": "application/json",
  ".css": "text/css", ".map": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };

// console noise that is not the app's fault (WebGL in software, Chromium internals)
const IGNORABLE_CONSOLE = [/GPU stall due to ReadPixels/i, /WebGL: INVALID_OPERATION/i, /Automatic fallback to software WebGL/i, /\bswiftshader\b/i];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wrap(fileContent) {
  return SKELETON_HEAD + fileContent + SKELETON_TAIL;
}

// object literal -> JS source, keeping functions (CSP has no 'unsafe-eval', so the
// config must arrive as source inside the init script, never through eval in the page)
function serialize(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function") {
    let src = v.toString().trim();
    if (!/^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(src)) src = (src.startsWith("async ") ? "async function " + src.slice(6) : "function " + src);
    return "(" + src + ")";
  }
  if (Array.isArray(v)) return "[" + v.map(serialize).join(",") + "]";
  if (v instanceof RegExp) return v.toString();
  return "{" + Object.keys(v).map(k => JSON.stringify(k) + ":" + serialize(v[k])).join(",") + "}";
}

// in-page instrumentation: ForceGraph3D capture, '⟦' watcher, probe strings, helpers
const INSTRUMENT = String.raw`(() => {
  if (window.__instrumented) return; window.__instrumented = true;
  window.__Gs = [];
  let Real = undefined, Wrapped = undefined;
  Object.defineProperty(window, "ForceGraph3D", { configurable: true, enumerable: true,
    get() { return Wrapped; },
    set(v) {
      Real = v;
      if (typeof v !== "function") { Wrapped = v; return; }
      const capture = g => { if (g && typeof g === "function" || g && typeof g === "object") { window.__G = g; window.__Gs.push(g); } return g; };
      Wrapped = new Proxy(v, {
        apply(t, self, args) { return capture(Reflect.apply(t, self, args)); },
        construct(t, args, nt) { return capture(Reflect.construct(t, args, nt === Wrapped ? t : nt)); },
      });
    } });
  window.__bracket = [];
  window.__probesSeen = {};
  const probes = (window.__mockConfig && window.__mockConfig.probes) || [];
  let scheduled = false;
  const check = () => {
    scheduled = false;
    const b = document.body; if (!b) return;
    let txt = "";
    try { txt = b.innerText || ""; } catch (e) { return; }
    const i = txt.indexOf("⟦");
    if (i >= 0 && window.__bracket.length < 50) window.__bracket.push({ t: performance.now(), snip: txt.slice(Math.max(0, i - 80), i + 40) });
    for (const p of probes) if (!window.__probesSeen[p] && txt.toLowerCase().includes(p.toLowerCase())) window.__probesSeen[p] = performance.now();
  };
  // synchronous check on every mutation batch (a partial marker may live for one frame only)
  new MutationObserver(() => check()).observe(document, { subtree: true, childList: true, characterData: true });
  const label = n => (n && (n.label != null ? n.label : n.name != null ? n.name : n.title != null ? n.title : "")) + "";
  const idOf = e => (e && typeof e === "object" ? e.id : e);
  window.__t = {
    graph() {
      const j = window.__jarvis;
      const g = j && j.graph && typeof j.graph.graphData === "function" ? j.graph : window.__G;
      return g && typeof g.graphData === "function" ? g : null;
    },
    data() { const g = this.graph(); try { return g ? g.graphData() : null; } catch (e) { return null; } },
    info() {
      const d = this.data(); if (!d) return null;
      // links name their ends by the graph's nodeId accessor (the page may pick any field, e.g. "key") until
      // 3d-force-graph's next update swaps them for node objects; resolve through the same accessor
      let acc = "id";
      try { const g = this.graph(); const a = g && g.nodeId(); if (a) acc = a; } catch (e) { /* default "id" */ }
      const keyOf = n => (typeof acc === "function" ? acc(n) : n[acc]);
      const byId = new Map(d.nodes.map(n => [keyOf(n), n]));
      const lab = e => label(typeof e === "object" ? e : byId.get(e));
      return { nodes: d.nodes.length, links: d.links.length, labels: d.nodes.map(label),
        pairs: d.links.map(l => [lab(l.source), lab(l.target)]) };
    },
    node(name) {
      const d = this.data(); if (!d) return null;
      const n = d.nodes.find(x => label(x) === name);
      return n ? { x: n.x || 0, y: n.y || 0, z: n.z || 0, id: n.id } : null;
    },
    cam() {
      const g = this.graph(); if (!g) return null;
      let p = null, t = null;
      try { const c = g.camera(); p = { x: c.position.x, y: c.position.y, z: c.position.z }; } catch (e) {}
      if (!p) try { const c = g.cameraPosition(); p = { x: c.x, y: c.y, z: c.z }; } catch (e) {}
      try { const ctl = g.controls(); if (ctl && ctl.target) t = { x: ctl.target.x, y: ctl.target.y, z: ctl.target.z }; } catch (e) {}
      return { pos: p, target: t };
    },
    screenOf(name) {
      const g = this.graph(), n = this.node(name);
      if (!g || !n) return null;
      try { return g.graph2ScreenCoords(n.x, n.y, n.z); } catch (e) { return null; }
    },
    clickNode(name) {
      const g = this.graph(), d = this.data();
      if (!g || !d) return "no-graph";
      const n = d.nodes.find(x => label(x) === name);
      if (!n) return "no-node";
      let h = null;
      try { h = g.onNodeClick(); } catch (e) {}
      if (typeof h !== "function") return "no-handler";
      h(n, new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      return "ok";
    },
    text() { return document.body ? document.body.innerText : ""; },
    localDate() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); },
  };
})();`;

async function launch() {
  return chromium.launch({ args: LAUNCH_ARGS });
}

/**
 * Open a fresh, isolated browser context on the app.
 * opts: {file, viewport, mock (mockConfig object), isMobile, hasTouch, deviceScaleFactor, reducedMotion, timezoneId, locale, userAgent}
 */
async function open(browser, opts = {}) {
  const file = opts.file || process.env.JARVIS_HTML || DEFAULT_APP;
  const html = wrap(fs.readFileSync(file, "utf8"));
  const ctxOpts = {
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: opts.deviceScaleFactor || 1,
    isMobile: !!opts.isMobile,
    hasTouch: !!opts.hasTouch,
    reducedMotion: opts.reducedMotion || "no-preference",
    timezoneId: opts.timezoneId || "America/Sao_Paulo",
    locale: opts.locale || "pt-BR",
  };
  if (opts.userAgent) ctxOpts.userAgent = opts.userAgent;
  const context = await browser.newContext(ctxOpts);
  const s = {
    context, page: null, file,
    errors: [], consoleErrors: [], consoleAll: [], blocked: [], cdnMissing: [], notes: [], popups: [],
  };
  const mock = Object.assign({ probes: [] }, opts.mock || {});
  await context.addInitScript({ content: "window.__mockConfig = " + serialize(mock) + ";" });
  await context.addInitScript({ path: path.join(TEST_DIR, "mock-claude.js") });
  await context.addInitScript({ content: INSTRUMENT });

  await context.route("**/*", async route => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch (e) { return route.abort("blockedbyclient"); }
    if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    if (u.origin === ORIGIN) {
      if (u.pathname === "/" || u.pathname === "/index.html") {
        return route.fulfill({ status: 200, body: html, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP } });
      }
      s.notes.push("same-origin request answered 204: " + u.pathname);
      return route.fulfill({ status: 204, body: "" });
    }
    if (u.hostname === "cdn.jsdelivr.net") {
      for (const p of LOCAL_PACKAGES) {
        const m = u.pathname.match(p.re);
        if (!m) continue;
        const f = path.join(p.dir, decodeURIComponent(m[1]));
        if (f.startsWith(p.dir) && fs.existsSync(f) && fs.statSync(f).isFile()) {
          return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: {
            "content-type": MIME[path.extname(f)] || "application/octet-stream", "access-control-allow-origin": "*" } });
        }
        s.cdnMissing.push(req.url());
        return route.fulfill({ status: 404, body: "not in local copy", headers: { "access-control-allow-origin": "*" } });
      }
    }
    if (ALLOWED_CDN_HOSTS.has(u.hostname)) {
      // allowed on the real platform, but this sandbox has no copy: answer 404 and note it
      s.cdnMissing.push(req.url());
      return route.fulfill({ status: 404, body: "no local copy", headers: { "access-control-allow-origin": "*" } });
    }
    if (u.hostname === "fonts.googleapis.com") {
      return route.fulfill({ status: 200, body: "/* fonts stubbed in tests */", headers: { "content-type": "text/css", "access-control-allow-origin": "*" } });
    }
    if (u.hostname === "fonts.gstatic.com") {
      s.notes.push("font request: " + req.url());
      return route.fulfill({ status: 404, body: "", headers: { "access-control-allow-origin": "*" } });
    }
    s.blocked.push(req.method() + " " + req.url());
    return route.abort("blockedbyclient");
  });

  const page = await context.newPage();
  s.page = page;
  page.setDefaultTimeout(20000);
  s.stepName = "load";
  s.errorSteps = [];
  page.on("pageerror", e => {
    s.errors.push(String(e && (e.stack || e.message) || e).split("\n").slice(0, 3).join(" | "));
    s.errorSteps.push(s.stepName);
  });
  page.on("console", m => {
    const text = m.text();
    s.consoleAll.push(m.type() + ": " + text);
    if (m.type() !== "error") return;
    if (IGNORABLE_CONSOLE.some(re => re.test(text))) return;
    s.consoleErrors.push(text);
  });
  page.on("crash", () => s.errors.push("PAGE CRASHED"));
  context.on("page", p => { if (p !== page) s.popups.push(p.url()); });

  Object.assign(s, helpers(s));
  return s;
}

function helpers(s) {
  const page = () => s.page;
  const H = {
    async goto() {
      await page().goto(URL_ROOT, { waitUntil: "domcontentloaded", timeout: 30000 });
    },
    async evaluate(fn, arg) { return page().evaluate(fn, arg); },
    async calls(filter) {
      const all = await page().evaluate(() => window.__calls || []);
      return filter ? all.filter(filter) : all;
    },
    async paidCalls() {
      return H.calls(c => (c.cap === "sample" && (c.method === "sample" || c.method === "json")) ||
        (c.cap === "mcp" && (c.method === "callTool" || c.method === "watchTool")) || (c.cap === "permissions" && c.method === "request"));
    },
    async sampleCalls(after = 0) { return H.calls(c => c.cap === "sample" && (c.method === "sample" || c.method === "json") && c.t >= after); },
    async toolCalls(tool, after = 0) { return H.calls(c => c.cap === "mcp" && c.method === "callTool" && (!tool || c.tool === tool) && c.t >= after); },
    async spoken(after = 0) { return (await page().evaluate(() => window.__spoken || [])).filter(x => x.t >= after); },
    async forbidden() { return page().evaluate(() => window.__forbidden || []); },
    async csp() { return page().evaluate(() => window.__csp || []); },
    async bracket() { return page().evaluate(() => window.__bracket || []); },
    async probes() { return page().evaluate(() => window.__probesSeen || {}); },
    async dbExport() { return page().evaluate(() => (window.__dbExport ? window.__dbExport() : {})); },
    async dbSubs() { return page().evaluate(() => window.__dbSubs || {}); },
    async now() { return page().evaluate(() => performance.now()); },
    async firstGesture() { return page().evaluate(() => window.__firstGestureAt); },
    async info() { return page().evaluate(() => window.__t && window.__t.info()); },
    async cam() { return page().evaluate(() => window.__t && window.__t.cam()); },
    async node(label) { return page().evaluate(l => window.__t && window.__t.node(l), label); },
    async text() { return page().evaluate(() => (document.body ? document.body.innerText : "")); },
    async voice() { return page().evaluate(() => ({ speaking: window.__voice.speaking, current: window.__voice.current, queued: window.__voice.queued })); },
    async waitFor(fn, arg, { timeout = 20000, interval = 100, desc = "condition" } = {}) {
      try {
        const h = await page().waitForFunction(fn, arg, { timeout, polling: interval });
        return h.jsonValue();
      } catch (e) {
        throw new Error(`timed out after ${timeout} ms waiting for ${desc}`);
      }
    },
    async waitNode(fnInNode, { timeout = 20000, interval = 150, desc = "condition" } = {}) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        last = await fnInNode();
        if (last) return last;
        await sleep(interval);
      }
      throw new Error(`timed out after ${timeout} ms waiting for ${desc}`);
    },
    async waitGalaxy(nodes = 26, timeout = 25000) {
      return H.waitFor(n => { const i = window.__t && window.__t.info(); return i && i.nodes >= n ? i : null; }, nodes,
        { timeout, desc: `galaxy with ${nodes} nodes` });
    },
    async waitText(re, { timeout = 20000, desc } = {}) {
      const src = re instanceof RegExp ? { s: re.source, f: re.flags } : { s: String(re).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), f: "" };
      return H.waitFor(r => { const t = document.body ? document.body.innerText : ""; const m = t.match(new RegExp(r.s, r.f)); return m ? m[0] : null; }, src,
        { timeout, desc: desc || `text ${re}` });
    },
    async waitStableCamera({ timeout = 15000, still = 900 } = {}) {
      // camera target unchanged for `still` ms (the drift rotates around a fixed target)
      const end = Date.now() + timeout;
      let prev = await H.cam(), since = Date.now();
      while (Date.now() < end) {
        await sleep(150);
        const c = await H.cam();
        const moved = !c || !prev || !c.target || !prev.target ? true : dist(c.target, prev.target) > 0.5 ||
          Math.abs(dist(c.pos, c.target) - dist(prev.pos, prev.target)) > 0.5;
        if (moved) since = Date.now();
        prev = c;
        if (Date.now() - since >= still) return c;
      }
      return prev;
    },
    // the button whose accessible name IS "Ativar JARVIS" (a looser /Ativar JARVIS/ also matched any control whose
    // label merely mentions it, and .first() then picked whichever came first in the DOM, e.g. a top-bar chip)
    async activateButton() { return page().getByRole("button", { name: /^\W*Ativar\s+JARVIS\W*$/i }).first(); },
    async textBox() {
      const byPh = page().getByPlaceholder(/Pergunte|dite/i);
      if (await byPh.count()) {
        for (let i = 0; i < await byPh.count(); i++) if (await byPh.nth(i).isVisible()) return byPh.nth(i);
        return byPh.first();
      }
      const tb = page().getByRole("textbox");
      for (let i = 0; i < await tb.count(); i++) if (await tb.nth(i).isVisible()) return tb.nth(i);
      return tb.first();
    },
    async activate() {
      s.stepName = "activate";
      const btn = await H.activateButton();
      await btn.waitFor({ state: "visible", timeout: 25000 });
      await btn.click();
      await H.waitNode(async () => { const tb = await H.textBox(); return (await tb.count()) && await tb.isVisible(); },
        { timeout: 15000, desc: "the text box after activation" });
    },
    async settle({ calendar = true, timeout = 20000 } = {}) {
      // after activation: calendar asked, every sample call settled, the voice quiet
      const end = Date.now() + timeout;
      if (calendar) {
        try { await H.waitNode(async () => (await H.toolCalls("list_events")).length > 0, { timeout: 8000, desc: "list_events" }); } catch (e) { /* app without calendar */ }
      }
      await sleep(300);
      while (Date.now() < end) {
        const pending = (await H.calls(c => (c.cap === "sample" || c.cap === "mcp") && (c.method === "sample" || c.method === "json" || c.method === "callTool") && c.tEnd === undefined)).length;
        const v = await H.voice();
        if (!pending && !v.speaking && !v.queued) break;
        await sleep(150);
      }
      await sleep(400);
    },
    async send(text) {
      s.stepName = "send " + JSON.stringify(text);
      const tb = await H.textBox();
      await tb.focus();
      await tb.fill(text);
      const t = await H.now();
      await tb.press("Enter");
      return t;
    },
    async waitSample(after, pred = () => true, { timeout = 20000, settled = true, desc = "a sample call" } = {}) {
      return H.waitNode(async () => {
        const cs = (await H.sampleCalls(after)).filter(pred);
        const c = cs.find(x => !settled || x.tEnd !== undefined);
        return c || null;
      }, { timeout, desc });
    },
    async shot(name) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const f = path.join(SHOTS, name.replace(/[^\w.-]+/g, "_") + ".png");
      try { await page().screenshot({ path: f }); } catch (e) { return null; }
      return f;
    },
    step(name) { s.stepName = name; },
    async close() { try { await s.context.close(); } catch (e) { /* already closed */ } },
  };
  return H;
}

function dist(a, b) {
  if (!a || !b) return NaN;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}
const norm = s => String(s).replace(/\s+/g, " ").trim();
const fold = s => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

module.exports = { launch, open, wrap, serialize, sleep, dist, norm, fold, CSP, SKELETON_HEAD, SKELETON_TAIL, ORIGIN, URL_ROOT,
  TEST_DIR, APP_DIR, SHOTS, DEFAULT_APP, NM, LAUNCH_ARGS };
