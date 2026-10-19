/* JARVIS test runtime: a faithful fake of the claude.ai viewer runtime.
 *
 * Injected with page.addInitScript AFTER a script that sets `window.__mockConfig`
 * (see harness.cjs). Everything is read lazily from window.__mockConfig, so a test
 * may change it at run time with page.evaluate.
 *
 * Contract source: artifact-capabilities 0.2.69 claude/sample/db/user/mcp/permissions .d.ts
 *
 * __mockConfig (all optional):
 *   noClaude        true  -> window.claude is not defined at all (file opened outside claude.ai)
 *   allNull         true  -> every use() resolves null
 *   caps            {sample,db,user,mcp,permissions}: false -> that use() resolves null
 *   useDelayMs      delay before use() resolves (default 25; always async)
 *   userId          viewer id (default "u_test123"; null = no identity)
 *   responder       (ctx) => string | {text, chunks?, modelTierApplied?, truncated?, firstDelayMs?, chunkDelayMs?} | undefined
 *   sampleError     {code, message?, text?, afterChunks?} or (ctx) => error | null
 *   sampleTierMap   {complex: "default"} -> modelTierApplied substitution
 *   sampleFirstDelayMs (80) sampleChunkDelayMs (40) sampleChunkSize (24)
 *   dbState         {path: body} initial documents (simulates a reload)
 *   dbError         {code, ops?:[...], path?: "prefix"} or (op, path, body) => error | null
 *   dbDelayMs       write/read latency (default 8)
 *   mcpErrors       {"PubMed": err, "PubMed/search_articles": err | [err, null, ...]}  (an array is consumed one item per call)
 *   mcpError        (server, tool, input, n) => error | null
 *   mcpDelayMs      default 60
 *   calendarEvents  [{summary, description?, start:"HH:MM"|"allday", end:"HH:MM"}] (default: a realistic study day)
 *   calendarEmpty   true -> list_events payload without `events`
 *   pubmedEmpty     true -> search_articles finds nothing
 *   voiceMs         number | (text) => ms   duration of each fake utterance
 *   permState       "granted" | "prompt" | "denied"
 *
 * Recording (read by the tests):
 *   window.__calls      [{cap, method, t, wall, ...}]  every capability call
 *   window.__spoken     [{text, t, lang, rate, voice, ua}] every speechSynthesis.speak
 *   window.__forbidden  [{what, t, args}] alert/confirm/prompt/open/print/SpeechRecognition/getUserMedia
 *   window.__csp        CSP violations
 *   window.__idMiss     note titles the default responder could not find an id for
 *   window.__dbExport() -> {path: body}
 */
