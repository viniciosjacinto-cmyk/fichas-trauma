#!/usr/bin/env node
// JARVIS end-to-end scenarios (Playwright + Chromium/SwiftShader) against jarvis.html served inside the
// claude.ai skeleton with a platform-like CSP and the fake viewer runtime (test/mock-claude.js).
//
//   node test/e2e.cjs                 all scenarios
//   node test/e2e.cjs c f k1          only these ids
//   node test/e2e.cjs --file x.html   another page (default: jarvis.html, or $JARVIS_HTML)
//   node test/e2e.cjs --jobs 2        run scenarios two at a time (each in its own context)
//
// Every scenario runs in fresh browser contexts, prints PASS/FAIL with the reasons and saves
// screenshots to test/shots/. Exit code 1 when anything fails.
"use strict";
const fs = require("fs");
const path = require("path");
const H = require("./harness.cjs");
const { sleep, dist, norm, fold } = H;

const argv = process.argv.slice(2);
const opts = { only: [], file: null, jobs: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") opts.file = path.resolve(argv[++i]);
  else if (argv[i] === "--jobs") opts.jobs = Math.max(1, +argv[++i] || 1);
  else opts.only.push(argv[i]);
}
const FILE = opts.file || process.env.JARVIS_HTML || H.DEFAULT_APP;

// ------------------------------------------------------------------ config ----
const PROBES = ["Pensando", "Não importe dados de pacientes"];
const FAST_VOICE = { voiceMs: t => (window.__longVoice ? 6000 : Math.min(1200, 120 + String(t).length * 3)), probes: PROBES };
const RABT_Q = "Jarvis, quais são os critérios do RABT?";
const RABT_BODY = "Fratura de pelve, suspeita ou confirmada";
const SAMPLE_LABELS = JSON.parse(fs.readFileSync(path.join(H.APP_DIR, "ref", "notes.json"), "utf8")).map(n => n.label);
const EVENT_RE = /Cirurgia Tor[aá]cica|Pancreatite|R\+ UNIFESP|Update CG/i;

class Checks {
  constructor() { this.fails = []; this.notes = []; }
  ok(cond, msg) { if (!cond) this.fails.push(msg); return !!cond; }
  note(m) { this.notes.push(m); }
}

async function open(browser, o = {}) {
  const s = await H.open(browser, Object.assign({ file: FILE }, o, { mock: Object.assign({}, FAST_VOICE, o.mock || {}) }));
  await s.goto();
  return s;
}

// checks every scenario makes on every session before closing it
async function finalChecks(s, c, { strictConsole = false, label = "" } = {}) {
  const tag = label ? `[${label}] ` : "";
  let forb = [], csp = [];
  try { forb = await s.forbidden(); csp = await s.csp(); } catch (e) { c.note(tag + "could not read the page state: " + e.message); }
  c.ok(s.errors.length === 0, `${tag}page errors (first during step ${s.errorSteps && s.errorSteps[0]}): ${s.errors.slice(0, 3).join(" || ")}`);
  if (strictConsole) c.ok(s.consoleErrors.length === 0, `${tag}console errors: ${s.consoleErrors.slice(0, 3).join(" || ")}`);
  else if (s.consoleErrors.length) c.note(`${tag}console errors (not fatal here): ${s.consoleErrors.slice(0, 2).join(" || ")}`);
  c.ok(forb.length === 0, `${tag}forbidden APIs used: ${forb.map(f => f.what).join(", ")}`);
  c.ok(s.blocked.length === 0, `${tag}requests to hosts the platform blocks: ${s.blocked.slice(0, 3).join(", ")}`);
  c.ok(csp.length === 0, `${tag}CSP violations: ${csp.slice(0, 3).map(v => v.directive + " " + v.blockedURI).join(", ")}`);
  c.ok(s.popups.length === 0, `${tag}popups opened: ${s.popups.join(", ")}`);
  if (s.cdnMissing.length) c.note(`${tag}CDN files without a local copy (allowed on the platform): ${s.cdnMissing.slice(0, 3).join(", ")}`);
}

async function clickables(page, re) {
  // visible buttons/links/chips whose text matches re -> locators (tagged with a test attribute)
  const n = await page.evaluate(src => {
    const r = new RegExp(src.s, src.f);
    let k = 0;
    document.querySelectorAll("[data-test-pick]").forEach(e => e.removeAttribute("data-test-pick"));
    for (const el of document.querySelectorAll("button, a, [role=button], [data-id], [data-node], .chip")) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      if (r.test((el.innerText || el.textContent || "").trim()) || r.test(el.getAttribute("aria-label") || "")) el.setAttribute("data-test-pick", String(k++));
    }
    return k;
  }, { s: re.source, f: re.flags });
  return Array.from({ length: n }, (_, i) => page.locator(`[data-test-pick="${i}"]`));
}

// the panel shows the note title: a heading with exactly that text, or a prominent leaf inside a panel-like container
async function headingVisible(page, title, timeout = 4000) {
  try {
    await page.waitForFunction(t => {
      // really visible: on screen, effective opacity (all ancestors) >= 0.5, and not covered at its centre
      const vis = el => {
        const b = el.getBoundingClientRect(), st = getComputedStyle(el);
        if (!(b.width > 0 && b.height > 0) || st.visibility === "hidden" || st.display === "none") return false;
        const cx = Math.min(Math.max(b.x + b.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(b.y + b.height / 2, 0), innerHeight - 1);
        if (b.right <= 0 || b.bottom <= 0 || b.left >= innerWidth || b.top >= innerHeight) return false;
        let op = 1;
        for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= +getComputedStyle(e).opacity;
        if (op < 0.5) return false;
        const top = document.elementFromPoint(cx, cy);
        return !!top && (el.contains(top) || top.contains(el));
      };
      const same = el => (el.innerText || el.textContent || "").trim() === t;
      for (const h of document.querySelectorAll("h1, h2, h3, h4, [role=heading]")) if (same(h) && vis(h)) return true;
      const panels = document.querySelectorAll("aside, dialog, [role=dialog], [role=complementary], [id*=panel], [class*=panel], [class*=sheet], [id*=sheet]");
      for (const p of panels) {
        if (!vis(p)) continue;
        for (const el of p.querySelectorAll("*")) {
          if (el.children.length || !same(el) || !vis(el)) continue;
          if (el.closest("button, a, [role=button], .chip, [data-id]")) continue;
          if (parseFloat(getComputedStyle(el).fontSize) >= 16) return true;
        }
      }
      return false;
    }, title, { timeout, polling: 150 });
    return true;
  } catch (e) { return false; }
}

// on screen, effective opacity >= 0.5 and receiving the tap at its centre (Playwright's "visible" ignores opacity/offscreen)
async function reallyVisible(loc) {
  return loc.evaluate(el => {
    const b = el.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0) || b.right <= 0 || b.bottom <= 0 || b.left >= innerWidth || b.top >= innerHeight) return "off screen";
    let op = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    if (op < 0.5) return "transparent (opacity " + op.toFixed(2) + ")";
    const top = document.elementFromPoint(Math.min(b.x + b.width / 2, innerWidth - 1), Math.min(b.y + b.height / 2, innerHeight - 1));
    return top && (el.contains(top) || top.contains(el)) ? true : "covered by " + (top ? (top.id ? "#" + top.id : top.tagName) : "nothing");
  }).catch(e => "unreadable: " + e.message);
}

function stripMarker(t) { return String(t || "").split("⟦")[0].trim(); }
function sentencesOf(t) { return stripMarker(t).split(/(?<=[.!?])\s+(?!\d)/).map(x => x.trim()).filter(Boolean); }
function countOcc(hay, needle) { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; }
const turnsOf = call => (Array.isArray(call.input) ? call.input : [{ role: "user", content: String(call.input) }]);
const flat = call => turnsOf(call).map(t => t.content).join("\n");

// every star on screen and not under the page's own UI (top-bar chips, card, answer list, dock): the galaxy a user
// actually sees. Polls, because the layout and the camera settle for a few seconds after boot or an import.
async function starsClear(s, { timeout = 10000 } = {}) {
  let last = null;
  const probe = () => s.evaluate(() => {
    const g = window.__t.graph(), d = window.__t.data();
    if (!g || !d) return { off: ["(no graph)"], covered: [] };
    const off = [], covered = [];
    for (const n of d.nodes) {
      const label = n.label != null ? n.label : n.name;
      let sc;
      try { sc = g.graph2ScreenCoords(n.x || 0, n.y || 0, n.z || 0); } catch (e) { continue; }
      if (!(sc.x >= 0 && sc.y >= 0 && sc.x <= innerWidth && sc.y <= innerHeight)) { off.push(`${label}@${Math.round(sc.x)},${Math.round(sc.y)}`); continue; }
      const el = document.elementFromPoint(sc.x, sc.y);
      if (!el || el.tagName !== "CANVAS") covered.push(`${label} under ${el ? (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "")) : "nothing"}`);
    }
    return { off, covered };
  }).catch(e => ({ off: ["(unreadable: " + e.message + ")"], covered: [] }));
  await s.waitNode(async () => { last = await probe(); return !last.off.length && !last.covered.length ? last : null; },
    { timeout, interval: 400, desc: "every star on screen" }).catch(() => {});
  return last || { off: ["(unreadable)"], covered: [] };
}
// the force layout has stopped moving (stars shift < 0.5 units between two looks 600 ms apart), or the timeout
async function waitLayoutSettled(s, timeout = 25000) {
  const snap = () => s.evaluate(() => { const d = window.__t.data(); return d ? d.nodes.map(n => [n.x || 0, n.y || 0, n.z || 0]) : []; }).catch(() => []);
  const end = Date.now() + timeout;
  let prev = await snap();
  while (Date.now() < end) {
    await sleep(600);
    const cur = await snap();
    if (cur.length && cur.length === prev.length && cur.every((p, i) => Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1], p[2] - prev[i][2]) < 0.5)) return true;
    prev = cur;
  }
  return false;
}
// how much of the free area (top bar -> the top of `below`) the projected stars fill, in the larger dimension
async function galaxyFill(s, belowSelectorOrNull, onlyLabels = null) {
  return s.evaluate(([sel, only]) => {
    const g = window.__t.graph(), d = window.__t.data();
    if (!g || !d) return 0;
    const bar = document.querySelector("[role=banner], header, #topbar");
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const below = sel ? document.querySelector(sel) : null;
    const bottom = below ? below.getBoundingClientRect().top : innerHeight;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const n of d.nodes) {
      if (only && !only.includes(n.label != null ? n.label : n.name)) continue;
      const sc = g.graph2ScreenCoords(n.x || 0, n.y || 0, n.z || 0);
      x0 = Math.min(x0, sc.x); x1 = Math.max(x1, sc.x); y0 = Math.min(y0, sc.y); y1 = Math.max(y1, sc.y);
    }
    return Math.max((x1 - x0) / (innerWidth - 32), (y1 - y0) / Math.max(1, bottom - top));
  }, [belowSelectorOrNull, onlyLabels]);
}

