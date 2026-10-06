#!/usr/bin/env node
// JARVIS core unit tests: extracts <script id="jarvis-core"> from jarvis.html, runs it in a vm
// context with no DOM, and checks the pure logic against the reference (ref/build.py, ref/server.py,
// ref/notes.json, ref/links.json) and SPEC.md. Usage: node test/core.test.cjs [path/to/jarvis.html]
// Each case carries its source: [ref] = ported Python/old viewer behaviour, [spec] = SPEC.md, [task] = test brief.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_DIR = path.resolve(__dirname, "..");
const FILE = path.resolve(process.argv[2] || process.env.JARVIS_HTML || path.join(APP_DIR, "jarvis.html"));
const NOTES_JSON = fs.readFileSync(path.join(APP_DIR, "ref", "notes.json"), "utf8");
const LINKS_JSON = fs.readFileSync(path.join(APP_DIR, "ref", "links.json"), "utf8");
const NOTES = JSON.parse(NOTES_JSON);
const LINKS = JSON.parse(LINKS_JSON);

const results = [];
function record(group, name, ok, detail, src = "") {
  results.push({ group, name, ok: !!ok, detail: ok ? "" : detail, src });
}
function safe(group, name, fn, src) {
  try {
    const r = fn();
    if (r === true || r === undefined) record(group, name, true, "", src);
    else record(group, name, false, typeof r === "string" ? r : JSON.stringify(r), src);
  } catch (e) {
    record(group, name, false, "threw: " + (e && e.stack ? e.stack.split("\n").slice(0, 2).join(" | ") : e), src);
  }
}
const show = v => { try { const s = JSON.stringify(v); return s && s.length > 300 ? s.slice(0, 300) + "…" : s; } catch { return String(v); } };
const plain = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))); // drop the vm realm's prototypes
const norm = s => String(s).replace(/\s+/g, " ").trim();
const foldJs = s => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

function finish() {
  const w1 = Math.max(5, ...results.map(r => r.group.length));
  const w2 = Math.min(64, Math.max(4, ...results.map(r => r.name.length)));
  const line = "-".repeat(w1 + w2 + 20);
  console.log(line);
  console.log(`${"GROUP".padEnd(w1)}  ${"CASE".padEnd(w2)}  RESULT`);
  console.log(line);
  for (const r of results) {
    const name = r.name.length > w2 ? r.name.slice(0, w2 - 1) + "…" : r.name;
    console.log(`${r.group.padEnd(w1)}  ${name.padEnd(w2)}  ${r.ok ? "PASS" : "FAIL"}${r.src ? " " + r.src : ""}${r.ok ? "" : "  -> " + r.detail}`);
  }
  console.log(line);
  const fail = results.filter(r => !r.ok).length;
  console.log(`${results.length - fail} passed, ${fail} failed, ${results.length} total  (${path.relative(process.cwd(), FILE) || FILE})`);
  process.exit(fail ? 1 : 0);
}