(() => {
  "use strict";
  if (window.__mockInstalled) return;
  window.__mockInstalled = true;

  const CFG = () => (window.__mockConfig || (window.__mockConfig = {}));
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const opt = (k, d) => (has(CFG(), k) && CFG()[k] !== undefined ? CFG()[k] : d);
  const now = () => performance.now();
  const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms | 0)));
  const utf8 = s => new TextEncoder().encode(String(s)).length;
  const fold = s => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  window.__calls = [];
  window.__forbidden = [];
  window.__spoken = [];
  window.__csp = [];
  window.__idMiss = [];
  window.__firstGestureAt = null;

  function rec(cap, method, extra) {
    const e = Object.assign({ cap, method, t: now(), wall: Date.now() }, extra || {});
    window.__calls.push(e);
    return e;
  }
  function snapshotValue(v, depth = 0) {
    // keeps a JSON-ish copy of call arguments without throwing on odd values
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (v === undefined) return undefined;
    if (typeof v === "function") return "[function]";
    if (depth > 12) return "[deep]";
    if (Array.isArray(v)) return v.map(x => snapshotValue(x, depth + 1));
    if (typeof AbortSignal !== "undefined" && v instanceof AbortSignal) return "[AbortSignal]";
    if (typeof Blob !== "undefined" && v instanceof Blob) return "[Blob]";
    if (typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = snapshotValue(v[k], depth + 1);
      return o;
    }
    return String(v);
  }
  const isPlainObject = v => v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

  // ------------------------------------------------------------ gestures / CSP ----
  ["pointerdown", "mousedown", "touchstart", "keydown", "click"].forEach(type =>
    window.addEventListener(type, e => {
      if (e.isTrusted && window.__firstGestureAt == null) window.__firstGestureAt = now();
    }, { capture: true }));
  document.addEventListener("securitypolicyviolation", e => {
    window.__csp.push({ t: now(), blockedURI: e.blockedURI, directive: e.violatedDirective, source: e.sourceFile, line: e.lineNumber });
  });

  // ------------------------------------------------------- forbidden-API stubs ----
  function forbid(what, args) {
    window.__forbidden.push({ what, t: now(), args: snapshotValue(Array.from(args || [])) });
  }
  window.alert = function () { forbid("alert", arguments); };
  window.confirm = function () { forbid("confirm", arguments); return false; };
  window.prompt = function () { forbid("prompt", arguments); return null; };
  window.open = function () { forbid("window.open", arguments); return null; };
  window.print = function () { forbid("print", arguments); };
  function FakeRecognition() {
    forbid("SpeechRecognition.new", []);
    const r = this;
    r.lang = ""; r.continuous = false; r.interimResults = false;
    r.start = () => {
      forbid("SpeechRecognition.start", []);
      setTimeout(() => { try { r.onerror && r.onerror({ error: "not-allowed" }); r.onend && r.onend(); } catch (e) { console.error(e); } }, 10);
    };
    r.stop = r.abort = () => {};
    r.addEventListener = () => {};
    r.removeEventListener = () => {};
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  try {
    const gum = function () {
      forbid("getUserMedia", arguments);
      return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    };
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, writable: true, value: gum });
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, writable: true, value: gum });
    }
    navigator.getUserMedia = navigator.webkitGetUserMedia = function () { forbid("getUserMedia(legacy)", arguments); };
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------- fake voice ----
  const VOICES = Object.freeze([
    Object.freeze({ voiceURI: "Albert", name: "Albert", lang: "pt-BR", localService: true, default: false }),
    Object.freeze({ voiceURI: "Google português do Brasil", name: "Google português do Brasil", lang: "pt-BR", localService: false, default: false }),
    Object.freeze({ voiceURI: "Luciana (Enhanced)", name: "Luciana (Enhanced)", lang: "pt-BR", localService: true, default: false }),
    Object.freeze({ voiceURI: "Daniel", name: "Daniel", lang: "en-GB", localService: true, default: true }),
    Object.freeze({ voiceURI: "Samantha", name: "Samantha", lang: "en-US", localService: true, default: false }),
  ]);
  class FakeUtterance {
    constructor(text) {
      this.text = text === undefined ? "" : String(text);
      this.lang = ""; this.voice = null; this.volume = 1; this.rate = 1; this.pitch = 1;
      this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = this.onmark = null;
      Object.defineProperty(this, "_l", { value: {}, enumerable: false });
    }
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); }
    removeEventListener(type, fn) { const a = this._l[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    dispatchEvent(ev) { fire(this, ev.type, ev); return true; }
  }
  function fire(u, type, extra) {
    const ev = Object.assign({ type, utterance: u, target: u, currentTarget: u, charIndex: 0, charLength: 0, elapsedTime: 0, name: "" }, extra || {});
    const list = [u["on" + type], ...((u._l && u._l[type]) || [])].filter(f => typeof f === "function");
    for (const f of list) {
      try { f.call(u, ev); } catch (e) { console.error("[mock speech] " + type + " handler threw:", e); }
    }
  }
  const synthListeners = {};
  let queue = [], current = null, timers = [], paused = false;
  const synth = {
    get speaking() { return !!current; },
    get pending() { return queue.length > 0; },
    get paused() { return paused; },
    onvoiceschanged: null,
    getVoices() { return VOICES.slice(); },
    speak(u) {
      if (!(u instanceof FakeUtterance)) throw new TypeError("Failed to execute 'speak' on 'SpeechSynthesis': parameter 1 is not of type 'SpeechSynthesisUtterance'.");
      const entry = { text: u.text, t: now(), lang: u.lang, rate: u.rate, voice: u.voice && u.voice.name, ua: !!(navigator.userActivation && navigator.userActivation.isActive) };
      window.__spoken.push(entry);
      rec("speech", "speak", { text: u.text });
      queue.push(u);
      pump();
    },
    cancel() {
      rec("speech", "cancel", { hadCurrent: !!current, queued: queue.length });
      const cur = current, q = queue.splice(0);
      current = null;
      timers.forEach(clearTimeout); timers = [];
      if (cur) fire(cur, "error", { error: "interrupted" });
      q.forEach(u => fire(u, "error", { error: "canceled" }));
    },
    pause() { paused = true; rec("speech", "pause"); },
    resume() { paused = false; rec("speech", "resume"); setTimeout(pump, 0); },
    addEventListener(type, fn) { (synthListeners[type] || (synthListeners[type] = [])).push(fn); },
    removeEventListener(type, fn) { const a = synthListeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatchEvent() { return true; },
  };
  function durationOf(text) {
    const v = opt("voiceMs", null);
    if (!String(text).trim()) return 25;
    if (typeof v === "function") { try { return +v(text) || 200; } catch { return 200; } }
    if (typeof v === "number") return v;
    return Math.min(2000, 150 + String(text).length * 5);
  }
  function pump() {
    if (current || !queue.length) return;
    const u = current = queue.shift();
    const text = u.text, dur = durationOf(text);
    timers.push(setTimeout(() => { if (current === u) fire(u, "start"); }, 10));
    const words = [...text.matchAll(/\S+/g)];
    words.forEach((m, k) => {
      timers.push(setTimeout(() => { if (current === u) fire(u, "boundary", { name: "word", charIndex: m.index, charLength: m[0].length }); },
        10 + Math.round((dur - 20) * (k / Math.max(1, words.length)))));
    });
    timers.push(setTimeout(() => {
      if (current !== u) return;
      current = null;
      timers = [];
      fire(u, "end", { elapsedTime: dur });
      pump();
    }, dur));
  }
  try {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, get: () => synth });
    window.SpeechSynthesisUtterance = FakeUtterance;
  } catch (e) { console.error("[mock] could not install fake speech", e); }
  setTimeout(() => {
    const ev = { type: "voiceschanged" };
    try { synth.onvoiceschanged && synth.onvoiceschanged(ev); } catch (e) { console.error(e); }
    (synthListeners.voiceschanged || []).forEach(f => { try { f(ev); } catch (e) { console.error(e); } });
  }, 40);
  window.__voice = { get speaking() { return !!current; }, get current() { return current && current.text; }, get queued() { return queue.length; } };

  // ------------------------------------------------------- calendar / pubmed data ----
  const SENTINEL_DESC = "SENTINELA-ALEM-DE-6000";
  function longDescription(title, body) {
    let s = body;
    let k = 1;
    while (s.length < 6600) {
      s += `\n\nComentário ${k}: revise o tema "${title}" nas referências do serviço; a banca costuma cobrar condutas iniciais, ` +
        "indicações cirúrgicas, armadilhas de exame físico e a sequência correta de prioridades no atendimento. " +
        "Anote as dúvidas para discutir com o staff na visita.";
      k++;
    }
    return s + "\n\n" + SENTINEL_DESC + " — este trecho fica além de 6000 caracteres e não deve chegar ao modelo.";
  }
  const DEFAULT_EVENTS = [
    { summary: "📚 R+ UNIFESP — Cirurgia Torácica", start: "05:30", end: "06:30",
      description: longDescription("Cirurgia Torácica",
        "QUESTÃO DO DIA (R+ UNIFESP, Cirurgia Torácica)\nHomem de 24 anos, ferimento por arma branca no 5º espaço intercostal esquerdo, " +
        "linha hemiclavicular. PA 80x50 mmHg, FC 128 bpm, turgência jugular, bulhas abafadas. FAST com líquido no pericárdio.\n" +
        "Qual a conduta?\nA) Pericardiocentese e observação\nB) Drenagem torácica à esquerda\nC) Toracotomia/esternotomia de urgência\n" +
        "D) TC de tórax com contraste\nE) Ecocardiograma transesofágico\nGabarito: C.\n" +
        "Pérola do dia: tamponamento traumático com instabilidade é indicação de abordagem cirúrgica imediata; " +
        "a pericardiocentese é só ponte quando não há cirurgião.") },
    { summary: "🔬 Update CG — Pancreatite aguda grave", start: "06:30", end: "07:00",
      description: longDescription("Pancreatite aguda grave",
        "UPDATE DE CIRURGIA GERAL — Pancreatite aguda grave\nResumo: hidratação guiada por metas, sem antibiótico profilático, " +
        "nutrição enteral precoce, step-up para necrose infectada (drenagem percutânea antes de necrosectomia), " +
        "colecistectomia na mesma internação na pancreatite biliar leve.\nPérola: necrosectomia aberta precoce aumenta mortalidade.") },
    { summary: "Plantão PS Cirurgia Geral — HSP", start: "07:00", end: "19:00", description: "Plantão de 12 h no pronto-socorro." },
    { summary: "Aula R2: trauma de pelve", start: "19:30", end: "20:30" },
    { summary: "Inscrição da prova de título", start: "allday" },
  ];
  window.__calendarSentinel = SENTINEL_DESC;

  const ABSTRACT_SENTINEL = "SENTINELA-ABSTRACT-1200";
  function longAbstract(core) {
    let s = core;
    while (s.length < 1300) s += " Secondary outcomes included ventilator days, intensive care length of stay, abdominal wall closure rates and complications.";
    return s + " " + ABSTRACT_SENTINEL + " this tail lies beyond 1200 characters.";
  }
  const ARTICLES = {
    "31234567": {
      identifiers: { pmid: "31234567", doi: "10.1097/TA.0000000000002171" },
      title: "Damage control laparotomy in severely injured patients: outcomes from a multicenter cohort",
      abstract: longAbstract("BACKGROUND: Damage control laparotomy (DCL) is used in physiologically exhausted trauma patients. METHODS: Multicenter retrospective cohort of 1,214 adults undergoing emergent laparotomy. RESULTS: DCL was associated with lower in-hospital mortality among patients in extremis (adjusted OR 0.71)."),
      journal: { title: "The journal of trauma and acute care surgery", iso_abbreviation: "J Trauma Acute Care Surg" },
      publication_date: { year: "2019", month: "Mar", day: "12" },
      article_types: ["Journal Article", "Multicenter Study"],
    },
    "29876543": {
      identifiers: { pmid: "29876543", doi: "10.1186/s13017-018-0187-x" },
      title: "Damage control surgery versus definitive laparotomy for abdominal trauma: a systematic review and meta-analysis",
      abstract: "BACKGROUND: The benefit of damage control surgery over definitive repair remains debated. METHODS: Systematic review of 21 studies. RESULTS: Pooled mortality was lower with damage control in the most severely injured subgroup; certainty of evidence was moderate.",
      journal: { title: "World journal of emergency surgery : WJES", iso_abbreviation: "World J Emerg Surg" },
      publication_date: { year: "2018", month: "Jun", day: "4" },
      article_types: ["Journal Article", "Systematic Review", "Meta-Analysis"],
    },
    "33445566": {
      identifiers: { pmid: "33445566" },
      title: "Trends in the use of damage control laparotomy in civilian trauma centers",
      abstract: "Use of damage control laparotomy declined between 2010 and 2020 without an increase in mortality.",
      journal: { title: "American journal of surgery", iso_abbreviation: "Am J Surg" },
      publication_date: { year: "2021", month: "Jan" },
      article_types: ["Journal Article"],
    },
  };
  const PMID_ORDER = ["31234567", "29876543", "33445566"];
  window.__pubmed = { ARTICLES, ABSTRACT_SENTINEL, PMID_ORDER };

  // -------------------------------------------------------- default responder ----
  const SAMPLE_TITLES = ["Configuração do iPad", "Exportação de dados", "Ficha de Trauma", "Instalação no iPad", "Limitações do app",
    "Preenchimento assistido", "Regras do app", "Relógio do atendimento", "Glasgow", "ISS", "RABT", "RTS", "Shock Index", "TRISS",
    "E-FAST", "iMIST-AMBO", "NEXUS", "Protocolo de transfusão maciça", "Resposta a volume", "Sinais vitais da admissão",
    "Tipo de trauma", "XABCDE", "Ácido tranexâmico", "Aba Pós", "Rotina do código vermelho", "Saída da sala",
    "Plantão noturno", "Checklist do box"];
  const CANNED = {
    "RABT": "Quatro critérios, senhor, um ponto cada: mecanismo penetrante, FAST positivo, Shock Index acima de 1,0 e fratura de pelve. " +
      "Com dois pontos ou mais aciona-se o protocolo de transfusão maciça, e convém não confundir com o ABC score, que troca o Shock Index " +
      "por pressão sistólica de até 90 e frequência cardíaca de 120 ou mais, uma distinção que já poupou mais de uma passagem de plantão constrangedora. " +
      "O resto está na nota, aberta na tela.",
    "Shock Index": "O Shock Index é a frequência cardíaca dividida pela pressão sistólica da admissão, senhor. A partir de 1,0 a ficha acende o alerta vermelho.",
  };
  const SMALLTALK = "Sempre às ordens, senhor. Um mordomo nunca descansa, apenas se recompõe.";

  function findIdIn(instr, title) {
    if (!instr || !title) return null;
    const tryLine = line => {
      let m = line.match(/\bid["']?\s*[=:]\s*["'“]?([A-Za-z]{0,3}[-_]?\d+|[A-Za-z0-9_-]{1,40})["'”]?/i);
      if (m) return m[1];
      m = line.match(/[[(⟦«]\s*([A-Za-z]{1,3}[-_]?\d+)\s*[\])⟧»]/);
      if (m) return m[1];
      m = line.match(/(?:^|[\s"'<:#*(])([a-z]{1,3}[-_]?\d{1,5})(?=[\s"'>:,.;·—–)\]-]|$)/);
      if (m) return m[1];
      return null;
    };
    for (const flags of ["g", "gi"]) {
      const re = new RegExp("(^|[^\\p{L}\\p{N}])" + escRe(title) + "(?![\\p{L}\\p{N}])", flags + "u");
      let m;
      while ((m = re.exec(instr))) {
        const at = m.index + m[1].length;
        const ls = instr.lastIndexOf("\n", at) + 1;
        let le = instr.indexOf("\n", at);
        if (le < 0) le = instr.length;
        const id = tryLine(instr.slice(ls, le));
        if (id) return id;
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
    return null;
  }

  function defaultResponder(ctx) {
    const q = ctx.question || "", fq = fold(q), all = ctx.all;
    if (ctx.verb === "json") {
      const keys = [...new Set([...all.matchAll(/"([A-Za-z_][\w]*)"\s*:/g)].map(m => m[1]))];
      const want = keys.length ? keys : ["query"];
      const o = {};
      for (const k of want) {
        o[k] = /query|consulta|search|termo/i.test(k) ? "damage control laparotomy"
          : /title|titulo|título/i.test(k) ? "Plantão de sábado no PS"
            : /pmid|ids/i.test(k) ? [] : "ok";
      }
      return JSON.stringify(o);
    }
    // research answer: the articles reached the prompt
    const arts = Object.values(ARTICLES).filter(a => all.includes(a.title));
    if (arts.length) {
      return "Segundo o PubMed, a laparotomia de controle de danos segue indicada no paciente in extremis, com menor mortalidade numa coorte multicêntrica de 2019. " +
        "Uma metanálise de 2018 aponta benefício no subgrupo mais grave, com evidência de qualidade moderada.";
    }
    // a question about a note named in the question
    const titles = SAMPLE_TITLES.filter(t => new RegExp("(^|[^a-z0-9])" + escRe(fold(t)) + "($|[^a-z0-9])").test(fq))
      .sort((a, b) => b.length - a.length);
    if (titles.length && ctx.isChat && !/\b(fiz|perguntei|anotei|pesquisei)\b/.test(fq)) {
      const t = titles[0];
      const id = findIdIn(ctx.instructions, t);
      if (!id) { window.__idMiss.push(t); return (CANNED[t] || `A nota ${t} cobre isso, senhor.`) + "\n⟦fontes: —⟧"; }
      return (CANNED[t] || `A nota ${t} cobre isso, senhor; os detalhes estão abertos na tela.`) + `\n⟦fontes: ${id}⟧`;
    }
    // journal
    if (/\b(fiz|perguntei|anotei|pesquisei|conversamos)\b/.test(fq)) {
      return "Hoje o senhor me perguntou sobre o RABT e o Shock Index, senhor. Nenhuma memória nova até agora." + (ctx.isChat ? "\n⟦fontes: —⟧" : "");
    }
    // memory confirmation / title
    if (/plant[aã]o de s[aá]bado/i.test(all) && /lembr|mem[oó]ri|anot|guard|confirm/i.test(all)) {
      return "Anotado, senhor: plantão de sábado no PS. Prometo lembrar com mais constância do que o senhor.";
    }
    // briefing: today's events reached the prompt
    if (/Cirurgia Tor[aá]cica|Pancreatite aguda grave|Plant[aã]o PS Cirurgia/.test(all)) {
      return "Hoje há R+ UNIFESP de Cirurgia Torácica às 5h30 e o Update CG sobre pancreatite aguda grave, senhor. Depois, plantão no PS até as 19h.";
    }
    return SMALLTALK + (ctx.isChat ? "\n⟦fontes: —⟧" : "");
  }
  window.__mockDefaultResponder = defaultResponder;
  window.__mockFindId = findIdIn;

  // ---------------------------------------------------------------- sample ----
  const TIERS = ["default", "complex", "quick"];
  function sampleErr(code, message, text) {
    const e = { code, message: message || code };
    if (text !== undefined && text !== null && text !== "") e.text = text;
    return e;
  }
  function validateSample(input, options) {
    if (typeof input === "string") {
      if (!input.trim()) return "input is empty";
    } else if (Array.isArray(input)) {
      if (!input.length) return "input is an empty turn list";
      for (let i = 0; i < input.length; i++) {
        const t = input[i];
        if (!isPlainObject(t)) return `turn ${i} is not a plain object`;
        if (t.role !== "user" && t.role !== "assistant") return `turn ${i} has role ${JSON.stringify(t.role)}`;
        if (typeof t.content !== "string") return `turn ${i} content is not a string`;
        if (!t.content.trim()) return `turn ${i} has empty content`;
      }
      if (input[0].role !== "user") return "turns must START on a user turn";
      if (input[input.length - 1].role !== "user") return "turns must END on a user turn";
    } else {
      return "input must be a string or an array of turns (the 0.2 {prompt} object form is gone)";
    }
    if (options === undefined) return null;
    if (!isPlainObject(options)) return "options must be a plain object";
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return "signal must be an AbortSignal (pass ctl.signal, not the controller)";
    if (options.onText !== undefined && typeof options.onText !== "function") return "onText must be a function";
    if (options.modelTier !== undefined && !TIERS.includes(options.modelTier)) return `unknown modelTier ${JSON.stringify(options.modelTier)}`;
    const c = options.cache;
    if (c !== undefined && c !== true && c !== false) {
      if (!isPlainObject(c)) return "cache must be true, false or {gcTime?, refresh?}";
      if (c.gcTime !== undefined && !(typeof c.gcTime === "number" && isFinite(c.gcTime) && c.gcTime > 0)) return "cache.gcTime must be a finite number > 0";
      if (c.refresh !== undefined && typeof c.refresh !== "boolean") return "cache.refresh must be a boolean";
    }
    if (options.tools !== undefined && options.cache !== undefined && options.cache !== false) return "cache passed with tools";
    return null;
  }
  function inputBytes(input) {
    return typeof input === "string" ? utf8(input) : input.reduce((n, t) => n + utf8(t.content), 0);
  }
  function chunkText(text, size, markerAt) {
    const cuts = new Set();
    for (let i = size; i < text.length; i += size) cuts.add(i);
    if (markerAt >= 0) { cuts.add(markerAt + 4); cuts.add(markerAt + 1); }
    const pts = [0, ...[...cuts].filter(i => i > 0 && i < text.length).sort((a, b) => a - b), text.length];
    let out = [];
    for (let i = 0; i < pts.length - 1; i++) out.push(text.slice(pts[i], pts[i + 1]));
    out = out.filter(Boolean);
    while (out.length > 1 && !out[0].trim()) out.splice(0, 2, out[0] + out[1]); // first call must carry visible text
    return out;
  }
  function tolerantJson(text) {
    const tryParse = s => { try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } };
    let r = tryParse(text.trim());
    if (r.ok) return r;
    const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
    if (fence) { r = tryParse(fence[1].trim()); if (r.ok) return r; }
    const a = text.search(/[[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (a >= 0 && b > a) { r = tryParse(text.slice(a, b + 1)); if (r.ok) return r; }
    return { ok: false };
  }
  let sampleN = 0;
  function runSample(verb, input, options) {
    const idx = ++sampleN;
    let entry;
    try {
      entry = rec("sample", verb, {
        idx, input: snapshotValue(input),
        opts: options === undefined ? undefined : isPlainObject(options) ? {
          modelTier: options.modelTier, cache: snapshotValue(options.cache), hasSignal: options.signal !== undefined,
          hasOnText: typeof options.onText === "function", tools: options.tools !== undefined, images: options.images !== undefined,
          keys: Object.keys(options),
        } : "[not a plain object]",
      });
    } catch (e) { entry = rec("sample", verb, { idx, input: "[unrecordable]" }); }
    return new Promise((resolve, reject) => {
      let settled = false, soFar = "", aborted = false;
      const done = (ok, v) => {
        if (settled) return;
        settled = true;
        entry.tEnd = now();
        entry.status = ok ? "resolved" : v.code;
        if (ok) entry.text = verb === "json" ? entry.text : v.text;
        (ok ? resolve : reject)(v);
      };
      queueMicrotask(async () => {
        try {
          const bad = validateSample(input, options);
          if (bad) return done(false, sampleErr("invalid_request", bad));
          const o = options || {};
          if (o.images !== undefined) return done(false, sampleErr("images_unavailable", "this view cannot send images"));
          if (o.tools !== undefined) return done(false, sampleErr("tools_unavailable", "this view cannot run page tools"));
          if (inputBytes(input) > 262144) return done(false, sampleErr("prompt_too_large", "input over 256 KiB"));
          const signal = o.signal;
          if (signal && signal.aborted) return done(false, sampleErr("cancelled", "signal already aborted"));
          if (signal) signal.addEventListener("abort", () => { aborted = true; done(false, sampleErr("cancelled", "aborted", soFar)); }, { once: true });

          const turns = typeof input === "string" ? [{ role: "user", content: input }] : input.map(t => ({ role: t.role, content: t.content }));
          const ctx = {
            verb, idx, input: snapshotValue(input), modelTier: o.modelTier || "default", turns,
            isChat: Array.isArray(input) && input.length > 1,
            instructions: turns[0].content, question: turns[turns.length - 1].content,
            all: turns.map(t => t.content).join("\n\n"),
            findId: title => findIdIn(turns[0].content, title),
            defaultReply: c => defaultResponder(c || ctx),
          };
          entry.tier = ctx.modelTier;

          let err = opt("sampleError", null);
          if (typeof err === "function") err = err(ctx);
          let res = null;
          const responder = opt("responder", null);
          if (typeof responder === "function") res = responder(ctx);
          if (res === undefined || res === null) res = defaultResponder(ctx);
          if (typeof res === "string") res = { text: res };
          const text = String(res.text == null ? "" : res.text);
          const tierMap = opt("sampleTierMap", {}) || {};
          const applied = res.modelTierApplied || tierMap[ctx.modelTier] || ctx.modelTier;

          await wait(res.firstDelayMs != null ? res.firstDelayMs : opt("sampleFirstDelayMs", 80));
          if (settled) return;
          if (err && !(err.afterChunks > 0)) return done(false, sampleErr(err.code, err.message, err.text));
          if (!text.trim()) return done(false, sampleErr("empty_completion", "Claude produced no text"));
          const chunks = Array.isArray(res.chunks) ? res.chunks.filter(Boolean) : chunkText(text, opt("sampleChunkSize", 24), text.indexOf("⟦"));
          const delay = res.chunkDelayMs != null ? res.chunkDelayMs : opt("sampleChunkDelayMs", 40);
          for (let k = 0; k < chunks.length; k++) {
            if (k) await wait(delay);
            if (settled || aborted) return;
            if (err && err.afterChunks > 0 && k >= err.afterChunks) {
              return done(false, sampleErr(err.code, err.message, err.code === "refused" ? undefined : soFar));
            }
            const delta = chunks[k];
            soFar += delta;
            entry.streamed = soFar.length;
            if (typeof o.onText === "function") {
              try {
                const r = o.onText({ text: soFar, delta });
                if (r && typeof r.then === "function") r.then(null, e => console.error("[mock sample] onText rejected:", e));
              } catch (e) { console.error("[mock sample] onText threw:", e); }
            }
          }
          if (settled) return;
          entry.text = soFar;
          if (verb === "json") {
            const p = tolerantJson(soFar);
            if (!p.ok) return done(false, sampleErr("invalid_json", "no JSON value in the reply", soFar));
            entry.json = p.v;
            return done(true, p.v);
          }
          done(true, { text: soFar, truncated: !!res.truncated, modelTierApplied: applied });
        } catch (e) {
          console.error("[mock sample] internal error", e);
          done(false, sampleErr("upstream_error", String(e && e.message || e)));
        }
      });
    });
  }
  const sample = function sample(input, options) { return runSample("sample", input, options); };
  sample.json = function json(input, options) { return runSample("json", input, options); };
  sample.limits = function limits() { rec("sample", "limits"); return wait(5).then(() => ({ maxPromptBytes: 262144 })); };
  Object.freeze(sample.json); Object.freeze(sample.limits); Object.freeze(sample);

  // -------------------------------------------------------------------- db ----
  const SEG_RE = /^[A-Za-z0-9_\-.~:@+]+$/;
  const DB_OPS = ["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains"];
  function parsePath(path, kind) {
    if (typeof path !== "string") throw new TypeError(`${kind}(): the path must be a string (got ${path && typeof path.then === "function" ? "a Promise — await user.id() first" : typeof path})`);
    const segs = path.split("/");
    for (const s of segs) {
      if (!s) throw new TypeError(`${kind}(): empty path segment in "${path}"`);
      if (s === "." || s === ".." || !SEG_RE.test(s)) throw new TypeError(`${kind}(): invalid path segment "${s}" in "${path}"`);
      if (utf8(s) > 200) throw new TypeError(`${kind}(): path segment over 200 bytes`);
    }
    if (utf8(path) > 1000 || segs.length > 16) throw new TypeError(`${kind}(): path too long`);
    const even = segs.length % 2 === 0;
    if (kind === "doc" && !even) throw new TypeError(`doc(): a document path needs an EVEN number of segments; "${path}" has ${segs.length}`);
    if (kind === "collection" && even) throw new TypeError(`collection(): a collection path needs an ODD number of segments; "${path}" has ${segs.length}`);
    return segs;
  }
  const store = new Map(); // path -> {data (frozen), snap}
  const deepFreeze = o => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  function checkBody(body, depth = 0) {
    if (depth > 32) return "document deeper than 32 levels";
    if (body === null || typeof body === "string" || typeof body === "boolean") return null;
    if (typeof body === "number") return isFinite(body) ? null : "non-finite number";
    if (typeof body === "undefined") return null; // dropped like JSON.stringify (recorded as a warning)
    if (typeof body === "function" || typeof body === "symbol" || typeof body === "bigint") return `a ${typeof body} is not JSON`;
    if (Array.isArray(body)) { for (const v of body) { const e = checkBody(v, depth + 1); if (e) return e; } return null; }
    if (!isPlainObject(body)) return `a ${Object.prototype.toString.call(body)} is not plain JSON`;
    for (const k of Object.keys(body)) { const e = checkBody(body[k], depth + 1); if (e) return e; }
    return null;
  }
  const uid = () => (has(CFG(), "userId") ? CFG().userId : "u_test123");
  function privateViolation(path) {
    const m = path.match(/^data\/users\/([^/]+)/);
    return m && m[1] !== uid();
  }
  function dbErr(code, message) { return { code, message: message || code }; }
  function injectedDbError(op, path, body) {
    let e = opt("dbError", null);
    if (typeof e === "function") e = e(op, path, body);
    if (!e) return null;
    if (e.ops && !e.ops.includes(op)) return null;
    if (e.path && !path.startsWith(e.path)) return null;
    return dbErr(e.code, e.message);
  }
  function mkSnap(path, rec_) {
    const id = path.split("/").pop();
    if (!rec_) return Object.freeze({ id, exists: false, data: () => undefined, metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) });
    const data = rec_.data;
    return Object.freeze({ id, exists: true, data: () => data, metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) });
  }
  function getSnap(path) {
    if (privateViolation(path)) return mkSnap(path, null);
    const r = store.get(path);
    if (!r) return missingSnaps.get(path) || missingSnaps.set(path, mkSnap(path, null)).get(path);
    return r.snap;
  }
  const missingSnaps = new Map();
  function writeDoc(path, data) {
    if (data === undefined) { store.delete(path); }
    else {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(data)));
      const r = { data: frozen };
      r.snap = mkSnap(path, r);
      store.set(path, r);
    }
    scheduleNotify();
  }
  function mergeDeep(base, patch) {
    const out = Object.assign({}, base);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  // import the initial state (a "reload" of a previous session)
  (() => {
    const st = opt("dbState", null);
    if (!st) return;
    for (const [p, body] of Object.entries(st)) {
      try { parsePath(p, "doc"); writeDoc(p, body); } catch (e) { console.warn("[mock db] bad dbState path", p, e.message); }
    }
  })();
  window.__dbExport = () => { const o = {}; for (const [p, r] of store) o[p] = JSON.parse(JSON.stringify(r.data)); return o; };
  window.__dbSubs = {};

  const subs = new Set();
  let notifyPending = false;
  function scheduleNotify() {
    if (notifyPending) return;
    notifyPending = true;
    setTimeout(() => { notifyPending = false; for (const s of [...subs]) deliver(s, false); }, 0);
  }
  function childrenOf(collPath) {
    const n = collPath.split("/").length + 1, pre = collPath + "/";
    const out = [];
    for (const p of store.keys()) if (p.startsWith(pre) && p.split("/").length === n && !privateViolation(p)) out.push(p);
    return out;
  }
  function cmp(a, b) {
    if (a === b) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (typeof a === typeof b) return a < b ? -1 : 1;
    const order = ["boolean", "number", "string", "object"];
    return order.indexOf(typeof a) - order.indexOf(typeof b);
  }
  function testWhere(v, op, x) {
    switch (op) {
      case "==": return JSON.stringify(v) === JSON.stringify(x);
      case "!=": return v !== undefined && JSON.stringify(v) !== JSON.stringify(x);
      case "<": return v !== undefined && typeof v === typeof x && v < x;
      case "<=": return v !== undefined && typeof v === typeof x && v <= x;
      case ">": return v !== undefined && typeof v === typeof x && v > x;
      case ">=": return v !== undefined && typeof v === typeof x && v >= x;
      case "in": return Array.isArray(x) && x.some(y => JSON.stringify(y) === JSON.stringify(v));
      case "not-in": return v !== undefined && Array.isArray(x) && !x.some(y => JSON.stringify(y) === JSON.stringify(v));
      case "array-contains": return Array.isArray(v) && v.some(y => JSON.stringify(y) === JSON.stringify(x));
    }
    return false;
  }
  function validateQuery(q) {
    if (q.wheres.length > 10) return "too many filters";
    for (const w of q.wheres) {
      if (!DB_OPS.includes(w.op)) return `unknown operator ${w.op}`;
      if ((w.op === "in" || w.op === "not-in") && (!Array.isArray(w.value) || w.value.length > 30)) return `${w.op} needs an array of at most 30`;
      if (typeof w.field !== "string" || !w.field) return "where() needs a field";
    }
    if (q.orders.length > 1) return "at most one orderBy";
    if (q.orders.length && !["asc", "desc"].includes(q.orders[0].dir)) return "orderBy dir must be asc|desc";
    if (q.lim !== null && !(Number.isInteger(q.lim) && q.lim >= 1 && q.lim <= 1000)) return "limit must be an integer 1-1000";
    return null;
  }
  function runQuery(q) {
    let paths = childrenOf(q.path);
    let snaps = paths.map(getSnap).filter(s => s.exists);
    snaps = snaps.filter(s => q.wheres.every(w => testWhere(s.data()[w.field], w.op, w.value)));
    if (q.orders.length) {
      const { field, dir } = q.orders[0];
      snaps.sort((a, b) => {
        const va = a.data()[field], vb = b.data()[field];
        if (va === undefined && vb !== undefined) return 1;
        if (vb === undefined && va !== undefined) return -1;
        const c = cmp(va, vb) * (dir === "desc" ? -1 : 1);
        return c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
    } else snaps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (q.lim !== null) snaps = snaps.slice(0, q.lim);
    return snaps;
  }
  function querySnapshot(docs, changes) {
    const arr = Object.freeze(docs.slice());
    const ch = Object.freeze(changes.slice());
    return Object.freeze({ docs: arr, size: arr.length, empty: arr.length === 0, docChanges: () => ch, forEach: f => arr.forEach(f),
      metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) });
  }
  function deliver(s, initial) {
    if (!s.active) return;
    try {
      if (s.kind === "doc") {
        const snap = getSnap(s.path);
        if (!initial && snap === s.last) return;
        s.last = snap;
        s.deliveries++;
        s.next(snap);
      } else {
        const err = validateQuery(s.q);
        if (err) { s.active = false; subs.delete(s); s.error ? s.error(dbErr("invalid_argument", err)) : reportError(dbErr("invalid_argument", err)); return; }
        const cur = runQuery(s.q), prev = s.last || [];
        const changes = [];
        const prevIdx = new Map(prev.map((d, i) => [d.id, i])), curIdx = new Map(cur.map((d, i) => [d.id, i]));
        prev.forEach((d, i) => { if (!curIdx.has(d.id)) changes.push({ type: "removed", doc: d, oldIndex: i, newIndex: -1 }); });
        cur.forEach((d, i) => {
          if (!prevIdx.has(d.id)) changes.push({ type: "added", doc: d, oldIndex: -1, newIndex: i });
          else if (prev[prevIdx.get(d.id)] !== d) changes.push({ type: "modified", doc: d, oldIndex: prevIdx.get(d.id), newIndex: i });
        });
        if (!initial && !changes.length) return;
        s.last = cur;
        s.deliveries++;
        s.next(querySnapshot(cur, changes.map(c => Object.freeze(c))));
      }
    } catch (e) { console.error("[mock db] snapshot callback threw:", e); }
  }
  function subscribe(kind, path, q, next, error) {
    if (typeof next !== "function") throw new TypeError("onSnapshot(next): next must be a function");
    const key = path + (q && (q.wheres.length || q.orders.length || q.lim !== null) ? " ?" + JSON.stringify([q.wheres, q.orders, q.lim]) : "");
    const info = window.__dbSubs[key] || (window.__dbSubs[key] = { total: 0, active: 0 });
    info.total++; info.active++;
    rec("db", "onSnapshot", { path, kind });
    const s = { kind, path, q, next, error, active: true, last: null, deliveries: 0 };
    subs.add(s);
    setTimeout(() => {
      const e = injectedDbError("onSnapshot", path, null);
      if (e) { s.active = false; subs.delete(s); info.active--; (error || reportError)(e); return; }
      deliver(s, true);
    }, opt("subDelayMs", 15));
    return () => { if (s.active) { s.active = false; subs.delete(s); info.active--; } };
  }
  function docRef(path) {
    const segs = parsePath(path, "doc");
    const id = segs[segs.length - 1];
    const op = (name, body, fn) => {
      const entry = rec("db", name, { path, body: snapshotValue(body) });
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            const inj = injectedDbError(name, path, body);
            if (inj) { entry.status = inj.code; return reject(inj); }
            const v = fn();
            entry.status = "ok";
            resolve(v);
          } catch (e) {
            entry.status = e && e.code || "error";
            reject(e && e.code ? e : dbErr("invalid_argument", String(e && e.message || e)));
          }
        }, opt("dbDelayMs", 8));
      });
    };
    const ref = {
      id, path,
      get: () => op("get", undefined, () => getSnap(path)),
      set: data => op("set", data, () => {
        if (!isPlainObject(data)) throw dbErr("invalid_argument", "set() body must be a plain object");
        const bad = checkBody(data); if (bad) throw dbErr("invalid_argument", bad);
        if (utf8(JSON.stringify(data)) > 262144) throw dbErr("invalid_argument", "document over 256 KiB");
        if (privateViolation(path)) throw dbErr("invalid_argument", "write into another viewer's subtree");
        writeDoc(path, data);
      }),
      update: data => op("update", data, () => {
        if (!isPlainObject(data)) throw dbErr("invalid_argument", "update() body must be a plain object");
        const bad = checkBody(data); if (bad) throw dbErr("invalid_argument", bad);
        if (privateViolation(path) || !store.has(path)) throw dbErr("invalid_argument", "update() requires the document to exist");
        const merged = mergeDeep(JSON.parse(JSON.stringify(store.get(path).data)), JSON.parse(JSON.stringify(data)));
        if (utf8(JSON.stringify(merged)) > 262144) throw dbErr("invalid_argument", "document over 256 KiB");
        writeDoc(path, merged);
      }),
      delete: () => op("delete", undefined, () => {
        if (privateViolation(path)) throw dbErr("invalid_argument", "write into another viewer's subtree");
        if (store.has(path)) writeDoc(path, undefined);
      }),
      acquire: o => op("acquire", o, () => ({ acquired: true, version: 1, expiresAt: new Date(Date.now() + 30000).toISOString(), holder: o && o.holder })),
      onSnapshot: (next, error) => subscribe("doc", path, null, next, error),
      collection: sub => collRef(path + "/" + sub),
    };
    return ref;
  }
  function query(path, q) {
    const self = {
      where: (field, op, value) => query(path, Object.assign({}, q, { wheres: q.wheres.concat([{ field, op, value }]) })),
      orderBy: (field, dir) => query(path, Object.assign({}, q, { orders: q.orders.concat([{ field, dir: dir || "asc" }]) })),
      limit: n => query(path, Object.assign({}, q, { lim: n })),
      get: () => {
        const entry = rec("db", "query.get", { path, q: snapshotValue(q) });
        return new Promise((resolve, reject) => setTimeout(() => {
          const inj = injectedDbError("get", path, null);
          if (inj) { entry.status = inj.code; return reject(inj); }
          const err = validateQuery(q);
          if (err) { entry.status = "invalid_argument"; return reject(dbErr("invalid_argument", err)); }
          const docs = runQuery(q);
          entry.status = "ok";
          resolve(querySnapshot(docs, docs.map((d, i) => Object.freeze({ type: "added", doc: d, oldIndex: -1, newIndex: i }))));
        }, opt("dbDelayMs", 8)));
      },
      onSnapshot: (next, error) => subscribe("query", path, q, next, error),
    };
    return self;
  }
  function randomId() {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 20; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }
  function collRef(path) {
    parsePath(path, "collection");
    const q = query(path, { path, wheres: [], orders: [], lim: null });
    return Object.assign(q, {
      path,
      id: path.split("/").pop(),
      doc: id => docRef(path + "/" + (id === undefined ? randomId() : id)),
      add: data => { const r = docRef(path + "/" + randomId()); return r.set(data).then(() => r); },
    });
  }
  const db = Object.freeze({ doc: p => docRef(p), collection: p => collRef(p) });

  // ------------------------------------------------------------------ user ----
  const userNs = Object.freeze({
    isOwner: () => (rec("user", "isOwner"), wait(3).then(() => true)),
    canEdit: () => (rec("user", "canEdit"), wait(3).then(() => true)),
    can: name => (rec("user", "can", { name }), wait(3).then(() => true)),
    id: () => (rec("user", "id"), wait(3).then(() => uid())),
    me: () => (rec("user", "me"), wait(3).then(() => ({ id: uid(), name: "", avatarUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", color: "#7aa2f7", email: null, isOwner: true, canEdit: true }))),
    profiles: ids => (rec("user", "profiles"), wait(3).then(() => { const o = {}; [].concat(ids || []).forEach(i => { o[i] = { id: i, name: "", avatarUrl: "data:,", color: "#888", email: null, isMe: i === uid(), guest: false }; }); return o; })),
    name: () => wait(3).then(() => ""),
    avatarUrl: () => wait(3).then(() => null),
    search: () => wait(3).then(() => []),
    email: () => wait(3).then(() => null),
  });

  // ------------------------------------------------------------------- mcp ----
  const MANIFEST = { "Google Calendar": ["list_events"], "PubMed": ["search_articles", "get_article_metadata"] };
  const mcpCount = {};
  const seqUsed = new WeakMap();
  function mcpErr(e, server) {
    const o = { code: e.code, message: e.message || e.code };
    if (server) o.server = server;
    if (e.retryable) o.retryable = true;
    if (e.retryAfterMs !== undefined) o.retryAfterMs = e.retryAfterMs;
    if (e.result !== undefined) o.result = e.result;
    return o;
  }
  function strictJson(v, depth = 0) {
    if (depth > 64) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return isFinite(v);
    if (Array.isArray(v)) return v.every(x => strictJson(x, depth + 1));
    if (isPlainObject(v)) return Object.keys(v).every(k => v[k] === undefined || strictJson(v[k], depth + 1));
    return false;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function localOffset(d) {
    const m = -d.getTimezoneOffset();
    return (m >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(m) / 60)) + ":" + pad(Math.abs(m) % 60);
  }
  function listEvents(input) {
    const tz = (input && input.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let date, off;
    const m = input && typeof input.startTime === "string" && input.startTime.match(/^(\d{4}-\d{2}-\d{2})T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      const d = new Date(input.startTime);
      if (!m[2] || m[2] === "Z") { date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; off = localOffset(d); }
      else { date = m[1]; off = m[2].length === 5 ? m[2].slice(0, 3) + ":" + m[2].slice(3) : m[2]; }
    } else {
      const d = new Date();
      date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; off = localOffset(d);
    }
    const next = new Date(date + "T12:00:00"); next.setDate(next.getDate() + 1);
    const nextDate = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
    const payload = { accessRole: "owner", summary: "Agenda do Marcos", timeZone: tz };
    if (opt("calendarEmpty", false)) return payload;
    const src = opt("calendarEvents", null) || DEFAULT_EVENTS;
    payload.events = src.map((e, i) => {
      const ev = { id: "evt" + (1000 + i), summary: e.summary, status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=evt" + (1000 + i),
        created: "2026-09-01T10:00:00.000Z", updated: "2026-09-01T10:00:00.000Z", organizer: { self: true }, creator: { self: true } };
      if (e.description) ev.description = e.description;
      if (e.start === "allday") { ev.start = { date }; ev.end = { date: nextDate }; }
      else { ev.start = { dateTime: `${date}T${e.start}:00${off}`, timeZone: tz }; ev.end = { dateTime: `${date}T${e.end}:00${off}`, timeZone: tz }; }
      return ev;
    });
    return payload;
  }
  function searchArticles(input) {
    const query = input && input.query;
    if (opt("pubmedEmpty", false)) return { pmids: [], total_count: 0, returned_count: 0, query, has_more: false };
    const max = Math.max(1, Math.min(+(input && input.max_results) || 20, 20));
    const pmids = PMID_ORDER.slice(0, max); // relevance order (integer-like keys would sort numerically)
    return { pmids, total_count: 148, returned_count: pmids.length, query, has_more: true };
  }
  function articleMetadata(input) {
    const ids = [].concat((input && (input.pmids || input.pmid || input.ids)) || []).map(String);
    const articles = ids.map(id => ARTICLES[id]).filter(Boolean).map(a => JSON.parse(JSON.stringify(a)));
    return { articles, count: articles.length };
  }
  function callTool(server, tool, input, options) {
    const key = `${server}/${tool}`;
    const n = (mcpCount[key] = (mcpCount[key] || 0) + 1);
    const entry = rec("mcp", "callTool", { server, tool, input: snapshotValue(input), n });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, v) => { if (settled) return; settled = true; entry.tEnd = now(); entry.status = ok ? "ok" : v.code; (ok ? resolve : reject)(v); };
      queueMicrotask(async () => {
        try {
          if (typeof server !== "string" || typeof tool !== "string") return done(false, mcpErr({ code: "bad_request", message: "server and tool must be strings" }));
          if (input !== undefined && !strictJson(input)) return done(false, mcpErr({ code: "bad_request", message: "input is not plain JSON" }, server));
          if (options !== undefined && !isPlainObject(options)) return done(false, mcpErr({ code: "bad_request", message: "options must be a plain object" }, server));
          const signal = options && options.signal;
          if (signal && signal.aborted) return done(false, mcpErr({ code: "cancelled", message: "aborted" }, server));
          if (signal) signal.addEventListener("abort", () => done(false, mcpErr({ code: "cancelled", message: "aborted" }, server)), { once: true });
          if (!MANIFEST[server] || !MANIFEST[server].includes(tool)) return done(false, mcpErr({ code: "not_in_manifest", message: `${key} is outside the manifest` }, server));
          await wait(opt("mcpDelayMs", 60));
          if (settled) return;
          let e = null;
          const fn = opt("mcpError", null);
          if (typeof fn === "function") e = fn(server, tool, input, n);
          const map = opt("mcpErrors", null) || {};
          if (!e) {
            const v = map[key] !== undefined ? map[key] : map[server];
            if (Array.isArray(v)) { const k = seqUsed.get(v) || 0; seqUsed.set(v, k + 1); e = v[k] || null; } // a fresh array starts at its first item
            else e = v || null;
          }
          if (e) return done(false, mcpErr(e, server));
          let payload;
          if (tool === "list_events") payload = listEvents(input);
          else if (tool === "search_articles") payload = searchArticles(input);
          else if (tool === "get_article_metadata") payload = articleMetadata(input);
          entry.payload = payload;
          done(true, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, payload });
        } catch (err) {
          console.error("[mock mcp] internal error", err);
          done(false, mcpErr({ code: "upstream_error", message: String(err && err.message || err) }, server));
        }
      });
    });
  }
  const mcpNs = Object.freeze({
    callTool,
    listTools: server => {
      rec("mcp", "listTools", { server });
      const servers = Object.entries(MANIFEST).filter(([s]) => !server || s === server).map(([s, tools]) => ({
        server: s, kind: "connector", authStatus: "connected", tools: tools.map(name => ({ name, description: "", annotations: { readOnlyHint: true } })) }));
      return wait(10).then(() => ({ servers }));
    },
    server: name => {
      rec("mcp", "server", { name });
      if (!MANIFEST[name]) return Promise.reject(mcpErr({ code: "server_not_connected", message: "no such server" }, name));
      const h = {};
      MANIFEST[name].forEach(t => { h[t] = (input, o) => callTool(name, t, input, o).then(r => r.payload); });
      return wait(5).then(() => Object.freeze(h));
    },
    describeTool: (server, tool) => (rec("mcp", "describeTool", { server, tool }), Promise.reject(mcpErr({ code: "bad_request", message: "no schema" }, server))),
    watchTool: (server, tool, input, handler) => {
      if (typeof handler !== "function") throw new TypeError("watchTool: handler must be a function");
      rec("mcp", "watchTool", { server, tool, input: snapshotValue(input) });
      let live = true;
      callTool(server, tool, input).then(r => { if (live) handler({ type: "data", result: r }); }, e => { if (live) handler({ type: "error", error: e }); });
      return () => { live = false; };
    },
    invalidate: () => (rec("mcp", "invalidate"), Promise.resolve()),
  });

  // ----------------------------------------------------------- permissions ----
  const permNs = Object.freeze({
    state: name => {
      rec("permissions", "state", { name });
      const st = opt("permState", "granted");
      if (name === undefined) return wait(3).then(() => ({ sample: st, db: "granted", user: "granted", mcp: st, "mcp:Google Calendar": st, "mcp:PubMed": st }));
      return wait(3).then(() => (/^(sample|db|user|mcp|permissions)(:|$)/.test(name) ? st : "unavailable"));
    },
    request: names => {
      rec("permissions", "request", { names: snapshotValue(names) });
      const st = opt("permState", "granted");
      const o = {};
      [].concat(names || ["sample", "db", "user", "mcp"]).forEach(n => { o[n] = st; });
      return wait(5).then(() => o);
    },
    manage: () => (rec("permissions", "manage"), wait(5)),
  });

  // ---------------------------------------------------------------- claude ----
  const NAMESPACES = { sample, db, user: userNs, mcp: mcpNs, permissions: permNs };
  const memo = {};
  function use(name) {
    rec("claude", "use", { name });
    const delay = opt("useDelayMs", 25);
    const capsCfg = opt("caps", {}) || {};
    const ok = !opt("allNull", false) && has(NAMESPACES, name) && capsCfg[name] !== false;
    if (!ok) return new Promise(r => setTimeout(() => r(null), delay));
    if (!memo[name]) memo[name] = new Promise(r => setTimeout(() => r(NAMESPACES[name]), delay));
    return memo[name];
  }
  if (!opt("noClaude", false)) {
    Object.defineProperty(window, "claude", { configurable: true, enumerable: true, writable: false, value: Object.freeze({ use }) });
  }
})();