async function waitVoiceIdle(s, timeout = 15000) {
  try { await s.waitNode(async () => { const v = await s.voice(); return !v.speaking && !v.queued; }, { timeout, desc: "voice idle" }); } catch (e) { /* tolerated */ }
}

// ----------------------------------------------------------------- scenarios ----
const S = [];
const scenario = (id, title, fn, timeoutMs = 150000) => S.push({ id, title, fn, timeoutMs });

scenario("s", "static contract of jarvis.html", async (browser, c) => {
  const src = fs.readFileSync(FILE, "utf8");
  c.ok(/^\s*<title>JARVIS<\/title>/.test(src), "the file must start with <title>JARVIS</title>");
  c.ok(src.slice(0, 8192).includes("<title>JARVIS</title>"), "<title>JARVIS</title> not within the first 8 KB");
  c.ok(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(src.replace(/<script[\s\S]*?<\/script>/gi, "")), "body-content file must not carry doctype/html/head/body");
  c.ok(Buffer.byteLength(src) < 1024 * 1024, `file is ${Buffer.byteLength(src)} bytes (limit 1 MB)`);
  const srcs = [...src.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)].map(m => m[1]);
  for (const u of srcs) c.ok(/^https:\/\/(cdn\.jsdelivr\.net\/npm\/|cdnjs\.cloudflare\.com\/|unpkg\.com\/)/.test(u), "script from a host outside the allow-list: " + u);
  c.ok(/https:\/\/cdn\.jsdelivr\.net\/npm\/3d-force-graph@1\.80\.1\/dist\/3d-force-graph\.min\.js/.test(src), "3d-force-graph@1.80.1 UMD (dist/3d-force-graph.min.js) not referenced");
  const dyn = [...src.matchAll(/\.src\s*=\s*["'](https?:[^"']+)/g)].map(m => m[1]);
  for (const u of dyn) c.ok(/^https:\/\/(cdn\.jsdelivr\.net\/npm\/|cdnjs\.cloudflare\.com\/|unpkg\.com\/)/.test(u), "script injected from a host outside the allow-list: " + u);
  const links = [...src.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)/gi)].map(m => m[1]);
  for (const u of links) c.ok(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u), "stylesheet/link outside Google Fonts: " + u);
  c.ok(!/\bnew\s+(?:window\.)?(?:webkit)?SpeechRecognition\b/.test(src), "constructs SpeechRecognition (SPEC forbids it)");
  c.ok(!/getUserMedia\s*\(/.test(src), "calls getUserMedia");
  c.ok(!/(?<![\w.$])(?:window\.)?(?:alert|confirm|prompt)\s*\((?!\s*\))?/.test(src.replace(/^\s*\/\/.*$/gm, "").replace(/function\s+(alert|confirm|prompt)\b/g, "")), "calls alert/confirm/prompt");
  c.ok(!/\bwindow\.open\s*\(/.test(src), "calls window.open");
  c.ok(!/<iframe|<object\b|serviceWorker\.register/i.test(src), "uses iframe/object/service worker");
  const rootRules = [...src.matchAll(/(?:^|[}\s])((?:html|body|:root)(?:\s*,\s*(?:html|body|:root))*)\s*\{([^}]*)\}/g)];
  c.ok(!rootRules.some(m => /(?:^|;)\s*(?:min-)?height\s*:\s*100vh/.test(m[2])), "html/body height uses 100vh (SPEC: html,body{height:100%})");
  c.ok(rootRules.some(m => /height\s*:\s*100%/.test(m[2])), "no html,body{height:100%}");
  c.ok(/color-scheme\s*:\s*dark/.test(src), "no color-scheme: dark token block");
  c.ok(/prefers-reduced-motion/.test(src), "no prefers-reduced-motion handling");
  c.ok(/safe-area-inset-bottom/.test(src) && /safe-area-inset-top/.test(src), "safe-area insets not used for the bars");
  c.ok(/visualViewport/.test(src), "visualViewport not used to keep the dock above the iPad keyboard");
  c.ok(/importmap/.test(src) && /three@0\.186\.1/.test(src), "three@0.186.1 importmap for the bloom module not found");
  c.ok(/localStorage/.test(src) ? /try\s*\{[^}]*localStorage/.test(src) : true, "localStorage used outside try/catch");
  c.ok(/__jarvis/.test(src), "window.__jarvis test hook not found");
}, 20000);

scenario("a", "boot at 4 sizes: galaxy 26/71, Ativar visible, no overflow, nothing paid before a tap", async (browser, c) => {
  const sizes = [[1440, 900, false, false], [1180, 820, false, true], [820, 1180, false, true], [390, 844, true, true]];
  for (const [w, h, mobile, touch] of sizes) {
    const tag = `${w}x${h}`;
    const s = await open(browser, { viewport: { width: w, height: h }, isMobile: mobile, hasTouch: touch, deviceScaleFactor: mobile ? 3 : 1 });
    try {
      let info = null;
      try { info = await s.waitGalaxy(26, 30000); } catch (e) { c.ok(false, `${tag}: ${e.message}`); }
      if (info) {
        c.ok(info.nodes === 26, `${tag}: galaxy has ${info.nodes} nodes, want 26`);
        c.ok(info.links === 71, `${tag}: galaxy has ${info.links} links, want 71`);
      }
      const btn = await s.activateButton();
      let vis = false;
      try { await btn.waitFor({ state: "visible", timeout: 15000 }); vis = true; } catch (e) { /* reported below */ }
      c.ok(vis, `${tag}: "Ativar JARVIS" not visible`);
      if (vis) {
        const rv = await s.waitNode(async () => ((await reallyVisible(btn)) === true ? true : null), { timeout: 5000, desc: "Ativar really visible" }).catch(async () => reallyVisible(btn));
        c.ok(rv === true, `${tag}: "Ativar JARVIS" is not really visible: ${rv}`);
        const b = await btn.boundingBox();
        c.ok(b && b.height >= 44, `${tag}: Ativar button ${b && Math.round(b.height)}px tall (< 44)`);
        c.ok(b && b.x >= 15.5 && b.x + b.width <= w - 15.5, `${tag}: Ativar button outside the 16px gutter (${b && Math.round(b.x)}..${b && Math.round(b.x + b.width)})`);
        c.ok(b && b.y + b.height <= h, `${tag}: Ativar button below the fold`);
      }
      await sleep(1200);
      const lay = await s.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth, title: document.title,
        bodyBg: getComputedStyle(document.body).backgroundColor }));
      c.ok(lay.sw <= lay.iw, `${tag}: horizontal overflow (scrollWidth ${lay.sw} > innerWidth ${lay.iw})`);
      c.ok(lay.title === "JARVIS", `${tag}: document.title is ${JSON.stringify(lay.title)}`);
      c.ok(lay.bodyBg !== "rgb(250, 250, 250)", `${tag}: body background is still the skeleton's #fafafa (no explicit token background)`);
      const named = await s.page.getByRole("button", { name: /Ativar\s+JARVIS/i }).count();
      c.ok(named === 1, `${tag}: ${named} buttons answer to "Ativar JARVIS" (VoiceOver/Voice Control cannot tell which one activates)`);
      const humorTop = await s.evaluate(() => [...document.querySelectorAll("body *")].some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom <= 110 && getComputedStyle(el).visibility !== "hidden" && /humor\D{0,4}\d{1,3}\s*%/i.test(el.innerText || "");
      }));
      c.ok(humorTop, `${tag}: no humor % in the top bar (SPEC, Interface: "Topo: chip de modo, humor %, ...")`);
      await s.waitStableCamera();
      const sc0 = await starsClear(s);
      c.ok(!sc0.off.length, `${tag}: stars off screen at boot: ${sc0.off.slice(0, 4).join(", ")}`);
      c.ok(!sc0.covered.length, `${tag}: stars under the page UI at boot: ${sc0.covered.slice(0, 4).join(", ")}`);
      const paid = await s.paidCalls();
      c.ok(paid.length === 0, `${tag}: paid/consent calls before any tap: ${paid.map(p => p.cap + "." + p.method + (p.tool ? ":" + p.tool : "")).join(", ")}`);
      c.ok((await s.firstGesture()) === null, `${tag}: a gesture was recorded before the test tapped anything`);
      await s.shot(`a-boot-${tag}`);
      await finalChecks(s, c, { strictConsole: true, label: tag });
    } finally { await s.close(); }
  }
});