// ------------------------------------------------------------ load the core ----
if (!fs.existsSync(FILE)) {
  record("load", "jarvis.html exists", false, "not found: " + FILE, "[spec]");
  finish();
}
const HTML = fs.readFileSync(FILE, "utf8");
const coreMatch = HTML.match(/<script\b([^>]*)\bid\s*=\s*["']?jarvis-core["']?([^>]*)>([\s\S]*?)<\/script>/i);
safe("load", "<script id=\"jarvis-core\"> present", () => (coreMatch ? true : "no <script id=\"jarvis-core\"> in the file"), "[spec]");
if (!coreMatch) finish();
safe("load", "jarvis-core is a classic script", () => {
  const attrs = coreMatch[1] + coreMatch[2];
  const m = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
  return !m || /^(text|application)\/(javascript|ecmascript)$/i.test(m[1]) ? true : "type=" + m[1];
}, "[spec]");
safe("load", "sample-notes JSON equals ref/notes.json", () => {
  const m = HTML.match(/<script\b[^>]*\bid\s*=\s*["']?sample-notes["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return "no <script type=\"application/json\" id=\"sample-notes\">";
  if (!/type\s*=\s*["']?application\/json/i.test(m[0].slice(0, m[0].indexOf(">")))) return "sample-notes is not type=application/json";
  const got = JSON.parse(m[1]);
  return JSON.stringify(got) === JSON.stringify(NOTES) ? true : "embedded notes differ from ref/notes.json";
}, "[spec]");

const sandbox = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, queueMicrotask,
  structuredClone: typeof structuredClone === "function" ? structuredClone : undefined,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox; // not a DOM: only lets `window.JarvisCore = …` style code work
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
let C = null;
safe("load", "core evaluates without a DOM", () => {
  vm.runInContext(coreMatch[3], ctx, { filename: "jarvis-core.js", timeout: 5000 });
  C = ctx.JarvisCore || (ctx.window && ctx.window.JarvisCore);
  return C ? true : "globalThis.JarvisCore is not defined";
}, "[spec]");
if (!C) finish();
const EXPECTED_API = ["fold", "tokens", "stem", "queryTerms", "buildLinks", "makeExcerpt", "wikilinkTargets", "indexNotes", "retrieve",
  "mostRelated", "makeTitle", "parseIntent", "journalWindow", "stripSources", "splitSentences", "personaPrompt"];
for (const k of EXPECTED_API) safe("api", `JarvisCore.${k} is a function`, () => (typeof C[k] === "function" ? true : typeof C[k]), "[spec]");

const inRealm = json => vm.runInContext("JSON.parse(" + JSON.stringify(json) + ")", ctx);
const notesIn = () => inRealm(NOTES_JSON);

// -------------------------------------------------------------- fold/tokens ----
const FOLD = [
  ["Transfusão Maciça", "transfusao macica"], ["ÁCIDO TRANEXÂMICO", "acido tranexamico"], ["Configuração do iPad", "configuracao do ipad"],
  ["Pós", "pos"], ["São Paulo", "sao paulo"],
];
for (const [i, o] of FOLD) safe("fold", `fold(${JSON.stringify(i)})`, () => (C.fold(i) === o ? true : `got ${show(C.fold(i))}, want ${show(o)}`), "[ref]");
const TOKENS = [
  ["Ácido tranexâmico: 1 g IV!", ["acido", "tranexamico", "1", "g", "iv"]], ["iMIST-AMBO", ["imist", "ambo"]], ["E-FAST", ["e", "fast"]],
  ["São Paulo — 2026", ["sao", "paulo", "2026"]], ["snake_case", ["snake", "case"]], ["Pós-operatório, ÇÃO", ["pos", "operatorio", "cao"]],
  ["", []],
];
for (const [i, o] of TOKENS) safe("tokens", `tokens(${JSON.stringify(i)})`, () => { const g = plain(C.tokens(i)); return JSON.stringify(g) === JSON.stringify(o) ? true : `got ${show(g)}, want ${show(o)}`; }, "[ref]");

// --------------------------------------------------------------- buildLinks ----
safe("links", "buildLinks(ref/notes.json) deep-equals ref/links.json (71 pairs, same order)", () => {
  const got = plain(C.buildLinks(notesIn()));
  if (!Array.isArray(got)) return "not an array: " + show(got);
  const pairs = got.map(l => ({ source: typeof l.source === "object" ? l.source.id : l.source, target: typeof l.target === "object" ? l.target.id : l.target }));
  if (pairs.length !== LINKS.length) return `got ${pairs.length} links, want ${LINKS.length}`;
  for (let i = 0; i < LINKS.length; i++) {
    if (pairs[i].source !== LINKS[i].source || pairs[i].target !== LINKS[i].target) return `first difference at #${i}: got ${show(pairs[i])}, want ${show(LINKS[i])}`;
  }
  return true;
}, "[spec]");
safe("links", "buildLinks does not mutate its input", () => {
  const n = notesIn();
  const before = JSON.stringify(n.map(x => ({ path: x.path, label: x.label, group: x.group, text: x.text })));
  C.buildLinks(n);
  return JSON.stringify(n.map(x => ({ path: x.path, label: x.label, group: x.group, text: x.text }))) === before ? true : "notes changed";
}, "[spec]");
safe("links", "imported note: [[RABT]] links to RABT; mention of 'Shock Index' links too", () => {
  const extra = NOTES.concat([{ path: "minhas notas/Checklist do box.md", label: "Checklist do box", group: "minhas notas",
    text: "# Checklist do box\n\nMonitor, aspirador, via aérea. Calcular o [[RABT]] e conferir o Shock Index.\n" }]);
  const got = plain(C.buildLinks(inRealm(JSON.stringify(extra))));
  const idx = extra.length - 1, rabt = 10, si = 12;
  const has = (a, b) => got.some(l => (l.source === a && l.target === b) || (l.source === b && l.target === a));
  if (!has(idx, rabt)) return "no link Checklist do box <-> RABT";
  if (!has(idx, si)) return "no link Checklist do box <-> Shock Index";
  return got.length >= LINKS.length + 2 ? true : "sample links lost: " + got.length;
}, "[ref]");
safe("links", "wikilinkTargets: [[pasta/Alvo#sec|apelido]] and attachments", () => {
  const got = plain(C.wikilinkTargets("Ver [[protocolo/RABT#critérios|o escore]], ![[figura.png]], [[Protocolo v2.10]] e [[Nota.md]]."));
  const want = ["protocolo/RABT", "Protocolo v2.10", "Nota"];
  return JSON.stringify(got) === JSON.stringify(want) ? true : `got ${show(got)}, want ${show(want)}`;
}, "[ref]");

// --------------------------------------------------------------- parseIntent ----
// kind expectations; `want` adds a field check (any property of the result).
const T = "o plantão de sábado é no PS";
const INTENTS = [
  // hush
  ["para", "hush", null, "[ref]"], ["Jarvis, para!", "hush", null, "[ref]"], ["pare", "hush", null, "[ref]"], ["silêncio", "hush", null, "[ref]"],
  ["silencio", "hush", null, "[ref]"], ["chega.", "hush", null, "[ref]"], ["cala a boca", "hush", null, "[ref]"], ["Jarvis chega", "hush", null, "[ref]"],
  // remember
  ["lembre que " + T, "remember", { text: T }, "[ref]"],
  ["Jarvis, lembre que " + T, "remember", { text: T }, "[task]"],
  ["jarvis lembre que o carrinho de parada fica no box 3", "remember", { text: "o carrinho de parada fica no box 3" }, "[ref]"],
  ["anota aí que a prova de título é dia 12", "remember", { text: "a prova de título é dia 12" }, "[task]"],
  ["anota ai que a prova de titulo e dia 12", "remember", { text: "a prova de titulo e dia 12" }, "[ref]"],
  ["guarda isso: o R3 da noite é o Diego", "remember", { text: "o R3 da noite é o Diego" }, "[task]"],
  ["lembre-se de que a reunião é às 7h", "remember", { text: "a reunião é às 7h" }, "[ref]"],
  ["memoriza que o box 2 está sem monitor", "remember", { text: "o box 2 está sem monitor" }, "[ref]"],
  ["Jarvis, anote que o tomógrafo volta amanhã.", "remember", { text: "o tomógrafo volta amanhã" }, "[ref]"],
  // research
  ["pesquisa no pubmed laparotomia de controle de danos", "research", { text: "laparotomia de controle de danos", notIncludes: "pubmed" }, "[task]"],
  ["Jarvis, pesquisa no PubMed sobre REBOA no trauma", "research", { text: "REBOA no trauma", notIncludes: "pubmed" }, "[spec]"],
  ["pesquisa na literatura toracotomia de reanimação", "research", { text: "toracotomia de reanimação" }, "[spec]"],
  ["procura artigos sobre ácido tranexâmico no TCE", "research", { text: "ácido tranexâmico no TCE" }, "[task]"],
  ["procura artigos sobre acido tranexamico no TCE", "research", { text: "acido tranexamico no TCE" }, "[task]"],
  ["qual a evidência sobre REBOA na hemorragia pélvica?", "research", { text: "REBOA na hemorragia pélvica" }, "[task]"],
  ["qual a evidencia sobre fixacao precoce de femur", "research", { text: "fixacao precoce de femur" }, "[task]"],
  ["pesquisa na internet sobre antibiótico no trauma de face", "research", { text: "antibiótico no trauma de face" }, "[ref]"],
  // research negatives -> ask
  ["procura na minha nota sobre FAST", "ask", null, "[task]"],
  ["pesquisa nas minhas notas o RABT", "ask", null, "[ref]"],
  ["procura na galáxia a nota do Glasgow", "ask", null, "[spec]"],
  // remember negatives -> ask
  ["lembra quando a gente falou do TRISS?", "ask", null, "[task]"],
  ["você lembra do protocolo?", "ask", null, "[task]"],
  ["lembra que eu falei do TRISS?", "ask", null, "[ref]"],
  ["Jarvis, você lembra o que é o NEXUS?", "ask", null, "[task]"],
  // tier
  ["modo máximo", "tier", { value: "complex" }, "[spec]"], ["modo maximo", "tier", { value: "complex" }, "[spec]"],
  ["Jarvis, modo máximo.", "tier", { value: "complex" }, "[spec]"], ["troca para o Opus", "tier", { value: "complex" }, "[spec]"],
  ["muda pro fable", "tier", { value: "complex" }, "[spec]"], ["use o mais forte", "tier", { value: "complex" }, "[spec]"],
  ["modo rápido", "tier", { value: "quick" }, "[spec]"], ["modo rapido", "tier", { value: "quick" }, "[spec]"],
  ["troca pro haiku", "tier", { value: "quick" }, "[spec]"], ["usa o sonnet", "tier", { value: "default" }, "[spec]"],
  ["modo normal", "tier", { value: "default" }, "[spec]"],
  // humor
  ["humor em 30", "humor", { num: [30] }, "[spec]"], ["humor em 30 por cento", "humor", { num: [30] }, "[ref]"],
  ["Jarvis, humor em 50%", "humor", { num: [50] }, "[ref]"], ["humor 100", "humor", { num: [100] }, "[ref]"],
  ["mais humor", "humor", { dir: "up" }, "[spec]"], ["menos humor", "humor", { dir: "down" }, "[spec]"],
  // humor negatives
  ["me conta uma piada", "ask", null, "[ref]"], ["qual é o seu humor hoje?", "ask", null, "[ref]"],
  // journal
  ["o que eu fiz ontem?", "journal", null, "[task]"], ["o que fiz na terça", "journal", null, "[task]"], ["resumo da semana", "journal", null, "[task]"],
  ["Jarvis, o que eu perguntei hoje?", "journal", null, "[ref]"], ["o que eu anotei anteontem", "journal", null, "[ref]"],
  ["o que eu pesquisei na sexta-feira?", "journal", null, "[ref]"], ["o que conversamos no dia 3?", "journal", null, "[ref]"],
  ["o que eu fiz esta semana?", "journal", null, "[spec]"],
  // journal negative: journal verb, no day
  ["o que eu fiz de errado no cálculo do RTS?", "ask", null, "[ref]"],
  // briefing
  ["o que tenho hoje?", "briefing", null, "[task]"], ["minha agenda", "briefing", null, "[task]"], ["briefing", "briefing", null, "[task]"],
  ["Jarvis, qual a minha agenda de hoje?", "briefing", null, "[spec]"], ["o que tem na agenda hoje", "briefing", null, "[spec]"],
  // help
  ["ajuda", "help", null, "[spec]"], ["Jarvis, ajuda!", "help", null, "[spec]"],
  // plain questions / smalltalk
  ["quais são os critérios do RABT?", "ask", null, "[ref]"], ["Jarvis, quais sao os criterios do RABT", "ask", null, "[ref]"],
  ["como calcula o shock index", "ask", null, "[ref]"], ["qual a janela do acido tranexamico", "ask", null, "[ref]"],
  ["para que serve o shock index?", "ask", null, "[ref]"], ["me explica o iMIST-AMBO", "ask", null, "[ref]"],
  ["bom dia, Jarvis", "ask", null, "[ref]"], ["obrigado, Jarvis", "ask", null, "[ref]"],
  ["quais os critérios do NEXUS para não pedir TC", "ask", null, "[ref]"],
];
function strings(o, depth = 0) {
  if (o == null || depth > 3) return [];
  if (typeof o === "string") return [o];
  if (typeof o !== "object") return [];
  return Object.entries(o).filter(([k]) => k !== "kind").flatMap(([, v]) => strings(v, depth + 1));
}
function numbers(o, depth = 0) {
  if (o == null || depth > 3) return [];
  if (typeof o === "number") return [o];
  if (typeof o !== "object") return [];
  return Object.values(o).flatMap(v => numbers(v, depth + 1));
}
for (const [utt, kind, want, src] of INTENTS) {
  safe("intent", `${JSON.stringify(utt)} -> ${kind}`, () => {
    const r = plain(C.parseIntent(utt));
    if (!r || typeof r !== "object") return "not an object: " + show(r);
    if (r.kind !== kind) return `kind ${show(r.kind)} (${show(r)})`;
    if (!want) return true;
    const ss = strings(r), ns = numbers(r);
    if (want.text) {
      const w = foldJs(want.text);
      const exact = ss.filter(s => foldJs(norm(s)).replace(/[.!?]+$/, "") === w);
      const hit = exact[0] || ss.filter(s => foldJs(s).includes(w)).sort((a, b) => a.length - b.length)[0];
      if (!hit) return `no field carries ${show(want.text)}: ${show(r)}`;
      if (want.notIncludes && foldJs(hit).includes(want.notIncludes)) return `the query still carries ${show(want.notIncludes)}: ${show(hit)}`;
      if (kind === "remember" && /^\s*(jarvis|lembr|anot|guard|memoriz)/i.test(hit)) return `the fact still carries the command: ${show(hit)}`;
    }
    if (want.value && !ss.includes(want.value)) return `no field equals ${show(want.value)}: ${show(r)}`;
    if (want.num && !want.num.some(n => ns.includes(n))) return `no numeric field equals ${want.num}: ${show(r)}`;
    if (want.dir === "up") {
      const ok = ns.some(n => n > 0 && n <= 50) || ss.some(s => /^(up|mais|\+|more|inc)/i.test(s)) || ns.some(n => n === 90);
      if (!ok) return `does not say "up" (+delta, 'up' or 90): ${show(r)}`;
    }
    if (want.dir === "down") {
      const ok = ns.some(n => n < 0 && n >= -50) || ss.some(s => /^(down|menos|-|less|dec)/i.test(s)) || ns.some(n => n === 50);
      if (!ok) return `does not say "down" (-delta, 'down' or 50): ${show(r)}`;
    }
    return true;
  }, src);
}
safe("intent", "parseIntent never throws on odd input", () => {
  for (const x of ["", "   ", "⟦", "?", "Jarvis", "jarvis,", "a".repeat(5000), "😀", "\n\n"]) {
    const r = plain(C.parseIntent(x));
    if (!r || typeof r.kind !== "string") return `parseIntent(${show(x.slice(0, 20))}) -> ${show(r)}`;
  }
  return true;
}, "[spec]");
safe("intent", `table has >= 50 utterances (${INTENTS.length})`, () => INTENTS.length >= 50 || "too few", "[task]");

// ------------------------------------------------------------- journalWindow ----
// fixed today: Wednesday 2026-10-07
const TODAY = { y: 2026, m: 10, d: 7 };
const todayDate = () => vm.runInContext(`new Date(${TODAY.y}, ${TODAY.m - 1}, ${TODAY.d}, 12, 0, 0)`, ctx);
const todayStr = `${TODAY.y}-${String(TODAY.m).padStart(2, "0")}-${String(TODAY.d).padStart(2, "0")}`;
const pad = n => String(n).padStart(2, "0");
function ymd(v) {
  if (v == null) return null;
  if (typeof v === "string") return { date: v.slice(0, 10), midnight: !/T/.test(v) || /T00:00(:00(\.0+)?)?/.test(v), endOfDay: /T23:59/.test(v) };
  if (typeof v === "number") v = new Date(v);
  if (typeof v.getFullYear === "function") {
    return { date: `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`, midnight: v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0,
      endOfDay: v.getHours() === 23 && v.getMinutes() === 59 };
  }
  return null;
}
const addDays = (s, k) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function normWin(r) {
  if (r == null || r === false) return null;
  let s, e, label;
  if (Array.isArray(r)) [s, e, label] = r;
  else if (typeof r === "object") {
    s = r.start ?? r.from ?? r.begin ?? r.inicio ?? r.since ?? r.startDate;
    e = r.end ?? r.to ?? r.until ?? r.fim ?? r.endDate ?? s;
    label = r.label ?? r.name ?? r.rotulo ?? r.text;
  } else return { bad: r };
  return { start: ymd(s), end: ymd(e), label };
}
let todayArg = null;
function jw(q) {
  if (todayArg) return normWin(C.journalWindow(q, todayArg()));
  for (const mk of [todayDate, () => todayStr]) {
    try {
      const r = C.journalWindow("o que eu fiz hoje?", mk());
      if (r) { todayArg = mk; break; }
    } catch (e) { /* try the next form */ }
  }
  if (!todayArg) todayArg = todayDate;
  return normWin(C.journalWindow(q, todayArg()));
}
const JW = [
  ["o que eu fiz hoje?", ["2026-10-07", "2026-10-07"], "[ref]"], ["o que eu fiz ontem?", ["2026-10-06", "2026-10-06"], "[ref]"],
  ["o que eu perguntei anteontem?", ["2026-10-05", "2026-10-05"], "[ref]"], ["o que fiz na terça", ["2026-10-06", "2026-10-06"], "[ref]"],
  ["o que eu anotei na segunda-feira?", ["2026-10-05", "2026-10-05"], "[ref]"], ["o que eu fiz na quarta passada?", ["2026-09-30", "2026-09-30"], "[ref]"],
  ["o que conversamos no dia 3?", ["2026-10-03", "2026-10-03"], "[ref]"], ["o que eu fiz dia 28?", ["2026-09-28", "2026-09-28"], "[ref]"],
  ["o que eu fiz esta semana?", ["2026-10-05", "2026-10-07"], "[ref]"], ["o que eu fiz na semana passada?", ["2026-09-28", "2026-10-04"], "[ref]"],
  ["o que eu pesquisei na sexta?", ["2026-10-02", "2026-10-02"], "[ref]"], ["o que eu falei no domingo?", ["2026-10-04", "2026-10-04"], "[ref]"],
  ["Jarvis, o que eu fiz ontem", ["2026-10-06", "2026-10-06"], "[ref]"], ["what did I do yesterday?", ["2026-10-06", "2026-10-06"], "[ref]"],
  ["resumo da semana", ["2026-10-05", "2026-10-07"], "[task]"],
  ["quais são os critérios do RABT?", null, "[ref]"], ["o que eu fiz de errado no RTS?", null, "[ref]"], ["o que tenho hoje?", null, "[ref]"],
  ["o que eu fiz dia 31?", null, "[ref]"],
];
for (const [q, want, src] of JW) {
  safe("journal", `journalWindow(${JSON.stringify(q)}) @ ${todayStr}`, () => {
    const w = jw(q);
    if (want === null) return w === null ? true : `want null, got ${show(w)}`;
    if (!w || !w.start) return `want ${want.join("..")}, got ${show(w)}`;
    if (w.start.date !== want[0]) return `start ${w.start.date}, want ${want[0]}`;
    const e = w.end || w.start;
    const okEnd = e.date === want[1] || (e.midnight && e.date === addDays(want[1], 1) && e.date !== w.start.date);
    return okEnd ? true : `end ${e.date}, want ${want[1]} (inclusive) or ${addDays(want[1], 1)} 00:00 (exclusive)`;
  }, src);
}

// ------------------------------------------------------------- stripSources ----
function normStrip(r) {
  if (typeof r === "string") return { text: r, ids: null };
  if (Array.isArray(r)) return { text: r[0], ids: r[1] };
  if (r && typeof r === "object") {
    const text = ["text", "clean", "shown", "body", "answer", "visible", "display"].map(k => r[k]).find(v => typeof v === "string");
    const ids = ["ids", "sources", "fontes", "sourceIds", "refs"].map(k => r[k]).find(v => Array.isArray(v) || v === null);
    return { text, ids: ids === undefined ? null : ids, raw: r };
  }
  return { text: undefined, ids: null };
}
const idsEq = (got, want) => {
  if (!Array.isArray(got)) return false;
  const g = got.map(x => String(x).trim());
  return JSON.stringify(g) === JSON.stringify(want) || JSON.stringify(g) === JSON.stringify(want.map(w => w.replace(/^n/, "")));
};
const STRIP_FINAL = [
  ["Quatro critérios, senhor.\n⟦fontes: n3, n7⟧", "Quatro critérios, senhor.", ["n3", "n7"]],
  ["Quatro critérios, senhor.\n⟦fontes: n3,n7⟧\n", "Quatro critérios, senhor.", ["n3", "n7"]],
  ["Uma só fonte. ⟦fontes: n10⟧", "Uma só fonte.", ["n10"]],
  ["Conversa fiada, senhor.\n⟦fontes: —⟧", "Conversa fiada, senhor.", []],
  ["Só texto, sem marcador.", "Só texto, sem marcador.", []],
];
for (const [inp, wantText, wantIds] of STRIP_FINAL) {
  safe("strip", `final ${JSON.stringify(inp.slice(-22))}`, () => {
    const r = normStrip(plain(C.stripSources(inp)));
    if (typeof r.text !== "string") return "no text in " + show(r);
    if (norm(r.text) !== norm(wantText)) return `text ${show(r.text)}, want ${show(wantText)}`;
    if (r.text.includes("⟦") || /fontes:/i.test(r.text)) return "marker leaked: " + show(r.text);
    const ids = r.ids == null ? [] : r.ids;
    if (!idsEq(ids, wantIds)) return `ids ${show(ids)}, want ${show(wantIds)}`;
    return true;
  }, "[spec]");
}
const PARTIALS = ["Os critérios são quatro. ⟦", "Os critérios são quatro. ⟦fon", "Os critérios são quatro.\n⟦fontes: n1", "Os critérios são quatro.\n⟦fontes: n1, n"];
for (const p of PARTIALS) {
  safe("strip", `streaming partial ${JSON.stringify(p.slice(-14))} hides the marker`, () => {
    const r = normStrip(plain(C.stripSources(p)));
    if (typeof r.text !== "string") return "no text in " + show(r);
    if (r.text.includes("⟦") || /fon(tes)?\s*:?\s*n?\d*$/i.test(r.text.trim())) return "partial marker visible: " + show(r.text);
    return norm(r.text) === "Os critérios são quatro." ? true : `text ${show(r.text)}`;
  }, "[spec]");
}

// ----------------------------------------------------------- splitSentences ----
function normSplit(r) {
  if (Array.isArray(r)) return r.map(String);
  if (r && typeof r === "object") {
    const arr = ["sentences", "done", "complete", "parts", "list"].map(k => r[k]).find(Array.isArray) || [];
    const rest = ["rest", "remainder", "tail", "pending"].map(k => r[k]).find(v => typeof v === "string") || "";
    return arr.map(String).concat(rest.trim() ? [rest] : []);
  }
  return null;
}
safe("split", "three sentences", () => {
  const p = normSplit(plain(C.splitSentences("Primeira frase. Segunda frase! Terceira?")));
  const want = ["Primeira frase.", "Segunda frase!", "Terceira?"];
  return p && JSON.stringify(p.map(norm)) === JSON.stringify(want) ? true : `got ${show(p)}`;
}, "[spec]");
for (const t of ["Shock Index acima de 1,0 acende o alerta. Use 1.5 g se for o caso.", "A dose é 1 g em 10 min. Depois, 1 g em 8 h.",
  "Linha sem ponto final", "Sim, senhor… Talvez. Não!", "Primeira.\nSegunda linha sem ponto"]) {
  safe("split", `rebuilds ${JSON.stringify(t.slice(0, 28))}`, () => {
    const p = normSplit(plain(C.splitSentences(t)));
    if (!p) return "not a list";
    return norm(p.join(" ")) === norm(t) ? true : `pieces ${show(p)} do not rebuild the text`;
  }, "[spec]");
}
safe("split", "decimals do not split (1.5 g)", () => {
  const p = normSplit(plain(C.splitSentences("Shock Index acima de 1,0 acende o alerta. Use 1.5 g se for o caso.")));
  if (!p) return "not a list";
  if (p.some(x => /\d\.$/.test(norm(x)))) return "split inside a number: " + show(p);
  return p.length === 2 ? true : `want 2 sentences, got ${show(p)}`;
}, "[spec]");
safe("split", "long sentence pieces fit the iOS limit (<= 220 chars) or stay whole", () => {
  const long = "Com dois pontos ou mais aciona-se o protocolo de transfusão maciça, e convém não confundir com o ABC score, que troca o Shock Index por pressão sistólica de até 90 e frequência cardíaca de 120 ou mais, uma distinção que já poupou mais de uma passagem de plantão constrangedora.";
  const p = normSplit(plain(C.splitSentences(long)));
  if (!p) return "not a list";
  return norm(p.join(" ")) === norm(long) ? true : "pieces do not rebuild the sentence: " + show(p);
}, "[spec]");

// ------------------------------------------------------- retrieve / related ----
let RET = null; // detected call form
function idxOf(item) {
  if (typeof item === "number") return item;
  if (typeof item === "string") { const m = item.match(/(\d+)$/); return m ? +m[1] : NOTES.findIndex(n => n.label === item); }
  if (item && typeof item === "object") {
    for (const k of ["label", "title", "name"]) if (typeof item[k] === "string") { const i = NOTES.findIndex(n => n.label === item[k]); if (i >= 0) return i; }
    for (const k of ["note", "doc"]) if (item[k] && typeof item[k] === "object") { const i = idxOf(item[k]); if (i >= 0) return i; }
    for (const k of ["index", "i", "idx", "id", "ix"]) if (item[k] !== undefined) { const i = idxOf(item[k]); if (i >= 0) return i; }
  }
  return -1;
}
function retrieveForms(index) {
  return [
    ["retrieve(index, q)", q => C.retrieve(index, q)], ["retrieve(q, index)", q => C.retrieve(q, index)],
    ["retrieve(notes, q)", q => C.retrieve(notesIn(), q)], ["retrieve(q, notes)", q => C.retrieve(q, notesIn())],
  ];
}
function retrieve(q) {
  if (!RET) {
    let index;
    try { index = C.indexNotes(notesIn()); } catch (e) { index = undefined; }
    for (const [name, f] of retrieveForms(index)) {
      try {
        const r = plain(f("quais são os critérios do RABT?"));
        if (Array.isArray(r) && r.length && idxOf(r[0]) >= 0) { RET = { name, index, f }; break; }
      } catch (e) { /* next form */ }
    }
    if (!RET) throw new Error("retrieve() did not answer in any of the forms (index,q)/(q,index)/(notes,q)/(q,notes)");
  }
  return plain(RET.f(q));
}
const RETR = [
  ["quais são os critérios do RABT?", "RABT"], ["como calcula o shock index", "Shock Index"], ["qual a janela do ácido tranexâmico", "Ácido tranexâmico"],
  ["acido tranexamico", "Ácido tranexâmico"], ["protocolo de transfusão maciça", "Protocolo de transfusão maciça"], ["glasgow", "Glasgow"],
  ["o que é o NEXUS", "NEXUS"], ["iMIST-AMBO", "iMIST-AMBO"], ["configuração do iPad", "Configuração do iPad"], ["TRISS", "TRISS"],
  ["Jarvis, me explica o XABCDE", "XABCDE"], ["como calcula o RTS", "RTS"], ["o que vai na aba pós", "Aba Pós"],
];
for (const [q, label] of RETR) {
  safe("retrieve", `${JSON.stringify(q)} -> ${label} first`, () => {
    const r = retrieve(q);
    if (!Array.isArray(r) || !r.length) return "empty result: " + show(r);
    const first = idxOf(r[0]);
    if (first < 0) return "cannot read the first item: " + show(r[0]);
    if (r.length > 6) return `returned ${r.length} notes (top-6 expected)`;
    return NOTES[first].label === label ? true : `first is ${NOTES[first].label} (${RET && RET.name})`;
  }, "[ref]");
}
safe("retrieve", "unrelated query returns nothing relevant", () => {
  const r = retrieve("xyzzy qwerty plugh");
  return Array.isArray(r) && r.length === 0 ? true : "want [], got " + show(r);
}, "[ref]");
function most(text) {
  let index = RET ? RET.index : undefined;
  if (index === undefined) { try { index = C.indexNotes(notesIn()); } catch (e) { /* none */ } }
  const forms = [["(index, text)", () => C.mostRelated(index, text)], ["(text, index)", () => C.mostRelated(text, index)],
    ["(notes, text)", () => C.mostRelated(notesIn(), text)], ["(text, notes)", () => C.mostRelated(text, notesIn())]];
  if (RET && /\(q, /.test(RET.name)) forms.push(forms.shift()); // the retrieve() order hints the mostRelated() order
  let sawNull = false;
  for (const [, f] of forms) {
    try {
      const r = plain(f());
      if (r === null || r === undefined || r === -1 || r === false) { sawNull = true; continue; }
      const i = idxOf(r);
      if (i >= 0 && i < NOTES.length) return NOTES[i].label;
    } catch (e) { /* next form */ }
  }
  return sawNull ? null : "?";
}
for (const [t, want] of [["o RABT do paciente do box 3 deu 2 pontos", "RABT"], ["preciso revisar o shock index da admissão", "Shock Index"],
  ["a janela do tranexâmico conta do horário do trauma", "Ácido tranexâmico"], ["xyzzy qwerty", null], ["o carrinho de parada fica no box 3", null]]) {
  safe("related", `mostRelated(${JSON.stringify(t)}) -> ${want}`, () => { const g = most(t); return g === want ? true : `got ${show(g)}`; }, "[ref]");
}

// ------------------------------------------------------- stem / queryTerms / excerpt ----
safe("terms", "stem('transfusao') = 'transf', stem('rabt') = 'rabt'", () => (C.stem("transfusao") === "transf" && C.stem("rabt") === "rabt") || show([C.stem("transfusao"), C.stem("rabt")]), "[ref]");
safe("terms", "queryTerms('Quais são os critérios do RABT?') = ['criter','rabt']", () => {
  const g = plain(C.queryTerms("Quais são os critérios do RABT?"));
  return JSON.stringify(g) === JSON.stringify(["criter", "rabt"]) ? true : show(g);
}, "[ref]");
safe("terms", "makeExcerpt drops the H1 that repeats the title", () => { const g = C.makeExcerpt("# RABT\n\nTexto.", "RABT"); return g === "Texto." || show(g); }, "[ref]");
safe("terms", "makeExcerpt cuts long text near 700 chars with an ellipsis", () => {
  const g = C.makeExcerpt("palavra ".repeat(200), "X");
  return typeof g === "string" && g.length <= 701 && g.length >= 420 && g.endsWith("…") ? true : `length ${g && g.length}, tail ${show(g && g.slice(-12))}`;
}, "[ref]");

// ------------------------------------------------------------------ makeTitle ----
for (const [fact, want] of [["o plantão de sábado é no PS", "O plantão de sábado"], ["iMIST-AMBO deve ser preenchido em 5 minutos", "iMIST-AMBO deve ser preenchido em 5"],
  ["pH 7.2 é acidose. Outra frase", "pH 7.2 é acidose"], ["o carrinho de parada fica no box 3", "O carrinho de parada"],
  ["a reunião de residentes é às 7h na sala 2", "A reunião de residentes"], ["Usar 1,5 g de cálcio: só com dosagem", "Usar 1,5 g de cálcio"]]) {
  safe("title", `makeTitle(${JSON.stringify(fact)})`, () => { const g = C.makeTitle(fact); return g === want ? true : `got ${show(g)}, want ${show(want)}`; }, "[ref]");
}
safe("title", "makeTitle('') falls back to a non-empty title", () => { const g = C.makeTitle(""); return typeof g === "string" && g.trim() ? true : show(g); }, "[ref]");
safe("title", "makeTitle caps at 60 chars", () => {
  const g = C.makeTitle("Paralelepipedoextraordinariamentecomprido inconstitucionalissimamente anticonstitucionalissimamente palavras");
  return typeof g === "string" && g.length <= 60 ? true : show(g);
}, "[ref]");

// ------------------------------------------------------------- personaPrompt ----
safe("persona", "personaPrompt mentions the humor dial value", () => {
  let p = null;
  for (const f of [() => C.personaPrompt({ humor: 30, lang: "pt-BR" }), () => C.personaPrompt(30, "pt-BR"), () => C.personaPrompt(30)]) {
    try { p = f(); if (typeof p === "string" && /\b30\b/.test(p)) break; } catch (e) { /* next form */ }
  }
  return typeof p === "string" && /\b30\b/.test(p) ? true : "no '30' in " + show(p && String(p).slice(0, 200));
}, "[spec]");

finish();