scenario("b", "activate: greeting with the real count, one list_events after the tap, briefing names an event", async (browser, c) => {
  const s = await open(browser);
  try {
    await s.waitGalaxy(26, 30000);
    await sleep(500);
    c.ok((await s.paidCalls()).length === 0, "paid/consent call before the tap");
    await s.activate();
    await s.waitNode(async () => (await s.toolCalls("list_events")).length > 0, { timeout: 15000, desc: "Google Calendar list_events" }).catch(e => c.ok(false, e.message));
    const greet = await s.waitNode(async () => (await s.spoken()).find(x => /\b26\b/.test(x.text)), { timeout: 15000, desc: "a spoken greeting with 26" }).catch(e => (c.ok(false, e.message), null));
    const brief = await s.waitNode(async () => (await s.spoken()).find(x => EVENT_RE.test(x.text)), { timeout: 30000, desc: "a spoken briefing naming an event" }).catch(e => (c.ok(false, e.message), null));
    await sleep(2500);
    const scb = await starsClear(s);
    c.ok(!scb.off.length, `after activation, stars off screen: ${scb.off.slice(0, 4).join(", ")}`);
    c.ok(!scb.covered.length, `after activation, stars under the answer list/dock: ${scb.covered.slice(0, 4).join(", ")}`);
    const lc = await s.toolCalls("list_events");
    const g0 = await s.firstGesture();
    c.ok(lc.length === 1, `list_events called ${lc.length} times (want exactly 1)`);
    if (lc[0]) {
      c.ok(g0 !== null && lc[0].t >= g0, "list_events was called before the user's tap");
      const inp = lc[0].input || {};
      const want = await s.evaluate(() => { const d = new Date(); d.setHours(0, 0, 0, 0); const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); return { a: d.getTime(), b: e.getTime() }; });
      c.ok(Date.parse(inp.startTime) === want.a, `startTime ${inp.startTime} is not today 00:00 local`);
      c.ok(Date.parse(inp.endTime) === want.b, `endTime ${inp.endTime} is not tomorrow 00:00 local`);
      c.ok(/([+-]\d\d:\d\d|Z)$/.test(String(inp.startTime)), `startTime ${inp.startTime} has no offset`);
      c.ok(inp.timeZone === "America/Sao_Paulo", `timeZone ${inp.timeZone} (want the device zone America/Sao_Paulo)`);
      c.ok(inp.orderBy === "startTime", `orderBy ${inp.orderBy} (want startTime)`);
      c.ok(inp.pageSize === 20, `pageSize ${inp.pageSize} (want 20)`);
    }
    const sc = await s.sampleCalls();
    const bcall = sc.find(x => /Cirurgia Tor[aá]cica|Pancreatite/.test(flat(x)));
    c.ok(!!bcall, "no sample call carried today's events (briefing)");
    if (bcall) c.ok(bcall.opts && bcall.opts.modelTier === "quick", `briefing modelTier ${bcall.opts && bcall.opts.modelTier} (want quick)`);
    const sentinel = await s.evaluate(() => window.__calendarSentinel);
    c.ok(!sc.some(x => flat(x).includes(sentinel)), "an event description reached Claude beyond 6000 characters");
    if (greet && brief) c.ok(greet.t <= brief.t, "the briefing was spoken before the greeting");
    const spoken = await s.spoken();
    c.ok(spoken.length > 0 && spoken[0].ua === true, "the first speechSynthesis.speak was not inside the user's gesture (audio unlock)");
    c.ok(!spoken.some(x => x.text.includes("⟦")), "a spoken text contains ⟦");
    c.ok(spoken.every(x => x.text.length <= 220), `a spoken piece is longer than 220 chars: ${(spoken.find(x => x.text.length > 220) || {}).text}`);
    await s.shot("b-activated");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("c", "ask about a note: note text in the turns, no ⟦ shown or spoken, sentence-by-sentence voice, fly to the source, chip opens the panel", async (browser, c) => {
  const s = await open(browser, { mock: { sampleChunkDelayMs: 90 } });
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    await s.waitStableCamera();
    const node0 = await s.node("RABT"), cam0 = await s.cam();
    c.ok(node0 && cam0 && cam0.pos, "cannot read the RABT node or the camera (window.__jarvis.graph / ForceGraph3D)");
    const d0 = node0 && cam0 && cam0.pos ? dist(cam0.pos, node0) : NaN;
    const tSend = await s.send(RABT_Q);
    const chat = await s.waitSample(tSend, x => Array.isArray(x.input) && /RABT/.test(x.input[x.input.length - 1].content), { timeout: 40000, desc: "the chat sample call" })
      .catch(e => (c.ok(false, e.message), null));
    await s.waitText(/Quatro crit[ée]rios/, { timeout: 20000 }).catch(e => c.ok(false, "answer not shown: " + e.message));
    if (chat) {
      const turns = chat.input;
      c.ok(turns[0].role === "user" && turns[0].content.includes(RABT_BODY), "the instructions turn does not carry the RABT note text");
      c.ok(/crit[ée]rios do RABT/.test(turns[turns.length - 1].content), "the last turn is not the question");
      c.ok(chat.opts && chat.opts.cache === false, `chat call cache=${JSON.stringify(chat.opts && chat.opts.cache)} (want false)`);
      c.ok(chat.opts && chat.opts.hasSignal, "chat call without an AbortSignal");
      c.ok(chat.opts && chat.opts.hasOnText, "chat call without onText (no streaming)");
      c.ok(chat.opts && chat.opts.modelTier === "quick", `default tier ${chat.opts && chat.opts.modelTier} (SPEC: quick)`);
      c.ok(chat.status === "resolved", "chat call ended with " + chat.status);
    }
    const miss = await s.evaluate(() => window.__idMiss);
    c.ok(!miss.length, `the mock found no note id next to ${miss.join(", ")} in the instructions (SPEC: notes with id, title and folder)`);
    await waitVoiceIdle(s, 20000);
    const bracket = await s.bracket();
    c.ok(bracket.length === 0, `the page showed ⟦ while streaming: ${JSON.stringify(bracket[0] && bracket[0].snip)}`);
    const txt = await s.text();
    c.ok(!/fontes:\s*n?\d/i.test(txt), "the source marker text is visible");
    const spoken = (await s.spoken(tSend)).filter(x => x.text.trim());
    c.ok(spoken.length > 0, "nothing was spoken for the answer");
    c.ok(!spoken.some(x => /⟦|⟧|fontes:/i.test(x.text)), "the marker was spoken: " + (spoken.find(x => /⟦|⟧|fontes:/i.test(x.text)) || {}).text);
    c.ok(spoken.every(x => x.text.length <= 220), "a spoken piece is longer than 220 chars (iOS cuts it)");
    if (chat && chat.text) {
      const joined = norm(spoken.map(x => x.text).join(" "));
      const sents = sentencesOf(chat.text);
      for (const st of sents) {
        const head = norm(st).slice(0, 40);
        const n = countOcc(joined, head);
        c.ok(n === 1, `sentence spoken ${n} times (want 1): ${head}…`);
      }
      c.ok(joined.length <= norm(stripMarker(chat.text)).length + 40, "more was spoken than the answer");
      const first = spoken.find(x => x.text.includes(norm(sents[0]).slice(0, 20)));
      c.ok(first && first.t < chat.tEnd, "the first sentence was not spoken before the stream finished (SPEC: speak sentence by sentence)");
    }
    const probes = await s.probes();
    c.ok(!!probes.Pensando, 'no "Pensando…" shown while waiting for the first text');
    if (node0 && cam0 && cam0.pos) {
      // flyTo = cameraPosition(pos, lookAt: node): the orbit target lands on the node and the camera closes in
      let last = null;
      const moved = await s.waitNode(async () => {
        const n = await s.node("RABT"), cm = await s.cam();
        if (!n || !cm || !cm.pos) return null;
        const d1 = dist(cm.pos, n), tn = cm.target ? dist(cm.target, n) : null;
        last = { d1: Math.round(d1), targetToNode: tn === null ? null : Math.round(tn) };
        const t0n = cam0.target ? dist(cam0.target, node0) : null;
        const onTarget = tn === null ? true : tn < Math.max(20, 0.15 * d0) && (t0n === null || tn < 0.5 * t0n);
        return onTarget && d1 < 0.8 * d0 ? last : null;
      }, { timeout: 9000, desc: "camera flight to RABT" }).catch(() => null);
      c.ok(!!moved, `camera did not fly to the RABT node (before: distance ${Math.round(d0)}, target ${cam0.target ? Math.round(dist(cam0.target, node0)) : "?"} from the node; last: ${JSON.stringify(last)})`);
      if (moved) c.note(`flight: camera-node distance ${Math.round(d0)} -> ${moved.d1}, target-node ${moved.targetToNode}`);
    }
    await s.shot("c-answer");
    // chip -> panel
    await s.page.keyboard.press("Escape");
    await sleep(500);
    if (await headingVisible(s.page, "RABT", 500)) {
      const close = await clickables(s.page, /^(×|✕|fechar|close)$/i);
      if (close.length) { await close[0].click().catch(() => {}); await sleep(500); }
    }
    const panelWasOpen = await headingVisible(s.page, "RABT", 300);
    if (panelWasOpen) c.note("the panel could not be closed before clicking the chip; the chip check is weaker");
    const chips = (await clickables(s.page, /^\W*RABT\b/));
    c.ok(chips.length > 0, "no clickable source chip labelled RABT");
    if (chips.length) {
      await userClick(c, chips[chips.length - 1], "the RABT source chip");
      c.ok(await headingVisible(s.page, "RABT", 6000), "clicking the source chip did not open the panel titled RABT");
      await s.shot("c-panel");
    }
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("d", "smalltalk with ⟦fontes: —⟧ leaves the camera alone", async (browser, c) => {
  const s = await open(browser, { reducedMotion: "reduce" });
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    const cam0 = await s.waitStableCamera();
    const tSend = await s.send("Jarvis, tudo bem com você?");
    await s.waitSample(tSend, x => Array.isArray(x.input), { timeout: 30000, desc: "the chat call" }).catch(e => c.ok(false, e.message));
    await s.waitText(/mordomo nunca descansa/, { timeout: 15000 }).catch(e => c.ok(false, "smalltalk answer not shown: " + e.message));
    await sleep(2500);
    const cam1 = await s.cam();
    if (cam0 && cam1 && cam0.pos && cam1.pos) {
      const r0 = cam0.target ? dist(cam0.pos, cam0.target) : Math.hypot(cam0.pos.x, cam0.pos.y, cam0.pos.z);
      if (cam0.target && cam1.target) {
        c.ok(dist(cam0.target, cam1.target) < 0.05 * r0 + 1, `camera target moved by ${Math.round(dist(cam0.target, cam1.target))}`);
        c.ok(Math.abs(dist(cam1.pos, cam1.target) - r0) < 0.1 * r0 + 1, "camera zoomed after smalltalk");
      } else c.ok(dist(cam0.pos, cam1.pos) < 0.05 * r0 + 1, "camera moved after smalltalk");
    } else c.ok(false, "cannot read the camera");
    c.ok((await s.bracket()).length === 0, "⟦ shown on screen");
    const spoken = await s.spoken(tSend);
    c.ok(!spoken.some(x => /⟦|⟧|fontes/i.test(x.text)), "the marker was spoken");
    c.ok(spoken.some(x => /mordomo/.test(x.text)), "the smalltalk answer was not spoken");
    await s.shot("d-smalltalk");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("e", "remember: memory doc, live node, spoken confirmation, survives a reload", async (browser, c) => {
  let exported = null;
  const s = await open(browser);
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    const tSend = await s.send("Jarvis, lembre que o plantão de sábado é no PS");
    const memPath = await s.waitNode(async () => Object.keys(await s.dbExport()).find(p => /^data\/users\/u_test123\/profile\/memories\/[^/]+$/.test(p)),
      { timeout: 15000, desc: "a memory document under data/users/u_test123/profile/memories" }).catch(e => (c.ok(false, e.message), null));
    if (memPath) {
      const doc = (await s.dbExport())[memPath];
      c.ok(typeof doc.text === "string" && /plant[aã]o de s[aá]bado [ée] no PS/i.test(doc.text), "memory text: " + JSON.stringify(doc.text));
      c.ok(!/^\s*(jarvis|lembr)/i.test(doc.text || ""), "memory text still carries the command: " + JSON.stringify(doc.text));
      c.ok(typeof doc.title === "string" && doc.title.trim().length > 0, "memory without a title");
      c.ok(!isNaN(Date.parse(doc.createdAt)) && /^\d{4}-\d\d-\d\dT/.test(doc.createdAt || ""), "createdAt is not ISO: " + doc.createdAt);
      c.ok(doc.anchor === null || typeof doc.anchor === "string" || typeof doc.anchor === "number", "anchor: " + JSON.stringify(doc.anchor));
    }
    const info = await s.waitGalaxy(27, 15000).catch(e => (c.ok(false, "no new node: " + e.message), null));
    if (info) c.ok(info.labels.some(l => !SAMPLE_LABELS.includes(l)), "no new node label in the galaxy");
    const conf = await s.waitNode(async () => (await s.spoken(tSend)).find(x => x.text.trim().length > 3), { timeout: 15000, desc: "a spoken confirmation" }).catch(e => (c.ok(false, e.message), null));
    if (conf) c.ok(!/⟦/.test(conf.text), "confirmation spoken with ⟦");
    const after = await s.sampleCalls(tSend);
    c.ok(after.every(x => x.opts && x.opts.modelTier === "quick"), "remember used a non-quick sample call: " + after.map(x => x.opts && x.opts.modelTier).join(","));
    const subs = await s.dbSubs();
    for (const [p, v] of Object.entries(subs)) c.ok(v.total <= 2 && v.active <= 1, `onSnapshot on ${p} subscribed ${v.total} times (${v.active} active): SPEC says once per collection`);
    exported = await s.dbExport();
    await s.shot("e-memory");
    await finalChecks(s, c, { label: "first visit" });
  } finally { await s.close(); }
  if (!exported) return;
  const r = await open(browser, { mock: { dbState: exported } });
  try {
    const info = await r.waitGalaxy(27, 30000).catch(e => (c.ok(false, "after reload: " + e.message), null));
    if (info) c.ok(info.labels.some(l => !SAMPLE_LABELS.includes(l)), "after reload the memory node is missing");
    // every "N notas · M memórias" on screen (top bar and the activation card) must say the same thing
    const countsOnScreen = () => r.evaluate(() => [...document.body.innerText.matchAll(/(\d+)\s+notas?\s*·\s*(\d+)\s+mem[oó]rias?/g)].map(m => m[1] + "/" + m[2]));
    const agree = await r.waitNode(async () => { const cs = await countsOnScreen(); return cs.length >= 2 && new Set(cs).size === 1 && cs[0] === "26/1" ? cs : null; },
      { timeout: 10000, desc: "counts" }).catch(() => null);
    c.ok(!!agree, `after reload, the counts on screen disagree or are stale: ${JSON.stringify(await countsOnScreen())} (want 26 notas · 1 memória everywhere)`);
    await r.waitStableCamera();
    const scr = await starsClear(r, { timeout: 15000 });
    c.ok(!scr.off.length, `after reload, stars off screen: ${scr.off.slice(0, 4).join(", ")}`);
    c.ok(!scr.covered.length, `after reload, stars under the page UI: ${scr.covered.slice(0, 4).join(", ")}`);
    // the settled frame, not the boot fly-in (the camera starts far and zooms in during the first seconds)
    const fill = await r.waitNode(async () => { const f = await galaxyFill(r, "#card"); return f >= 0.45 ? f : null; }, { timeout: 12000, desc: "galaxy fill" })
      .catch(() => galaxyFill(r, "#card"));
    c.ok(fill >= 0.45, `after reload the galaxy fills only ${Math.round(fill * 100)}% of the free area (a loose memory shrank the frame)`);
    await r.shot("e-reloaded");
    await finalChecks(r, c, { label: "reload" });
  } finally { await r.close(); }
  // a returning user whose own notes and memories have no link to anything (imported notes without wikilinks or
  // title mentions, a memory without an anchor): every star stays on the first screen and the galaxy keeps its size
  const loose = Object.assign({}, exported);
  const now = new Date().toISOString();
  ["Escala de dezembro", "Kit de sutura", "Ramal da UTI"].forEach((t, i) => {
    loose["data/users/u_test123/profile/notes/nloose" + i] = { label: t, group: "minhas notas", text: "# " + t + "\n\nTexto curto " + i + " qwz.", importedAt: now };
  });
  loose["data/users/u_test123/profile/memories/mloose"] = { text: "o carro está na vaga 12", title: "O carro está na vaga 12", createdAt: now, anchor: null };
  const u = await open(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true, mock: { dbState: loose } });
  try {
    await u.waitGalaxy(31, 30000).catch(e => c.ok(false, "returning user with loose stars: " + e.message));
    await waitLayoutSettled(u);
    const scu = await starsClear(u, { timeout: 15000 });
    c.ok(!scu.off.length, `returning user: loose stars off screen: ${scu.off.slice(0, 4).join(", ")}`);
    c.ok(!scu.covered.length, `returning user: stars under the page UI: ${scu.covered.slice(0, 4).join(", ")}`);
    // measured on the 26 sample stars: far-flung loose stars would inflate an all-star box while the body shrinks
    const fu = await u.waitNode(async () => { const f = await galaxyFill(u, "#card", SAMPLE_LABELS); return f >= 0.45 ? f : null; }, { timeout: 12000, desc: "galaxy fill" })
      .catch(() => galaxyFill(u, "#card", SAMPLE_LABELS));
    c.ok(fu >= 0.45, `returning user: the main cluster fills only ${Math.round(fu * 100)}% of the free area (loose stars shrank the frame)`);
    await u.shot("e-returning-loose");
    await finalChecks(u, c, { label: "returning user, loose stars" });
  } finally { await u.close(); }
});

scenario("f", "research: sample.json query, PubMed search then metadata, 'Segundo o PubMed', DOI links, camera still", async (browser, c) => {
  const s = await open(browser, { reducedMotion: "reduce" });
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    const cam0 = await s.waitStableCamera();
    const tSend = await s.send("pesquisa no pubmed laparotomia de controle de danos");
    await s.waitNode(async () => (await s.evaluate(() => document.querySelectorAll('a[href^="https://doi.org/"]').length)) > 0,
      { timeout: 40000, desc: "DOI links on screen" }).catch(e => c.ok(false, e.message));
    await s.waitText(/Segundo o PubMed/, { timeout: 15000 }).catch(e => c.ok(false, "answer without 'Segundo o PubMed': " + e.message));
    const sc = await s.sampleCalls(tSend);
    const js = sc.find(x => x.method === "json");
    c.ok(!!js, "no sample.json call to build the PubMed query");
    if (js) {
      c.ok(js.opts && js.opts.modelTier === "quick", `query translation tier ${js.opts && js.opts.modelTier} (want quick)`);
      c.ok(/laparotomia de controle de danos/i.test(flat(js)), "the query prompt does not carry the question");
    }
    const search = (await s.toolCalls("search_articles", tSend))[0];
    const meta = (await s.toolCalls("get_article_metadata", tSend))[0];
    c.ok(!!search, "PubMed search_articles not called");
    c.ok(!!meta, "PubMed get_article_metadata not called");
    if (search) {
      c.ok(search.server === "PubMed", "search server " + search.server);
      c.ok(search.input && search.input.query === "damage control laparotomy", `search query ${JSON.stringify(search.input && search.input.query)} (want the sample.json query)`);
      c.ok(search.input && search.input.max_results === 5, "max_results " + (search.input && search.input.max_results));
      c.ok(search.input && search.input.sort === "relevance", "sort " + (search.input && search.input.sort));
      if (js) c.ok(js.tEnd <= search.t, "search ran before the query translation finished");
    }
    if (search && meta) {
      c.ok(meta.t >= search.tEnd, "metadata requested before the search answered");
      c.ok(JSON.stringify((meta.input && meta.input.pmids || []).map(String)) === JSON.stringify(search.payload.pmids), "metadata pmids differ from the search result: " + JSON.stringify(meta.input));
      const ans = sc.find(x => x.method === "sample" && x.t >= meta.tEnd);
      c.ok(!!ans, "no answer call after the metadata");
      if (ans) {
        const ft = flat(ans);
        c.ok(ft.includes("Damage control laparotomy in severely injured patients"), "the answer prompt lacks the article titles");
        c.ok(!ft.includes("SENTINELA-ABSTRACT-1200"), "abstract not cut at 1200 characters");
      }
    }
    const anchors = await s.evaluate(() => [...document.querySelectorAll("a[href]")].map(a => ({ href: a.href, target: a.target, rel: a.rel, text: a.innerText })));
    const arts = await s.evaluate(() => window.__pubmed.ARTICLES);
    for (const a of Object.values(arts)) {
      const want = a.identifiers.doi ? "https://doi.org/" + a.identifiers.doi : `https://pubmed.ncbi.nlm.nih.gov/${a.identifiers.pmid}/`;
      const el = anchors.find(x => { try { return decodeURIComponent(x.href) === want; } catch (e) { return x.href === want; } });
      c.ok(!!el, "missing link " + want);
      if (el) {
        c.ok(el.target === "_blank", `link ${want} target=${el.target}`);
        c.ok(/noopener/.test(el.rel), `link ${want} rel=${el.rel}`);
      }
    }
    const txt = await s.text();
    c.ok(/2019/.test(txt) && /J Trauma Acute Care Surg|journal of trauma/i.test(txt), "article year/journal not shown with the links");
    const cam1 = await s.cam();
    if (cam0 && cam1 && cam0.pos && cam1.pos) {
      const r0 = cam0.target ? dist(cam0.pos, cam0.target) : Math.hypot(cam0.pos.x, cam0.pos.y, cam0.pos.z);
      c.ok(dist(cam0.pos, cam1.pos) < 0.05 * r0 + 1, `the camera moved during research (${Math.round(dist(cam0.pos, cam1.pos))})`);
    }
    c.ok((await s.bracket()).length === 0, "⟦ shown on screen");
    await s.shot("f-research");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("g", "tier + humor: quick by default, 'modo máximo' -> complex, 'humor em 30' reaches the instructions, settings doc", async (browser, c) => {
  const s = await open(browser);
  const humorNear = (txt, n) => new RegExp(`(humor|wit|graça|piada|ironia|espirituos|dial)[^\\n]{0,60}\\b${n}\\b|\\b${n}\\b[^\\n]{0,40}(humor|wit|de 100|of 100)`, "i").test(txt);
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    let t = await s.send("como calcula o shock index?");
    const q1 = await s.waitSample(t, x => Array.isArray(x.input), { timeout: 30000, desc: "first chat call" }).catch(e => (c.ok(false, e.message), null));
    if (q1) {
      c.ok(q1.opts.modelTier === "quick", `default tier ${q1.opts.modelTier} (want quick)`);
      c.ok(humorNear(q1.input[0].content, 70), "the instructions do not carry the default humor 70");
    }
    await waitVoiceIdle(s);
    c.ok(/R[áa]pido/.test(await s.text()), "the mode chip does not show Rápido before the change");
    t = await s.send("modo máximo");
    await s.waitText(/M[áa]ximo/, { timeout: 8000 }).catch(e => c.ok(false, "mode chip does not show Máximo: " + e.message));
    await sleep(800);
    c.ok((await s.sampleCalls(t)).filter(x => Array.isArray(x.input) && /modo m[áa]ximo/i.test(x.input[x.input.length - 1].content)).length === 0, "'modo máximo' was sent to Claude as a question");
    await waitVoiceIdle(s);
    t = await s.send("quais são os critérios do RABT?");
    const q2 = await s.waitSample(t, x => Array.isArray(x.input), { timeout: 30000, desc: "chat call after modo máximo" }).catch(e => (c.ok(false, e.message), null));
    if (q2) c.ok(q2.opts.modelTier === "complex", `tier after 'modo máximo': ${q2.opts.modelTier}`);
    await waitVoiceIdle(s);
    t = await s.send("humor em 30");
    await s.waitNode(async () => { const d = (await s.dbExport())["data/users/u_test123/settings"]; return d && d.humor === 30; },
      { timeout: 10000, desc: "settings doc with humor 30" }).catch(e => c.ok(false, e.message));
    await waitVoiceIdle(s);
    t = await s.send("o que é o RTS?");
    const q3 = await s.waitSample(t, x => Array.isArray(x.input), { timeout: 30000, desc: "chat call after humor em 30" }).catch(e => (c.ok(false, e.message), null));
    if (q3) {
      c.ok(humorNear(q3.input[0].content, 30), "the instructions turn does not mention humor 30");
      c.ok(q3.opts.modelTier === "complex", "tier was lost after the humor change: " + q3.opts.modelTier);
    }
    const st = (await s.dbExport())["data/users/u_test123/settings"];
    c.ok(st && st.humor === 30, "settings.humor " + JSON.stringify(st && st.humor));
    c.ok(st && st.tier === "complex", "settings.tier " + JSON.stringify(st && st.tier));
    await s.shot("g-tier-humor");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("h", "journal: asks are logged in the day doc and reach Claude for 'o que eu fiz hoje?'", async (browser, c) => {
  const s = await open(browser);
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    for (const q of [RABT_Q, "como calcula o shock index?"]) {
      const t = await s.send(q);
      await s.waitSample(t, x => Array.isArray(x.input), { timeout: 30000, desc: "chat call for " + q }).catch(e => c.ok(false, e.message));
      await waitVoiceIdle(s);
      await sleep(400);
    }
    const day = await s.evaluate(() => window.__t.localDate());
    const dayPath = `data/users/u_test123/profile/days/${day}`;
    await s.waitNode(async () => { const d = (await s.dbExport())[dayPath]; return d && Array.isArray(d.events) && d.events.length >= 2; },
      { timeout: 10000, desc: dayPath + " with 2 events" }).catch(e => c.ok(false, e.message));
    const doc = (await s.dbExport())[dayPath];
    if (doc) {
      c.ok(doc.date === day, "day doc date " + doc.date);
      const asks = (doc.events || []).filter(e => e.kind === "ask");
      c.ok(asks.some(e => /RABT/i.test(e.q)) && asks.some(e => /shock index/i.test(e.q)), "ask events do not carry both questions: " + JSON.stringify(asks.map(e => e.q)));
      c.ok((doc.events || []).every(e => typeof e.a !== "string" || e.a.length <= 300), "an event answer is longer than 300 chars");
      c.ok((doc.events || []).every(e => !isNaN(Date.parse(e.t))), "an event without an ISO t");
    }
    const t = await s.send("o que eu fiz hoje?");
    const jc = await s.waitSample(t, () => true, { timeout: 30000, desc: "the journal sample call" }).catch(e => (c.ok(false, e.message), null));
    if (jc) {
      const ft = flat(jc);
      c.ok(/RABT/i.test(ft) && /shock index/i.test(ft), "the journal events did not reach the sample input");
    }
    await s.shot("h-journal");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("i", "hush: 'para' while speaking cancels the voice and asks nothing", async (browser, c) => {
  const s = await open(browser);
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    await s.evaluate(() => { window.__longVoice = true; });
    const tq = await s.send(RABT_Q);
    await s.waitSample(tq, x => Array.isArray(x.input), { timeout: 30000, desc: "chat call" }).catch(e => c.ok(false, e.message));
    await s.waitNode(async () => { const v = await s.voice(); return v.speaking && /Quatro|crit/i.test(v.current || ""); }, { timeout: 15000, desc: "the answer being spoken" })
      .catch(e => c.ok(false, e.message));
    const n0 = (await s.sampleCalls()).length;
    const tHush = await s.send("para");
    await s.waitNode(async () => !(await s.voice()).speaking, { timeout: 2000, desc: "silence" }).catch(e => c.ok(false, "still speaking 2 s after 'para'"));
    await sleep(1500);
    const cancels = await s.calls(x => x.cap === "speech" && x.method === "cancel" && x.t >= tHush);
    c.ok(cancels.length > 0, "speechSynthesis.cancel() not called");
    c.ok((await s.sampleCalls()).length === n0, "'para' became a sample call");
    const after = (await s.spoken(tHush)).filter(x => x.text.trim());
    c.ok(after.length === 0, "kept speaking after 'para': " + after.map(x => x.text).join(" | "));
    const v = await s.voice();
    c.ok(!v.speaking && !v.queued, "voice queue not empty after 'para'");
    await s.shot("i-hush");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

async function importNotes(s, c, files) {
  const page = s.page;
  let add = (await clickables(page, /Adicionar notas/i));
  if (!add.length) {
    const menu = await clickables(page, /^(⋯|…|\.\.\.|menu|mais( op[cç][oõ]es)?)$/i);
    c.ok(menu.length > 0, "no ⋯ menu button");
    if (menu.length) { await menu[0].click(); await sleep(400); }
    add = await clickables(page, /Adicionar notas/i);
  }
  c.ok(add.length > 0, '"Adicionar notas" not found in the menu');
  const inputs = page.locator("input[type=file]");
  if (await inputs.count()) {
    const attrs = await inputs.first().evaluate(el => ({ multiple: el.multiple, accept: el.accept }));
    c.ok(attrs.multiple, "file input without multiple");
    c.ok(/\.md/.test(attrs.accept) && /\.txt|text\/plain/.test(attrs.accept), "file input accept=" + attrs.accept);
  }
  const fcP = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  if (add.length) await add[0].click().catch(() => {});
  const fc = await fcP;
  if (fc) await fc.setFiles(files);
  else if (await inputs.count()) await inputs.first().setInputFiles(files);
  else c.ok(false, "no file chooser and no input[type=file]");
}

// what covers the centre of a locator (null when the locator itself receives the click)
async function coveredBy(loc) {
  return loc.evaluate(el => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !top || top === el || el.contains(top) ? null : (top.id ? "#" + top.id : top.tagName.toLowerCase() + (top.className ? "." + String(top.className).split(" ")[0] : ""));
  }).catch(() => "unknown");
}
async function userClick(c, loc, what) {
  const cover = await coveredBy(loc);
  if (cover) { c.ok(false, `${what} is covered by ${cover} (a user cannot tap it)`); return false; }
  try { await loc.click({ timeout: 5000 }); return true; } catch (e) {
    const log = e.message.split("\n").map(x => x.trim()).filter(Boolean);
    c.ok(false, `${what} not clickable: ${log[0]} [${log.slice(-3).join(" | ")}]`);
    return false;
  }
}
// close sheets/menus the way a user would (Esc, then a visible close button) so the galaxy is reachable
async function closeOverlays(s) {
  for (let k = 0; k < 3; k++) {
    await s.page.keyboard.press("Escape");
    await sleep(300);
    const close = await clickables(s.page, /^(×|✕|fechar|close)$/i);
    let clicked = false;
    for (const b of close) {
      if (await coveredBy(b)) continue;
      const inPanel = await b.evaluate(el => !!el.closest("#panel, aside")).catch(() => false);
      if (inPanel) continue;
      await b.click({ timeout: 2000 }).then(() => { clicked = true; }, () => {});
      if (clicked) break;
    }
    if (!clicked) return;
    await sleep(300);
  }
}
async function openNodePanel(s, label) {
  await closeOverlays(s);
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = await s.evaluate(l => {
      const sc = window.__t.screenOf(l);
      if (!sc || !(sc.x > 0 && sc.y > 0 && sc.x < innerWidth && sc.y < innerHeight)) return null;
      const el = document.elementFromPoint(sc.x, sc.y);
      return el && el.tagName === "CANVAS" ? sc : null;
    }, label);
    if (p) {
      // like a real mouse: arrive over the star, let the render loop register the hover, then press (as in scenario p)
      await s.page.mouse.move(p.x, p.y, { steps: 4 });
      await sleep(200);
      await s.page.mouse.down(); await sleep(60); await s.page.mouse.up();
      if (await headingVisible(s.page, label, 4000)) return "click"; // same patience as scenario p (slow software WebGL)
      // a tap that opened nothing (or a neighbour) may have started a camera flight: let it land before tapping again,
      // or the next tap hits the spot the star just left and the background tap closes a panel that opened late
      await s.waitStableCamera({ timeout: 6000 });
    }
    await sleep(400);
  }
  const r = await s.evaluate(l => window.__t.clickNode(l), label);
  if (r === "ok" && await headingVisible(s.page, label, 3000)) return "handler";
  return null;
}

scenario("j", "import notes: frontmatter removed, wikilink to a sample note, docs saved; inline two-step delete", async (browser, c) => {
  const s = await open(browser);
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    const files = [
      { name: "Plantão noturno.md", mimeType: "text/markdown", buffer: Buffer.from("---\ntitle: Plantão noturno\ntags: [plantao, rotina]\n---\n# Plantão noturno\n\nPassagem de plantão às 19h no pronto-socorro. Conferir os leitos de observação, pendências de exames e pedidos de vaga na enfermaria.\n") },
      { name: "Checklist do box.md", mimeType: "text/markdown", buffer: Buffer.from("# Checklist do box\n\nMonitor, aspirador e kit de via aérea antes de receber o paciente. Calcular o [[RABT]] assim que houver resultado do exame.\n") },
    ];
    s.step("import notes");
    await importNotes(s, c, files);
    const info = await s.waitGalaxy(28, 15000).catch(e => (c.ok(false, "imported nodes: " + e.message), null));
    if (info) {
      c.ok(info.labels.includes("Plantão noturno") && info.labels.includes("Checklist do box"), "imported labels missing: " + info.labels.filter(l => !SAMPLE_LABELS.includes(l)).join(", "));
      c.ok(info.pairs.some(([a, b]) => (a === "Checklist do box" && b === "RABT") || (a === "RABT" && b === "Checklist do box")), "no link Checklist do box <-> RABT");
    }
    await s.waitNode(async () => Object.keys(await s.dbExport()).filter(p => /^data\/users\/u_test123\/profile\/notes\/[^/]+$/.test(p)).length === 2,
      { timeout: 10000, desc: "2 docs under profile/notes" }).catch(e => c.ok(false, e.message));
    const db = await s.dbExport();
    const docs = Object.entries(db).filter(([p]) => /\/profile\/notes\//.test(p));
    const pl = docs.find(([, d]) => d.label === "Plantão noturno");
    c.ok(!!pl, "no notes doc labelled Plantão noturno");
    if (pl) {
      c.ok(!/tags:|^---/m.test(pl[1].text), "YAML frontmatter kept in the note text");
      c.ok(/Passagem de plantão/.test(pl[1].text), "note body missing");
      c.ok(pl[1].group === "minhas notas", "group " + pl[1].group);
      c.ok(!!pl[1].importedAt, "no importedAt");
    }
    c.ok(!!(await s.probes())["Não importe dados de pacientes"], '"Não importe dados de pacientes." never shown');
    await s.shot("j-imported");
    await closeOverlays(s);
    await waitLayoutSettled(s); // "Plantão noturno" has no link: it must still be on screen once the layout has settled
    const scj = await starsClear(s, { timeout: 15000 });
    c.ok(!scj.off.length, `after the import, stars off screen: ${scj.off.slice(0, 4).join(", ")}`);
    c.ok(!scj.covered.length, `after the import, stars under the page UI: ${scj.covered.slice(0, 4).join(", ")}`);
    // two-step delete from the panel
    s.step("open the node panel");
    const how = await openNodePanel(s, "Plantão noturno");
    c.ok(!!how, "could not open the panel of Plantão noturno");
    if (how) {
      if (how === "handler") c.note("panel opened through the node click handler (canvas click missed)");
      const del = await clickables(s.page, /apagar/i);
      c.ok(del.length > 0, 'no "Apagar" button in the panel');
      s.step("first Apagar tap");
      if (del.length && await userClick(c, del[0], '"Apagar"')) {
        await sleep(800);
        const i1 = await s.info();
        c.ok(i1 && i1.nodes === 28, "one tap deleted the note (SPEC: two-step confirm)");
        c.ok(!!Object.keys(await s.dbExport()).find(p => p === pl[0]), "one tap deleted the doc");
        await s.shot("j-confirm");
        let confirm = await clickables(s.page, /\bconfirm|\bsim\b|toque de novo|apagar mesmo|tem certeza/i);
        if (!confirm.length) confirm = await clickables(s.page, /apagar/i);
        c.ok(confirm.length > 0, "no confirm control after the first tap");
        s.step("confirm tap");
        if (confirm.length) await userClick(c, confirm[0], "the confirm control");
        await s.waitNode(async () => { const i = await s.info(); return i && i.nodes === 27; }, { timeout: 10000, desc: "node removed" }).catch(e => c.ok(false, e.message));
        await s.waitNode(async () => !(pl[0] in (await s.dbExport())), { timeout: 10000, desc: "doc removed" }).catch(e => c.ok(false, e.message));
        const i2 = await s.info();
        if (i2) c.ok(!i2.labels.includes("Plantão noturno") && i2.labels.includes("Checklist do box"), "wrong node removed");
      }
    }
    await s.shot("j-deleted");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

async function errorCase(browser, c, mock, steps, more = {}) {
  const s = await open(browser, Object.assign({ mock }, more));
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    await steps(s);
    await finalChecks(s, c);
  } finally { await s.close(); }
}
const seenCopy = async (s, re) => re.test(await s.text()) || (await s.spoken()).some(x => re.test(x.text));
async function waitCopy(s, c, re, what, timeout = 12000) {
  const ok = await s.waitNode(async () => seenCopy(s, re), { timeout, desc: what }).then(() => true, () => false);
  c.ok(ok, `${what}: no copy matching ${re}`);
  return ok;
}

scenario("k1", "error: sample not_granted -> permission copy, brain off, sample called once", (browser, c) =>
  errorCase(browser, c, { sampleError: { code: "not_granted", message: "the viewer declined" } }, async s => {
    let t = await s.send(RABT_Q);
    await waitCopy(s, c, /permiss/i, "not_granted copy");
    await sleep(800);
    t = await s.send("e o shock index?");
    await sleep(2500);
    const n = (await s.sampleCalls()).length;
    c.ok(n === 1, `sample called ${n} times (want exactly 1: the brain must switch off)`);
    // notices (dismiss "×") must not slide under the note panel
    for (const d of await clickables(s.page, /dispensar/i)) {
      const cov = await coveredBy(d);
      c.ok(!cov, `a notice's dismiss button is covered by ${cov}`);
      const overlap = await d.evaluate(el => {
        const nb = el.parentElement.getBoundingClientRect();
        return [...document.querySelectorAll("aside, [role=complementary]")].some(p => {
          const pb = p.getBoundingClientRect();
          return pb.width > 0 && pb.height > 0 && nb.left < pb.right && pb.left < nb.right && nb.top < pb.bottom && pb.top < nb.bottom;
        });
      }).catch(() => false);
      c.ok(!overlap, "a notice overlaps the note panel");
    }
    await s.shot("k1-not-granted");
  }, { viewport: { width: 1180, height: 820 } }));

scenario("k2", "error: sample rate_limited -> retry-later copy, no automatic retry", (browser, c) =>
  errorCase(browser, c, { sampleError: { code: "rate_limited", message: "slow down" } }, async s => {
    const t = await s.send(RABT_Q);
    await waitCopy(s, c, /daqui a pouco|mais tarde|limite/i, "rate_limited copy");
    const n1 = (await s.sampleCalls(t)).length;
    await sleep(3000);
    const n2 = (await s.sampleCalls(t)).length;
    c.ok(n1 <= 1 && n2 === n1, `the question was retried automatically (${n1} -> ${n2} calls)`);
    await s.shot("k2-rate-limited");
  }));

scenario("k3", "error: calendar server_not_connected -> copy mentions Conectores, no retry, chat still works", async (browser, c) => {
  const s = await open(browser, { mock: { mcpErrors: { "Google Calendar": { code: "server_not_connected", message: "no connector" } } } });
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await waitCopy(s, c, /Conectores/, "calendar copy", 15000);
    await s.settle();
    await sleep(2000);
    c.ok((await s.toolCalls("list_events")).length === 1, "list_events retried after server_not_connected");
    const said = (await s.spoken()).filter(x => /Conectores/.test(x.text)).length;
    c.ok(said <= 1, `the calendar problem was spoken ${said} times (SPEC: once)`);
    const t = await s.send(RABT_Q);
    await s.waitText(/Quatro crit[ée]rios/, { timeout: 25000 }).catch(e => c.ok(false, "chat did not work without the calendar: " + e.message));
    await s.shot("k3-calendar");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

scenario("k4", "error: PubMed tool_error -> research error copy naming PubMed", (browser, c) =>
  errorCase(browser, c, { mcpErrors: { "PubMed/search_articles": { code: "tool_error", message: "E-utilities returned 500", result: { isError: true, content: [{ type: "text", text: "HTTP 500" }] } } } }, async s => {
    const t = await s.send("pesquisa no pubmed laparotomia de controle de danos");
    const ok = await s.waitNode(async () => {
      const lines = (await s.text()).split("\n").concat((await s.spoken(t)).map(x => x.text));
      return lines.some(l => /PubMed/.test(l) && /n[ãa]o|erro|falh|indispon/i.test(l) && !/Segundo o PubMed/.test(l));
    }, { timeout: 15000, desc: "PubMed error copy" }).then(() => true, () => false);
    c.ok(ok, "no error copy naming PubMed");
    c.ok(!(await s.text()).includes("Segundo o PubMed"), "an answer was invented without articles");
    c.ok((await s.toolCalls("get_article_metadata", t)).length === 0, "metadata requested after the search failed");
    await sleep(2000); // let the new exchange finish its entrance (software WebGL renders ~2 fps here) before the picture
    await s.shot("k4-pubmed");
  }));

async function degraded(browser, c, mock, tag) {
  const s = await open(browser, { mock });
  try {
    const info = await s.waitGalaxy(26, 30000).catch(e => (c.ok(false, `${tag}: ${e.message}`), null));
    if (info) c.ok(info.nodes === 26 && info.links === 71, `${tag}: galaxy ${info.nodes}/${info.links}`);
    await s.activate();
    await s.waitNode(async () => (await s.spoken()).some(x => /\b26\b/.test(x.text)), { timeout: 15000, desc: `${tag}: spoken greeting` }).catch(e => c.ok(false, e.message));
    await sleep(1500);
    await s.send(RABT_Q);
    await waitCopy(s, c, /c[ée]rebro|Claude|indispon[ií]vel/i, `${tag}: brain-unavailable message`);
    await sleep(800);
    await s.shot(`l-${tag}`);
    await finalChecks(s, c, { strictConsole: true, label: tag });
  } finally { await s.close(); }
}
scenario("l", "degraded: no window.claude / every use() null / slow use(): galaxy, greeting, brain-unavailable copy, zero errors", async (browser, c) => {
  await degraded(browser, c, { noClaude: true }, "no-claude");
  await degraded(browser, c, { allNull: true }, "all-null");
  // slow use(): the galaxy and Ativar must not wait for the capabilities. Timed on the page's own clock against the
  // earliest moment any use() can resolve (first use() call + the delay), so CPU load on the test machine (software
  // WebGL, parallel scenarios) cannot be mistaken for the page waiting, and a page that does wait still fails.
  const DELAY = 9000;
  const s = await H.open(browser, { file: FILE, mock: Object.assign({}, FAST_VOICE, { useDelayMs: DELAY }) });
  try {
    await s.context.addInitScript(() => {
      const g = () => { const i = window.__t && window.__t.info(); if (i && i.nodes >= 26) window.__galaxyAt = performance.now(); else requestAnimationFrame(g); };
      requestAnimationFrame(g);
      const b = () => {
        const el = [...document.querySelectorAll("button")].find(x => /^\W*Ativar\s+JARVIS\W*$/i.test(x.innerText || ""));
        const r = el && el.getBoundingClientRect();
        if (r && r.width && r.height && getComputedStyle(el).visibility !== "hidden") window.__btnAt = performance.now(); else setTimeout(b, 50);
      };
      setTimeout(b, 0);
    });
    await s.goto();
    await sleep(DELAY + 2500); // past the resolution: finalChecks also covers what happens when the capabilities arrive late
    const r = await s.evaluate(() => ({ galaxy: window.__galaxyAt, btn: window.__btnAt,
      use: (window.__calls || []).filter(x => x.cap === "claude" && x.method === "use").map(x => x.t) }));
    const capsAt = r.use.length ? Math.min(...r.use) + DELAY : Infinity;
    c.ok(r.use.length > 0, "slow use(): the page never asked for a capability");
    c.ok(typeof r.galaxy === "number" && r.galaxy < capsAt, `slow use(): galaxy waited for the capabilities (26 stars at ${Math.round(r.galaxy)} ms, capabilities from ${Math.round(capsAt)} ms)`);
    c.ok(typeof r.btn === "number" && r.btn < capsAt, `slow use(): Ativar waited for the capabilities (shown at ${Math.round(r.btn)} ms, capabilities from ${Math.round(capsAt)} ms)`);
    if (typeof r.galaxy === "number") c.note(`slow use(): galaxy at ${Math.round(r.galaxy)} ms, Ativar at ${Math.round(r.btn)} ms, capabilities from ${Math.round(capsAt)} ms (page clock)`);
    await finalChecks(s, c, { strictConsole: true, label: "slow-use" });
  } finally { await s.close(); }
}, 200000);

scenario("m", "mic button focuses the text box and shows the dictation hint (Mac and iPhone); no SpeechRecognition/getUserMedia", async (browser, c) => {
  for (const [tag, o, re] of [["desktop", { viewport: { width: 1440, height: 900 } }, /ditado|\bFn\b/i],
    ["iphone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, /teclado/i]]) {
    const s = await open(browser, o);
    try {
      await s.waitGalaxy(26, 30000);
      await s.activate();
      await s.settle();
      let mic = s.page.locator("button", { hasText: "🎙" });
      if (!(await mic.count())) mic = s.page.getByRole("button", { name: /🎙|ditad|microfone|ditar/i });
      c.ok((await mic.count()) > 0, `${tag}: no 🎙 button`);
      if (await mic.count()) {
        await mic.first().click();
        await sleep(400);
        const tb = await s.textBox();
        c.ok(await tb.evaluate(el => el === document.activeElement), `${tag}: the text box is not focused after 🎙`);
        await s.waitText(re, { timeout: 4000 }).catch(() => c.ok(false, `${tag}: dictation hint matching ${re} not shown`));
      }
      const forb = await s.forbidden();
      c.ok(!forb.some(f => /SpeechRecognition|getUserMedia/.test(f.what)), `${tag}: microphone APIs used`);
      await s.shot(`m-mic-${tag}`);
      await finalChecks(s, c, { label: tag });
    } finally { await s.close(); }
  }
});

scenario("n", "prefers-reduced-motion: reduce -> boot, activate, answer, no errors", async (browser, c) => {
  const s = await open(browser, { reducedMotion: "reduce" });
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    await s.send(RABT_Q);
    await s.waitText(/Quatro crit[ée]rios/, { timeout: 25000 }).catch(e => c.ok(false, "answer not shown: " + e.message));
    await sleep(2000);
    await s.shot("n-reduced-motion");
    await finalChecks(s, c, { strictConsole: true });
  } finally { await s.close(); }
});

scenario("o", "iPhone 390x844: text box and send button inside the viewport and >= 44px", async (browser, c) => {
  const s = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  try {
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    const tb = await s.textBox();
    const send = s.page.getByRole("button", { name: /Enviar/i }).first();
    const vp = { w: 390, h: 844 };
    for (const [name, loc] of [["text box", tb], ["send button", send]]) {
      const vis = await loc.isVisible().catch(() => false);
      c.ok(vis, `${name} not visible`);
      if (!vis) continue;
      const rv = await reallyVisible(loc);
      c.ok(rv === true, `${name} is not really visible: ${rv}`);
      const b = await loc.boundingBox();
      c.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.w + 0.5 && b.y + b.height <= vp.h + 0.5, `${name} outside the viewport: ${JSON.stringify(b)}`);
      c.ok(b.height >= 44, `${name} is ${Math.round(b.height)}px tall (< 44)`);
    }
    const lay = await s.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
    c.ok(lay.sw <= lay.iw, `horizontal overflow ${lay.sw} > ${lay.iw}`);
    // the briefing is taller than the answer list here: its first words must be on screen, not scrolled away
    const firstLine = await s.evaluate(() => {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = null;
      for (let t; (t = tw.nextNode());) if (/^\s*Hoje h[áa]/.test(t.nodeValue)) node = t;
      if (!node) return "no briefing text";
      const i = node.nodeValue.search(/\S/), r = document.createRange();
      r.setStart(node, i); r.setEnd(node, i + 4);
      const b = r.getBoundingClientRect();
      if (!(b.width > 0)) return "not rendered";
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2), p = node.parentElement;
      return el && (el === p || p.contains(el) || el.contains(p)) ? true : `hidden at y=${Math.round(b.y)} (under ${el ? el.id || el.className || el.tagName : "nothing"})`;
    });
    c.ok(firstLine === true, `the first line of the briefing is not visible: ${firstLine} (a long answer must open at its start)`);
    const sco = await starsClear(s);
    c.ok(!sco.off.length, `stars off screen: ${sco.off.slice(0, 4).join(", ")}`);
    c.ok(!sco.covered.length, `stars under the answer list/dock: ${sco.covered.slice(0, 4).join(", ")}`);
    await s.shot("o-iphone");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

// a sample star that is on the canvas (not under the HUD/dock), near the centre, and not moving any more
async function pickTappableNode(s) {
  const pick = () => s.evaluate(() => {
    const g = window.__t.graph(), d = window.__t.data();
    if (!g || !d) return null;
    const out = [];
    const all = d.nodes.map(n => { try { return { n, sc: g.graph2ScreenCoords(n.x || 0, n.y || 0, n.z || 0) }; } catch (e) { return null; } }).filter(Boolean);
    for (const { n, sc } of all) {
      const label = n.label != null ? n.label : n.name;
      if (!(sc.x > 60 && sc.y > 60 && sc.x < innerWidth - 60 && sc.y < innerHeight - 60)) continue;
      if (all.some(o => o.n !== n && Math.hypot(o.sc.x - sc.x, o.sc.y - sc.y) < 28)) continue; // isolated: a tap cannot hit a neighbour
      const pts = [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]];
      if (!pts.every(([dx, dy]) => { const el = document.elementFromPoint(sc.x + dx, sc.y + dy); return el && el.tagName === "CANVAS"; })) continue;
      out.push({ label, x: sc.x, y: sc.y, c: Math.hypot(sc.x - innerWidth / 2, sc.y - innerHeight / 2) });
    }
    out.sort((a, b) => a.c - b.c);
    return out;
  });
  let prev = null;
  for (let k = 0; k < 30; k++) {
    const cur = await pick();
    if (cur && prev && cur.length) {
      const still = cur.find(n => { const p = prev.find(q => q.label === n.label); return p && Math.hypot(p.x - n.x, p.y - n.y) < 1.5; });
      if (still) return still;
    }
    prev = cur;
    await sleep(350);
  }
  return null;
}

scenario("p", "tap a star: its panel opens (mouse on Mac, touch on iPad) without page errors", async (browser, c) => {
  for (const [tag, o] of [["mouse-1440", { viewport: { width: 1440, height: 900 } }], ["touch-ipad", { viewport: { width: 1180, height: 820 }, hasTouch: true }]]) {
    const s = await open(browser, Object.assign({ reducedMotion: "reduce" }, o));
    try {
      await s.waitGalaxy(26, 30000);
      await s.activate();
      await s.settle();
      await closeOverlays(s);
      let opened = false, n = null;
      for (let attempt = 0; attempt < 2 && !opened; attempt++) { // a user taps again when a tap misses
        if (attempt) { await s.page.keyboard.press("Escape"); await sleep(1500); }
        n = await pickTappableNode(s);
        if (!n) continue;
        s.step(`${tag}: tap ${n.label}`);
        if (o.hasTouch) await s.page.touchscreen.tap(n.x, n.y);
        else { await s.page.mouse.move(n.x, n.y, { steps: 4 }); await sleep(200); await s.page.mouse.down(); await sleep(60); await s.page.mouse.up(); }
        opened = await headingVisible(s.page, n.label, 4000);
        if (!opened) c.note(`${tag}: a tap on "${n.label}" missed`);
      }
      c.ok(!!n, `${tag}: no isolated star is reachable on the canvas`);
      if (n) c.ok(opened, `${tag}: tapping the star "${n.label}" did not open its panel (2 tries)`);
      await sleep(800);
      await s.shot(`p-${tag}`);
      await finalChecks(s, c, { label: tag });
    } finally { await s.close(); }
  }
});

// SPEC "Contrato da página" 3: the core never depends on the ESM module; without even the UMD (CDN down, no WebGL) a
// discreet notice appears and chat, voice and memories keep working. Each case blocks one dependency for real.
async function contract3(browser, c, tag, { block = null, noWebGL = false }) {
  const s = await H.open(browser, { file: FILE, mock: Object.assign({}, FAST_VOICE) });
  try {
    if (block) await s.context.route(block, r => r.fulfill({ status: 404, body: "blocked by the test", headers: { "access-control-allow-origin": "*" } }));
    if (noWebGL) await s.context.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /^(webgl|webgl2|experimental-webgl)$/i.test(String(type)) ? null : orig.call(this, type, ...rest);
      };
    });
    await s.goto();
    s.step(`${tag}: boot`);
    if (tag === "esm-404") {
      const info = await s.waitGalaxy(26, 30000).catch(e => (c.ok(false, `${tag}: ${e.message}`), null));
      if (info) c.ok(info.nodes === 26 && info.links === 71, `${tag}: galaxy ${info.nodes}/${info.links} without the ESM module (want 26/71 from the UMD alone)`);
      await sleep(2500); // the module import has failed by now
      const st = await s.evaluate(() => (window.__jarvis && window.__jarvis.state) || null);
      if (st && "bloom" in st) c.ok(st.bloom === false, `${tag}: bloom reported on although three.js never loaded`);
    } else {
      const shown = await s.waitNode(async () => {
        const t = await s.text();
        return /gal[áa]xia/i.test(t) && /(n[ãa]o|sem|indispon|falh)/i.test(t) && /chat|voz|mem[óo]ria/i.test(t) ? t : null;
      }, { timeout: 20000, desc: "galaxy notice" }).catch(() => null);
      c.ok(!!shown, `${tag}: no discreet notice saying the galaxy is unavailable while chat/voice/memories keep working`);
      const btn = await s.activateButton();
      c.ok(await btn.isVisible().catch(() => false), `${tag}: "Ativar JARVIS" not visible without the galaxy`);
    }
    s.step(`${tag}: activate`);
    await s.activate();
    await s.waitNode(async () => (await s.spoken()).some(x => /\b26\b/.test(x.text)), { timeout: 15000, desc: `${tag}: spoken greeting with 26` }).catch(e => c.ok(false, e.message));
    await s.settle().catch(() => {});
    s.step(`${tag}: ask`);
    const t = await s.send(RABT_Q);
    await s.waitText(/Quatro crit[ée]rios/, { timeout: 25000 }).catch(e => c.ok(false, `${tag}: answer not shown: ${e.message}`));
    await s.waitNode(async () => (await s.spoken(t)).some(x => /crit[ée]rios/i.test(x.text)), { timeout: 15000, desc: `${tag}: answer spoken` }).catch(e => c.ok(false, e.message));
    await waitVoiceIdle(s, 20000); // let the answer finish: a new command while it streams would stop it (barge-in)
    s.step(`${tag}: remember`);
    const t2 = await s.send("Jarvis, lembre que o carrinho de parada fica no box 3");
    await s.waitNode(async () => Object.keys(await s.dbExport()).some(p => /\/profile\/memories\/[^/]+$/.test(p)), { timeout: 15000, desc: `${tag}: memory saved` })
      .catch(e => c.ok(false, e.message));
    await s.waitNode(async () => (await s.spoken(t2)).some(x => x.text.trim().length > 3), { timeout: 15000, desc: `${tag}: memory confirmation spoken` }).catch(e => c.ok(false, e.message));
    await sleep(800);
    await s.shot(`q-${tag}`);
    await finalChecks(s, c, { label: tag });
  } finally { await s.close(); }
}
scenario("q", "contract 3: no three.js ESM -> galaxy from the UMD alone; no UMD / no WebGL -> notice, chat, voice and memories still work", async (browser, c) => {
  await contract3(browser, c, "esm-404", { block: /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\// });
  await contract3(browser, c, "umd-404", { block: /^https:\/\/cdn\.jsdelivr\.net\/npm\/3d-force-graph@1\.80\.1\// });
  await contract3(browser, c, "no-webgl", { noWebGL: true });
}, 240000);

// the source star the camera flies to after an answer must be visible on iPad portrait and iPhone: not under the note
// panel (side panel or bottom sheet), the answer list, the dock or the top bar; opening its panel keeps it visible
async function starOnCanvas(s, label) {
  return s.evaluate(l => {
    const sc = window.__t.screenOf(l);
    if (!sc || !(sc.x >= 0 && sc.y >= 0 && sc.x <= innerWidth && sc.y <= innerHeight)) return { ok: false, why: "off screen", sc };
    const el = document.elementFromPoint(sc.x, sc.y);
    const what = el ? (el.id ? "#" + el.id : el.tagName.toLowerCase()) + (el.closest("aside, [id*=panel], [class*=sheet]") ? " (panel)" : "") : "nothing";
    return { ok: !!el && el.tagName === "CANVAS", why: what, x: Math.round(sc.x), y: Math.round(sc.y) };
  }, label);
}
async function waitStarSettled(s, label, timeout = 12000) {
  let prev = null, last = null;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    last = await starOnCanvas(s, label);
    if (prev && last.ok && prev.ok && Math.hypot(last.x - prev.x, last.y - prev.y) < 2) return last;
    prev = last;
    await sleep(500);
  }
  return last;
}
scenario("r", "iPad portrait and iPhone: the source star of an answer stays visible (not under the note panel/sheet), panel opens from the chip", async (browser, c) => {
  for (const [tag, o] of [["820x1180", { viewport: { width: 820, height: 1180 }, hasTouch: true }],
    ["390x844", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }]]) {
    const s = await open(browser, o);
    try {
      await s.waitGalaxy(26, 30000);
      await s.activate();
      await s.settle();
      await s.waitStableCamera();
      const node0 = await s.node("RABT"), cam0 = await s.cam();
      const d0 = node0 && cam0 && cam0.pos ? dist(cam0.pos, node0) : NaN;
      s.step(`${tag}: ask`);
      await s.send(RABT_Q);
      await s.waitText(/Quatro crit[ée]rios/, { timeout: 25000 }).catch(e => c.ok(false, `${tag}: answer not shown: ${e.message}`));
      const flown = await s.waitNode(async () => {
        const n = await s.node("RABT"), cm = await s.cam();
        return n && cm && cm.pos && dist(cm.pos, n) < 0.8 * d0 ? true : null;
      }, { timeout: 15000, desc: "flight" }).catch(() => false);
      c.ok(!!flown, `${tag}: the camera did not fly to RABT after the answer`);
      const a = await waitStarSettled(s, "RABT");
      c.ok(a && a.ok, `${tag}: after the answer the RABT star is not visible: ${JSON.stringify(a)}`);
      await s.shot(`r-${tag}-answer`);
      s.step(`${tag}: chip`);
      await s.page.keyboard.press("Escape").catch(() => {});
      await sleep(600);
      const chips = await clickables(s.page, /^\W*RABT\b/);
      c.ok(chips.length > 0, `${tag}: no RABT source chip`);
      // a long answer leaves its chips below the fold of the answer list: the user scrolls the list first
      if (chips.length) await chips[chips.length - 1].scrollIntoViewIfNeeded().catch(() => {});
      await sleep(300);
      if (chips.length && await userClick(c, chips[chips.length - 1], `${tag}: the RABT source chip`)) {
        c.ok(await headingVisible(s.page, "RABT", 6000), `${tag}: the chip did not open the panel titled RABT`);
        const b = await waitStarSettled(s, "RABT");
        c.ok(b && b.ok, `${tag}: with the RABT panel open, its star is not visible: ${JSON.stringify(b)}`);
        const tb = await s.textBox();
        const rv = await reallyVisible(tb);
        c.ok(rv === true, `${tag}: with the panel open the text box is not really visible: ${rv}`);
        await s.shot(`r-${tag}-panel`);
      }
      const lay = await s.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
      c.ok(lay.sw <= lay.iw, `${tag}: horizontal overflow ${lay.sw} > ${lay.iw}`);
      await finalChecks(s, c, { label: tag });
    } finally { await s.close(); }
  }
}, 200000);

// a memory dictated while the account is still connecting (use() may take ~10 s, SPEC "Regras gerais") must reach
// the account's db once it resolves and must not vanish from the galaxy when the account's memory list arrives
scenario("t", "remember while the account is still connecting (slow use()): the memory lands in the db and stays in the galaxy", async (browser, c) => {
  const DELAY = 7000;
  const s = await H.open(browser, { file: FILE, mock: Object.assign({}, FAST_VOICE, { useDelayMs: DELAY }) });
  try {
    await s.goto();
    await s.waitGalaxy(26, 30000);
    await s.activate();
    const st0 = await s.evaluate(() => (window.__jarvis && window.__jarvis.state ? window.__jarvis.state.storage : null));
    const early = await s.evaluate(() => (window.__calls || []).filter(x => x.cap === "claude" && x.method === "use").map(x => x.t))
      .then(async ts => ts.length && (await s.now()) < Math.min(...ts) + DELAY);
    if (!early) c.note("the activation took longer than the use() delay; the connecting window was not exercised");
    if (st0 !== null && st0 !== "pending") c.note(`storage was already "${st0}" when the memory was dictated`);
    const t = await s.send("Jarvis, lembre que o plantão de sábado é no PS");
    const memPath = await s.waitNode(async () => Object.keys(await s.dbExport()).find(p => /^data\/users\/u_test123\/profile\/memories\/[^/]+$/.test(p)),
      { timeout: DELAY + 15000, desc: "the memory in the account's db" }).catch(e => (c.ok(false, e.message + " (a memory said while connecting was kept only on the device)"), null));
    if (memPath) {
      const doc = (await s.dbExport())[memPath];
      c.ok(/plant[aã]o de s[aá]bado/i.test(doc.text || ""), "memory text: " + JSON.stringify(doc.text));
    }
    await s.waitNode(async () => (await s.spoken(t)).some(x => x.text.trim().length > 3), { timeout: DELAY + 15000, desc: "a spoken confirmation" }).catch(e => c.ok(false, e.message));
    await sleep(2500); // the account's memory snapshot has arrived by now
    const info = await s.info();
    c.ok(info && info.nodes === 27, `after the account connected the galaxy has ${info && info.nodes} nodes (want 27: the new memory must stay)`);
    await s.shot("t-remember-connecting");
    await finalChecks(s, c);
  } finally { await s.close(); }
}, 120000);

// the day document grows with every question; it must stay under the db's 256 KiB per document (db.d.ts) by dropping
// the oldest events, or the refused write would switch the whole visit to read-only (and block memories too)
scenario("u", "journal near the 256 KiB document limit: the day doc drops old events instead of failing; memories still save", async (browser, c) => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayPath = `data/users/u_test123/profile/days/${date}`;
  const long = (ch, n) => Array.from({ length: n }, (_, i) => (i % 9 === 8 ? " " : ch)).join("");
  const events = [];
  const size = () => Buffer.byteLength(JSON.stringify({ date, events }));
  for (let i = 0; size() < 259000 && i < 190; i++) {
    events.push({ t: new Date(Date.now() - (200 - i) * 60000).toISOString(), kind: "ask", q: long("ã", 300), a: long("é", 300),
      sources: Array.from({ length: 8 }, () => long("ç", 120)) });
  }
  const s = await open(browser, { mock: { dbState: { [dayPath]: { date, events } } } });
  try {
    c.note(`seeded the day doc with ${events.length} events, ${size()} bytes`);
    await s.waitGalaxy(26, 30000);
    await s.activate();
    await s.settle();
    const t = await s.send(RABT_Q);
    await s.waitText(/Quatro crit[ée]rios/, { timeout: 25000 }).catch(e => c.ok(false, "answer not shown: " + e.message));
    const doc = await s.waitNode(async () => {
      const d = (await s.dbExport())[dayPath];
      return d && Array.isArray(d.events) && d.events.some(e => /crit[ée]rios do RABT/.test(e.q || "")) ? d : null;
    }, { timeout: 15000, desc: "the question in the day doc" }).catch(e => (c.ok(false, e.message + " (the day doc write failed near the size limit)"), null));
    if (doc) {
      const bytes = Buffer.byteLength(JSON.stringify(doc));
      c.ok(bytes <= 262144, `day doc is ${bytes} bytes (limit 256 KiB)`);
      c.ok(doc.events.length <= 200, `day doc has ${doc.events.length} events (SPEC: at most 200)`);
    }
    const t2 = await s.send("Jarvis, lembre que o plantão de sábado é no PS");
    await s.waitNode(async () => Object.keys(await s.dbExport()).some(p => /\/profile\/memories\/[^/]+$/.test(p)), { timeout: 15000, desc: "the memory doc" })
      .catch(e => c.ok(false, e.message + " (the visit went read-only after the journal write)"));
    const txt = await s.text();
    c.ok(!/fica s[óo] na tela|s[óo] nesta visita/i.test(txt), "a read-only / not-saved warning is shown");
    await s.shot("u-journal-limit");
    await finalChecks(s, c);
  } finally { await s.close(); }
});

// ------------------------------------------------------------------- runner ----
async function runOne(browser, sc) {
  const c = new Checks();
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([sc.fn(browser, c), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`scenario timed out after ${sc.timeoutMs} ms`)), sc.timeoutMs); })]);
  } catch (e) {
    c.ok(false, "threw: " + String(e && e.message || e).split("\n")[0]);
  } finally { clearTimeout(timer); }
  return { sc, c, ms: Date.now() - t0 };
}

(async () => {
  if (!fs.existsSync(FILE)) {
    console.log(`FAIL  setup  ${FILE} does not exist`);
    process.exit(1);
  }
  fs.mkdirSync(H.SHOTS, { recursive: true });
  const list = opts.only.length ? S.filter(x => opts.only.includes(x.id)) : S;
  const browser = await H.launch();
  const results = [];
  const queue = list.slice();
  const worker = async () => {
    while (queue.length) {
      const sc = queue.shift();
      const r = await runOne(browser, sc);
      results.push(r);
      const status = r.c.fails.length ? "FAIL" : "PASS";
      console.log(`${status}  (${r.sc.id}) ${r.sc.title}  [${(r.ms / 1000).toFixed(1)} s]`);
      for (const f of r.c.fails) console.log(`        - ${f}`);
      for (const n of r.c.notes) console.log(`        · ${n}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, list.length) }, worker));
  await browser.close();
  const failed = results.filter(r => r.c.fails.length);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed  (${path.relative(process.cwd(), FILE) || FILE})  screenshots: ${path.relative(process.cwd(), H.SHOTS)}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error("E2E RUNNER CRASHED", e); process.exit(2); });
