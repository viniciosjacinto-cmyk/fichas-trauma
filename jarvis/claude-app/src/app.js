/* JARVIS · app: DOM, galáxia, voz e capabilities (sample, db, user, mcp).
   Tudo renderiza sem as capabilities; cada recurso acende quando a sua resolve. */
(function () {
  "use strict";
  var C = window.JarvisCore;
  if (!C) return;

  // ------------------------------------------------------------ utilidades ----
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function mq(q) {
    try { return window.matchMedia(q); } catch (e) { return { matches: false }; }
  }
  var REDUCED = mq("(prefers-reduced-motion: reduce)");
  var COARSE = mq("(pointer: coarse)");
  var PHONE = mq("(max-width: 640px)"); // celular: o painel vira folha inferior
  var IS_MAC = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "");
  var LS = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } }
  };
  function readJSON(k, fallback) {
    var s = LS.get(k);
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }
  var LSK = { settings: "jarvis.v1.settings", memories: "jarvis.v1.memories", notes: "jarvis.v1.notes", days: "jarvis.v1.days" };
  function useCap(name) {
    try {
      var c = window.claude;
      if (c && typeof c.use === "function") return Promise.resolve(c.use(name)).catch(function () { return null; });
    } catch (e) { /* fora do claude.ai */ }
    return Promise.resolve(null);
  }
  function errCode(e) { return e && typeof e === "object" && typeof e.code === "string" ? e.code : "unknown"; }
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; } })();

  // tokens de cor do CSS, para o WebGL
  var TOK = {};
  function readTokens() { // as cores vêm só dos tokens do :root
    var cs = getComputedStyle(document.documentElement);
    var g = function (n) { return (cs.getPropertyValue(n) || "").trim(); };
    TOK.void = g("--void");
    TOK.clear = g("--clear");
    TOK.dim = g("--node-dim");
    TOK.link = g("--link");
    TOK.linkDim = g("--link-dim");
    TOK.linkHl = g("--link-hl");
    TOK.mem = g("--mem");
    TOK.starWarm = g("--star-warm");
    TOK.starCool = g("--star-cool");
    TOK.palette = [];
    for (var i = 0; i < 10; i++) TOK.palette.push(g("--g" + i));
  }
  function rgbOf(hex) { // "#rrggbb" do token -> [r, g, b] 0–255
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "").trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
  }
  function rgba(hex, a) { // cor do token + alfa, para a máscara de brilho
    return "rgba(" + rgbOf(hex).join(",") + "," + a + ")";
  }
  readTokens();

  // ------------------------------------------------------------ estado ----
  var DEFAULTS = { humor: 70, tier: "quick", voice: { on: true, rate: 1, voiceURI: "" }, lang: "pt-BR", hideSamples: false };
  function sanitizeSettings(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var v = r.voice && typeof r.voice === "object" ? r.voice : {};
    var rate = Number(v.rate);
    return {
      humor: C.clampHumor(r.humor == null ? DEFAULTS.humor : r.humor),
      tier: ["quick", "default", "complex"].indexOf(r.tier) >= 0 ? r.tier : DEFAULTS.tier,
      voice: {
        on: v.on === false ? false : true,
        rate: isFinite(rate) && rate >= 0.8 && rate <= 1.3 ? Math.round(rate * 100) / 100 : 1,
        voiceURI: typeof v.voiceURI === "string" ? v.voiceURI.slice(0, 300) : ""
      },
      lang: r.lang === "en-GB" ? "en-GB" : "pt-BR",
      hideSamples: r.hideSamples === true
    };
  }

  var S = {
    settings: sanitizeSettings(readJSON(LSK.settings, null)),
    settingsTouched: false,
    activated: false,
    thinking: false, streaming: false, speaking: false,
    brain: "pending", brainNote: "",
    storage: "pending", storageNote: "",
    agenda: "idle", agendaNote: "", agendaCount: 0,
    galaxy: "loading", bloom: false,
    history: [], lastQuestion: "", compact: false,
    lastAnswer: "", lastSources: [], lastIntent: null,
    tierNotes: {}
  };

  // ------------------------------------------------------------ notas ----
  var SAMPLES = [];
  try {
    var rawNotes = JSON.parse($("sample-notes").textContent || "[]");
    SAMPLES = rawNotes.map(function (n) {
      return { key: "s:" + n.path, kind: "sample", path: String(n.path), label: String(n.label), group: String(n.group),
        text: String(n.text || ""), excerpt: C.makeExcerpt(n.text || "", n.label) };
    });
  } catch (e) { console.warn("JARVIS: notas de exemplo ilegíveis", e); }

  var imported = new Map(); // docId -> nota
  var memories = new Map(); // docId -> memória
  var LIST = [], LINKS = [], ADJ = new Map(), BYKEY = new Map(), BYTITLE = new Map();
  var INDEX = C.indexNotes([]);
  var linkCache = new WeakMap(), idxCache = new WeakMap();

  function makeImported(id, d) {
    var label = String(d.label || "nota").slice(0, 200), group = String(d.group || "minhas notas").slice(0, 200);
    var text = String(d.text || "");
    return { key: "u:" + id, kind: "note", docId: id, label: label, group: group, text: text,
      importedAt: String(d.importedAt || ""), path: group + "/" + label + ".md", excerpt: C.makeExcerpt(text, label) };
  }
  function makeMemory(id, d) {
    var title = String(d.title || "").trim() || C.makeTitle(d.text || "");
    var fact = String(d.text || "");
    return { key: "m:" + id, kind: "memory", docId: id, label: title.slice(0, 120), title: title.slice(0, 120), fact: fact,
      text: fact, group: "memórias", path: "memórias/" + title.slice(0, 120) + ".md", createdAt: String(d.createdAt || ""),
      anchor: typeof d.anchor === "string" && d.anchor ? d.anchor : null, excerpt: fact };
  }
  function sameContent(a, b) {
    return a.label === b.label && a.text === b.text && a.group === b.group && a.anchor === b.anchor && a.createdAt === b.createdAt;
  }

  function visibleNotes() {
    var out = [];
    if (!S.settings.hideSamples) out = out.concat(SAMPLES);
    out = out.concat(Array.from(imported.values()).sort(function (a, b) { return cmp(a.path.toLowerCase(), b.path.toLowerCase()) || cmp(a.key, b.key); }));
    out = out.concat(Array.from(memories.values()).sort(function (a, b) { return cmp(a.createdAt, b.createdAt) || cmp(a.key, b.key); }));
    return out;
  }

  var groupColor = new Map(), groupToken = new Map();
  function assignColors(list) {
    var groups = Array.from(new Set(list.map(function (n) { return n.group; }))).sort();
    groups.forEach(function (g) {
      if (groupColor.has(g)) return;
      if (g === "memórias") { groupColor.set(g, TOK.mem); groupToken.set(g, "var(--mem)"); return; }
      var k = 0;
      groupColor.forEach(function (_, key) { if (key !== "memórias") k++; });
      groupColor.set(g, TOK.palette[k % TOK.palette.length]);
      groupToken.set(g, "var(--g" + (k % TOK.palette.length) + ")");
    });
  }
  function colorOf(g) { return groupColor.get(g) || TOK.palette[0]; }
  function tokenOf(g) { return groupToken.get(g) || "var(--g0)"; }
  function nodeByKey(k) { var i = BYKEY.get(k); return i === undefined ? null : LIST[i]; }
  function radius(n) { var a = ADJ.get(n.key); return 3 + Math.sqrt(a ? a.size : 0) * 1.6; }

  function rebuildGalaxy() {
    var list = visibleNotes();
    var prevKeys = BYKEY;
    LIST = list;
    BYKEY = new Map(list.map(function (n, i) { return [n.key, i]; }));
    assignColors(list);
    var raw = [];
    try { raw = C.buildLinks(list, { cache: linkCache }); } catch (e) { console.warn("JARVIS: ligações", e); }
    var seen = new Set(raw.map(function (l) { return l.source + "," + l.target; }));
    list.forEach(function (n, i) { // memória ↔ nota âncora
      if (n.kind !== "memory" || !n.anchor || !BYKEY.has(n.anchor)) return;
      var j = BYKEY.get(n.anchor), a = Math.min(i, j), b = Math.max(i, j);
      if (a !== b && !seen.has(a + "," + b)) { seen.add(a + "," + b); raw.push({ source: a, target: b }); }
    });
    LINKS = raw.map(function (l) { return { source: list[l.source].key, target: list[l.target].key }; });
    ADJ = new Map(list.map(function (n) { return [n.key, new Set()]; }));
    LINKS.forEach(function (l) { ADJ.get(l.source).add(l.target); ADJ.get(l.target).add(l.source); });
    markLoose(list);
    if (list.length !== prevKeys.size || list.some(function (n) { return !prevKeys.has(n.key); })) armFrame(2500, true);
    BYTITLE = new Map();
    list.forEach(function (n) { var k = C.titleKey(n.label); if (k && !BYTITLE.has(k)) BYTITLE.set(k, n.key); });
    try { INDEX = C.indexNotes(list, idxCache); } catch (e) { console.warn("JARVIS: índice", e); }
    if (Graph) {
      try { Graph.graphData({ nodes: list, links: LINKS.map(function (l) { return { source: l.source, target: l.target }; }) }); }
      catch (e) { console.warn("JARVIS: galáxia", e); }
      if (HL.focus && !BYKEY.has(HL.focus)) clearHighlight();
      else if (HL.nodes.size) highlight(Array.from(HL.nodes).filter(function (k) { return BYKEY.has(k); }), HL.focus);
    }
    if (panelKey && !BYKEY.has(panelKey)) closePanel();
    renderLegend();
    renderCounts();
    renderGalaxyMsg();
  }
  function renderGalaxyMsg() {
    var msg = $("galaxy-msg");
    if (S.galaxy === "loading") { msg.hidden = false; msg.textContent = "Montando a galáxia…"; }
    else if (S.galaxy === "ok" && !LIST.length) { msg.hidden = false; msg.textContent = "Galáxia vazia: adicione notas no menu ⋯"; }
    else msg.hidden = true;
  }

  // ------------------------------------------------------------ HUD ----
  function counts() {
    var notes = 0, mems = 0;
    LIST.forEach(function (n) { if (n.kind === "memory") mems++; else notes++; });
    return { notes: notes, memories: mems };
  }
  function countLine(c) {
    return c.notes + (c.notes === 1 ? " nota" : " notas") + " · " + c.memories + (c.memories === 1 ? " memória" : " memórias");
  }
  function renderCounts() {
    $("hud-count").textContent = countLine(counts());
    updateCardStatus(); // o cartão de ativação nunca contradiz o topo (memórias e notas chegam do db depois)
  }
  function renderHud() {
    var st = S.thinking ? "Pensando" : S.speaking ? "Falando" : S.streaming ? "Respondendo" : S.activated ? "Pronto" : "Em espera";
    $("hud-state").textContent = st;
    document.body.classList.toggle("st-thinking", S.thinking);
    document.body.classList.toggle("st-speaking", !S.thinking && S.speaking);
    var name = C.TIER_NAMES[S.settings.tier];
    $("chip-tier-label").textContent = name;
    $("chip-tier").setAttribute("aria-label", "Modo do cérebro: " + name + ". Abrir ajustes");
    $("chip-tier").style.setProperty("--c", S.settings.tier === "complex" ? "var(--amber)" : S.settings.tier === "default" ? "var(--ok)" : "var(--arc)");
    $("chip-humor-value").textContent = S.settings.humor + "%";
    $("hud-humor").textContent = S.settings.humor + "%";
    $("chip-humor").setAttribute("aria-label", "Humor: " + S.settings.humor + " por cento. Abrir ajustes");
    renderSend();
  }
  function setAgendaState(state, note, count) {
    S.agenda = state;
    S.agendaNote = note || "";
    if (typeof count === "number") S.agendaCount = count;
    var chip = $("chip-agenda");
    chip.dataset.state = state;
    var label = state === "ok" ? "Agenda: " + S.agendaCount + (S.agendaCount === 1 ? " evento hoje" : " eventos hoje") + ". Tocar refaz o briefing"
      : state === "loading" ? "Agenda: lendo…"
      : state === "idle" ? "Agenda: ainda não lida. Tocar liga o JARVIS e lê a agenda"
      : "Agenda: " + (note || "indisponível");
    chip.setAttribute("aria-label", label);
    chip.title = label;
    $("chip-agenda-label").textContent = label;
  }

  var statusTimer = 0;
  function setStatus(msg, isErr, holdMs) {
    var el = $("status");
    clearTimeout(statusTimer);
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
    if (holdMs) statusTimer = setTimeout(function () { if (el.textContent === msg) { el.textContent = ""; el.classList.remove("err"); } }, holdMs);
  }
  function cardStatus(msg) { $("card-status").textContent = msg; }

  var noticeKeys = new Set();
  function notice(key, msg, tone) {
    if (noticeKeys.has(key)) {
      var old = document.querySelector('.notice[data-key="' + key + '"] p');
      if (old) old.textContent = msg;
      return;
    }
    noticeKeys.add(key);
    var el = document.createElement("div");
    el.className = "notice";
    el.dataset.key = key;
    el.style.setProperty("--c", tone === "ok" ? "var(--ok)" : tone === "info" ? "var(--arc)" : "var(--amber)");
    el.innerHTML = '<span class="dot"></span><p></p><button type="button" aria-label="Dispensar aviso">×</button>';
    el.querySelector("p").textContent = msg;
    var kill = function () { el.remove(); if (noticeKeys.has(key) && !document.querySelector('.notice[data-key="' + key + '"]')) noticeKeys.delete(key); };
    el.querySelector("button").addEventListener("click", kill);
    $("notices").appendChild(el);
    if (tone === "info") setTimeout(kill, 12000);
  }
  function dropNotice(key) {
    noticeKeys.delete(key);
    var el = document.querySelector('.notice[data-key="' + key + '"]');
    if (el) el.remove();
  }

  // ------------------------------------------------------------ galáxia ----
  var Graph = null, ENH = null, enhTried = false, stars = null, glowTex = null, sphereGeo = null, hitMat = null;
  var HL = { nodes: new Set(), links: new Set(), focus: null };
  var IDLE_MS = 9000, DRIFT = 0.035;
  var lastTouch = -IDLE_MS, flyingUntil = 0; // a galáxia já abre girando devagar

  function galaxySize() {
    var el = $("galaxy");
    return { w: el.clientWidth || window.innerWidth || 800, h: el.clientHeight || window.innerHeight || 600 };
  }

  function followAnchor() { // a memória nova nasce colada na nota-mãe e a acompanha enquanto a física assenta
    var list = [];
    function force() {
      var now = performance.now();
      for (var k = 0; k < list.length; k++) {
        var n = list[k];
        if (!n.__followUntil) continue;
        if (now >= n.__followUntil) { n.fx = n.fy = n.fz = undefined; n.__followUntil = 0; continue; }
        var a = n.__anchor;
        if (!a || a.x == null) { if (n.fx == null) { n.fx = n.x; n.fy = n.y; n.fz = n.z; } continue; }
        n.fx = a.x + (a.fx == null ? (a.vx || 0) * 0.6 : 0) + n.__off.x;
        n.fy = a.y + (a.fy == null ? (a.vy || 0) * 0.6 : 0) + n.__off.y;
        n.fz = a.z + (a.fz == null ? (a.vz || 0) * 0.6 : 0) + n.__off.z;
      }
    }
    force.initialize = function (nodes) { list = nodes; };
    return force;
  }

  // estrelas fora do aglomerado principal (nota importada sem ligação, memória sem âncora) recebem uma gravidade
  // leve para o centro; sem ela só a repulsão age sobre elas, e elas fogem da tela e encolhem o enquadramento
  var G_MAIN = 0.004, G_LOOSE = 0.11;
  function markLoose(list) {
    var comp = new Map(), sizes = [];
    list.forEach(function (n) {
      if (comp.has(n.key)) return;
      var id = sizes.length, stack = [n.key], size = 0;
      comp.set(n.key, id);
      while (stack.length) {
        var k = stack.pop();
        size++;
        (ADJ.get(k) || []).forEach(function (o) { if (!comp.has(o)) { comp.set(o, id); stack.push(o); } });
      }
      sizes.push(size);
    });
    var best = -1, main = -1;
    sizes.forEach(function (sz, i) { if (sz > best) { best = sz; main = i; } });
    list.forEach(function (n) { n.__gather = comp.get(n.key) === main && best > 1 ? G_MAIN : G_LOOSE; });
  }
  function gatherForce() {
    var list = [];
    function force(alpha) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i], k = (n.__gather || 0) * alpha;
        if (!k || n.fx != null) continue;
        n.vx -= (n.x || 0) * k; n.vy -= (n.y || 0) * k; n.vz -= (n.z || 0) * k;
      }
    }
    force.initialize = function (nodes) { list = nodes; };
    return force;
  }

  function initGalaxy() {
    if (Graph || S.galaxy === "off-webgl") return;
    var Ctor = window.ForceGraph3D;
    if (typeof Ctor !== "function") return;
    var el = $("galaxy");
    try {
      var sz = galaxySize();
      Graph = new Ctor(el, { controlType: "orbit" });
      Graph.backgroundColor(TOK.clear || TOK.void) // o token --clear; sem ele, o fundo do próprio :root
        .showNavInfo(false)
        // sem arrastar estrelas: o fim do arrasto do 3d-force-graph manda um pointerup sintético de toque
        // que derruba os OrbitControls com TypeError a cada clique de mouse; tocar/clicar continua abrindo o painel
        .enableNodeDrag(false)
        .width(sz.w).height(sz.h)
        .nodeId("key")
        .nodeLabel(function (n) { return '<div class="tip"><b>' + esc(n.label) + "</b><span>" + esc(n.group) + "</span></div>"; })
        // sem o realce (só o UMD), a estrela apagada vira um fantasma pequeno da própria cor: no close-up não sobra
        // um disco cinza opaco na frente da fonte (o realce desenha as próprias estrelas e ignora estas duas)
        .nodeColor(function (n) { return isLit(n) ? colorOf(n.group) : rgba(colorOf(n.group), DIM_NODE_ALPHA); })
        .nodeVal(function (n) { var r = radius(n); return r * r / 4 * (isLit(n) ? 1 : DIM_NODE_VAL); })
        .nodeOpacity(0.95)
        .nodeResolution(14)
        // com algo aceso (mesmo uma memória ainda sem ligações), as demais ligações recuam; sem o realce, recuam de verdade
        .linkColor(function (l) { return HL.nodes.size ? (HL.links.has(l) ? TOK.linkHl : S.bloom ? TOK.linkDim : rgba(TOK.link, DIM_LINK_ALPHA)) : TOK.link; })
        .linkOpacity(0.5)
        .linkWidth(function (l) { return HL.links.has(l) ? 0.7 : 0; })
        .linkDirectionalParticles(function (l) { return HL.links.has(l) ? 3 : 0; })
        .linkDirectionalParticleWidth(1.6)
        .linkDirectionalParticleSpeed(0.007)
        .linkDirectionalParticleColor(function () { return TOK.linkHl; })
        .warmupTicks(80)
        .cooldownTicks(400)
        .onNodeClick(function (n) { focusNode(n); })
        .onNodeHover(function (n) { el.style.cursor = n ? "pointer" : ""; })
        .onBackgroundClick(function () { overview(); }); // tocar no vazio: fecha o painel e volta à galáxia inteira
      Graph.d3Force("charge").strength(-95).distanceMax(360);
      Graph.d3Force("link").distance(42);
      Graph.d3Force("gather", gatherForce());
      Graph.d3Force("follow", followAnchor());
      Graph.onEngineStop(function () { if (frame.settle) { frame.settle = false; armFrame(1600); } });
      Graph.graphData({ nodes: LIST, links: LINKS.map(function (l) { return { source: l.source, target: l.target }; }) });
    } catch (e) {
      console.warn("JARVIS: galáxia 3D indisponível", e);
      Graph = null;
      el.innerHTML = "";
      galaxyOff("A galáxia 3D não abriu neste aparelho (WebGL indisponível). Chat, voz e memórias seguem funcionando.", "off-webgl");
      return;
    }
    S.galaxy = "ok";
    dropNotice("galaxy");
    renderGalaxyMsg();
    try {
      var canvas = el.querySelector("canvas");
      if (canvas) canvas.addEventListener("webglcontextlost", function (ev) {
        ev.preventDefault();
        notice("webgl", "A galáxia perdeu o acesso à placa de vídeo. Recarregue a página para trazê-la de volta.");
      });
    } catch (e) { /* sem canvas */ }
    ["pointerdown", "wheel", "touchstart"].forEach(function (ev) {
      el.addEventListener(ev, function () { lastTouch = performance.now(); disarmFrame(); }, { passive: true });
    });
    // girar ou dar zoom à mão também oferece o caminho de volta (botão "Galáxia inteira")
    var downAt = null;
    el.addEventListener("pointerdown", function (e) { downAt = { x: e.clientX, y: e.clientY }; }, { passive: true });
    el.addEventListener("pointerup", function () { downAt = null; }, { passive: true });
    el.addEventListener("pointermove", function (e) {
      if (downAt && e.buttons && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 10) { downAt = null; setCloseUp(true); }
    }, { passive: true });
    el.addEventListener("wheel", function () { setCloseUp(true); }, { passive: true });
    armFrame(4000, true); // enquanto a física assenta, a galáxia continua enquadrada
    requestFit(1500, 600); // o primeiro enquadramento espera a física ter posições de verdade
    measureView();
    applyView("jump");
    requestAnimationFrame(tick);
    applyEnhancement();
  }

  function galaxyOff(msg, state) {
    S.galaxy = state || "off";
    renderGalaxyMsg();
    notice("galaxy", msg);
  }

  // realce opcional (módulo ESM: three + UnrealBloomPass). Se qualquer passo falhar, volta ao padrão.
  window.addEventListener("jarvis:three", function (ev) {
    if (ENH) return;
    ENH = ev && ev.detail && ev.detail.THREE ? ev.detail : null;
    applyEnhancement();
  });
  // apagadas sem o realce: cor da pasta a 7% (vezes nodeOpacity; a luz forte do 3d-force-graph ainda a clareia),
  // 30% do volume (≈67% do raio) e ligações a 16% — um fantasma discreto, mesmo no close-up de uma memória
  var DIM_NODE_ALPHA = 0.07, DIM_NODE_VAL = 0.3, DIM_LINK_ALPHA = 0.16;
  function isLit(n) { return !HL.nodes.size || HL.nodes.has(n.key); }
  function nodeObject(n) {
    var THREE = ENH.THREE;
    var color = new THREE.Color(colorOf(n.group));
    var r = radius(n);
    var obj = new THREE.Group();
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: color, transparent: true, opacity: 0.4,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(r * 5.5);
    var core = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.95 }));
    core.scale.setScalar(r);
    // o clique/toque mira a estrela, não o halo: o brilho largo de uma vizinha da frente não rouba o toque
    glow.raycast = function () {};
    var hit = new THREE.Mesh(sphereGeo, hitMat || (hitMat = new THREE.MeshBasicMaterial({ visible: false })));
    hit.scale.setScalar(r * 1.6);
    obj.add(glow, core, hit);
    n.__core = core; n.__glow = glow; n.__r = r;
    return obj;
  }
  function applyEnhancement() {
    if (!ENH || !Graph || enhTried) return;
    enhTried = true;
    var THREE = ENH.THREE, Bloom = ENH.UnrealBloomPass, bloom = null;
    try {
      var c = document.createElement("canvas");
      c.width = c.height = 128;
      var g = c.getContext("2d");
      if (!g) throw new Error("canvas 2d indisponível");
      var grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, rgba(TOK.linkHl, 1));      // máscara de brilho: a cor vem do material
      grd.addColorStop(0.18, rgba(TOK.linkHl, 0.55));
      grd.addColorStop(0.45, rgba(TOK.linkHl, 0.12));
      grd.addColorStop(1, rgba(TOK.linkHl, 0));
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
      glowTex = new THREE.CanvasTexture(c);
      if (THREE.SRGBColorSpace) glowTex.colorSpace = THREE.SRGBColorSpace;
      sphereGeo = new THREE.SphereGeometry(1, 24, 16);
      Graph.nodeThreeObject(nodeObject);
      var N = 4500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      var warm = rgbOf(TOK.starWarm), cool = rgbOf(TOK.starCool); // cores do campo de estrelas: tokens do :root
      for (var i = 0; i < N; i++) {
        var rr = 1400 + Math.random() * 2600, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = rr * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = rr * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = rr * Math.cos(ph);
        var t = (0.55 + Math.random() * 0.45) / 255, tone = Math.random() < 0.3 ? cool : warm;
        col[i * 3] = t * tone[0]; col[i * 3 + 1] = t * tone[1]; col[i * 3 + 2] = t * tone[2];
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: 0.8, depthWrite: false }));
      Graph.scene().add(stars);
      // fundo pintado pela cena: com pós-processamento, o clear transparente vira azul-marinho
      Graph.scene().background = new THREE.Color(TOK.void);
      if (typeof Bloom === "function") {
        var sz = galaxySize();
        bloom = new Bloom(new THREE.Vector2(Math.max(2, sz.w / 2), Math.max(2, sz.h / 2)), 0.85, 0.35, 0.1);
        Graph.postProcessingComposer().addPass(bloom);
      }
      Graph.postProcessingComposer().render(); // um quadro de teste: se quebrar, desfaz tudo aqui
      S.bloom = true;
      refreshLook();
    } catch (err) {
      console.warn("JARVIS: realce 3D falhou; sigo sem brilho.", err);
      try { Graph.nodeThreeObject(null); } catch (e) { /* padrão */ }
      try { if (stars) Graph.scene().remove(stars); Graph.scene().background = null; } catch (e) { /* nada */ }
      try { if (bloom) Graph.postProcessingComposer().removePass(bloom); } catch (e) { /* nada */ }
      stars = null;
      S.bloom = false;
      LIST.forEach(function (n) { n.__core = n.__glow = null; });
    }
  }

  function edgePoint() { // um ponto na borda da galáxia atual, longe do centro de repulsão
    var r = 0, cx = 0, cy = 0, cz = 0, k = 0;
    LIST.forEach(function (n) { if (n.x != null) { cx += n.x; cy += n.y; cz += n.z; k++; } });
    if (k) { cx /= k; cy /= k; cz /= k; }
    LIST.forEach(function (n) { if (n.x != null) r = Math.max(r, Math.hypot(n.x - cx, n.y - cy, n.z - cz)); });
    var th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), d = Math.max(40, r * 0.85);
    return { x: cx + d * Math.sin(ph) * Math.cos(th), y: cy + d * Math.sin(ph) * Math.sin(th), z: cz + d * Math.cos(ph) };
  }
  // direção de chegada com a linha de visada livre: nenhuma outra estrela grudada na lente nem na frente da fonte
  function clearDirection(n, dist) {
    var x = n.x || 0, y = n.y || 0, z = n.z || 0, cx = 0, cy = 0, cz = 0, k = 0;
    LIST.forEach(function (m) { if (typeof m.x === "number" && isFinite(m.x)) { cx += m.x; cy += m.y; cz += m.z; k++; } });
    if (k) { cx /= k; cy /= k; cz /= k; }
    var unit = function (a, b, c) { var l = Math.hypot(a, b, c); return l > 1e-6 ? { x: a / l, y: b / l, z: c / l } : null; };
    var out = unit(x - cx, y - cy, z - cz) || unit(x, y, z) || { x: 0, y: 0, z: 1 };
    var cands = [out];
    try { var cam = Graph.camera().position, cd = unit(cam.x - x, cam.y - y, cam.z - z); if (cd) cands.push(cd); } catch (e) { /* sem câmera */ }
    for (var i = 0, N = 40; i < N; i++) { // esfera de Fibonacci
      var yy = 1 - 2 * (i + 0.5) / N, rr = Math.sqrt(1 - yy * yy), th = i * 2.399963;
      cands.push({ x: rr * Math.cos(th), y: yy, z: rr * Math.sin(th) });
    }
    var start = (n.__r || radius(n)) * 2 + 6, best = out, bestScore = -Infinity;
    cands.forEach(function (d) {
      var clear = Infinity;
      for (var j = 0; j < LIST.length; j++) {
        var m = LIST[j];
        if (m === n || typeof m.x !== "number" || !isFinite(m.x)) continue;
        var px = m.x - x, py = m.y - y, pz = m.z - z;
        var t = Math.max(start, Math.min(dist * 1.15, px * d.x + py * d.y + pz * d.z)); // trecho da visada até um pouco atrás da lente
        var e = Math.hypot(px - d.x * t, py - d.y * t, pz - d.z * t) - (m.__r || radius(m)) * 2.5;
        if (e < clear) clear = e;
      }
      var score = Math.min(clear, 70) + 12 * (d.x * out.x + d.y * out.y + d.z * out.z);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }
  // distância do close-up: perto o bastante para ser um voo de verdade, longe o bastante para a constelação da
  // fonte (ela e as vizinhas acesas) caber na área livre, sem estrela vizinha gigante colada na lente
  function closeUpDistance(n) {
    var near = 110 + (n.__r || radius(n)) * 6;
    try {
      var geo = fitGeometry(), R = 0;
      (ADJ.get(n.key) || []).forEach(function (k) {
        var m = nodeByKey(k);
        if (m && typeof m.x === "number" && isFinite(m.x)) R = Math.max(R, Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) + (m.__r || radius(m)) * 1.6);
      });
      if (!R) return near;
      // memória ou nota recém-nascida ainda colada na âncora: a mola (42) vai afastá-la, então reserva esse espaço
      R = Math.max(R, 56 + (n.__r || radius(n)) * 1.6);
      var want = fitDistance(R, geo), all = placedNodes();
      var whole = all.length > 1 ? fitDistance(sphereOf(all).R, geo) : want;
      return Math.max(near, Math.min(want, whole * 0.6));
    } catch (e) { return near; }
  }
  function flyTo(n, ms) {
    if (!Graph || !n) return;
    ms = REDUCED.matches ? 0 : (ms == null ? 1600 : ms);
    var dist = closeUpDistance(n);
    setCloseUp(true);
    var x = n.x || 0, y = n.y || 0, z = n.z || 0, dir;
    try { dir = clearDirection(n, dist); } catch (e) { dir = null; }
    if (!dir) { var len = Math.hypot(x, y, z); dir = len > 1 ? { x: x / len, y: y / len, z: z / len } : { x: 0, y: 0, z: 1 }; }
    var pos = { x: x + dir.x * dist, y: y + dir.y * dist, z: z + dir.z * dist };
    disarmFrame();
    flyingUntil = performance.now() + ms + 200;
    lastTouch = performance.now();
    try { Graph.cameraPosition(pos, { x: x, y: y, z: z }, ms); } catch (e) { /* câmera ocupada */ }
  }
  // enquadramento adiado: só quando os nós já têm posição (em aparelho lento o layout chega depois)
  var pendingFit = null;
  function requestFit(ms, delay) { pendingFit = { ms: ms, at: performance.now() + (delay || 0), first: !fitDone }; }
  var fitDone = false;
  function runPendingFit(now) {
    if (!pendingFit || now < pendingFit.at || !Graph || !LIST.length) return;
    var placed = 0;
    for (var i = 0; i < LIST.length; i++) if (typeof LIST[i].x === "number" && isFinite(LIST[i].x)) placed++;
    if (placed < LIST.length) return;
    var span = 0;
    try {
      var b = Graph.getGraphBbox();
      if (b) span = Math.max(b.x[1] - b.x[0], b.y[1] - b.y[0], b.z[1] - b.z[0]);
    } catch (e) { span = 100; }
    if (!(span > 8) && LIST.length > 1) return;
    var job = pendingFit;
    pendingFit = null;
    if (!fitDone) { fitDone = true; try { Graph.warmupTicks(0); } catch (e) { /* versão antiga */ } }
    if (job.first && now < flyingUntil) return; // o usuário já voou para algum lugar
    flyFit(job.ms);
  }
  function flyFit(ms, filter) {
    if (!Graph) return;
    track = null; // um enquadramento novo solta o acompanhamento da estrela anterior
    setCloseUp(!!filter);
    try { fitNodes(ms, filter); } catch (e) { /* nada a enquadrar */ }
  }
  // de volta à galáxia inteira: apaga o destaque, fecha o painel e reenquadra tudo
  function overview() {
    clearHighlight();
    closePanel();
    if (!Graph) { setCloseUp(false); return; }
    frame.touched = false;
    flyFit(1200);
    armFrame(2600);
  }
  function setCloseUp(on) {
    var show = !!on && !!Graph;
    var btn = $("view-all");
    if (btn.hidden === !show) return;
    btn.hidden = !show;
    document.body.classList.toggle("closeup", show);
  }
  $("view-all").addEventListener("click", function () { overview(); });
  // onde começa o console (lista de respostas reservada + dock, ou o cartão de ativação), em px do topo.
  // Depois de ativar, o espaço da lista já fica reservado (altura máxima dela): a câmera não se mexe a cada resposta.
  function consoleTop() {
    var sz = galaxySize();
    if (S.activated && !$("dock-wrap").hidden) {
      var mh = parseFloat(getComputedStyle($("feed")).maxHeight);
      if (!isFinite(mh)) mh = sz.h * 0.34;
      return $("dock-wrap").getBoundingClientRect().top - 8 - mh;
    }
    return $("console").getBoundingClientRect().top - 6;
  }
  // medidas que o CSS do painel usa: até onde o painel lateral desce, e onde a folha do celular se apoia (no dock)
  var layoutCache = "";
  function layoutVars() {
    try {
      var ct = consoleTop(), h = window.innerHeight || galaxySize().h, vars = {};
      vars["--free-bottom"] = isFinite(ct) && ct > 0 ? Math.round(ct) + "px" : "";
      if (S.activated && !$("dock-wrap").hidden) {
        var dockTop = $("dock-wrap").getBoundingClientRect().top;
        vars["--sheet-bottom"] = Math.round(Math.max(0, h - dockTop + 8)) + "px";
        vars["--sheet-room"] = Math.round(Math.max(0, dockTop)) + "px";
      } else { vars["--sheet-bottom"] = ""; vars["--sheet-room"] = ""; }
      var key = JSON.stringify(vars);
      if (key === layoutCache) return;
      layoutCache = key;
      var root = document.documentElement.style;
      Object.keys(vars).forEach(function (k) { if (vars[k]) root.setProperty(k, vars[k]); else root.removeProperty(k); });
    } catch (e) { /* sem medidas */ }
  }
  // caixa do painel sem as transformações da animação de entrada
  function panelBox() {
    var p = $("panel");
    if (p.hidden || !p.offsetWidth) return null;
    return { left: p.offsetLeft, top: p.offsetTop, right: p.offsetLeft + p.offsetWidth, bottom: p.offsetTop + p.offsetHeight };
  }
  // área livre para a galáxia: entre o topo e o console, e fora do painel da nota (à direita dele no iPad e no
  // computador; acima da folha no celular). A câmera centra a fonte e enquadra a galáxia aqui.
  function freeRect() {
    var sz = galaxySize(), r = { left: 8, right: sz.w - 8, top: 0, bottom: sz.h };
    try { r.top = Math.max(0, $("topbar").getBoundingClientRect().bottom - 8); } catch (e) { /* sem topo */ }
    try {
      var bottom = consoleTop();
      if (isFinite(bottom) && bottom > 0) r.bottom = Math.min(sz.h, bottom);
    } catch (e) { /* sem console */ }
    var pb = panelBox();
    if (pb) {
      if (PHONE.matches) r.bottom = Math.min(r.bottom, pb.top - 8);
      else if (pb.left > sz.w * 0.3) r.right = Math.min(r.right, pb.left - 8);
    }
    if (r.bottom - r.top < sz.h * 0.28) r.bottom = Math.min(sz.h, r.top + sz.h * 0.28); // tela baixa demais: melhor sobrepor do que sumir
    if (r.right - r.left < sz.w * 0.3) r.right = Math.min(sz.w - 8, r.left + sz.w * 0.3);
    return r;
  }
  function placedNodes(filter) {
    return LIST.filter(function (n) { return typeof n.x === "number" && isFinite(n.x) && isFinite(n.y) && isFinite(n.z) && (!filter || filter(n)); });
  }
  // esfera envolvente: o enquadramento vale para qualquer ângulo, inclusive durante a deriva lenta da câmera
  function sphereOf(pts) {
    var mn = { x: Infinity, y: Infinity, z: Infinity }, mx = { x: -Infinity, y: -Infinity, z: -Infinity };
    pts.forEach(function (n) {
      ["x", "y", "z"].forEach(function (a) { if (n[a] < mn[a]) mn[a] = n[a]; if (n[a] > mx[a]) mx[a] = n[a]; });
    });
    var c = { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 }, R = 0;
    pts.forEach(function (n) { R = Math.max(R, Math.hypot(n.x - c.x, n.y - c.y, n.z - c.z) + (n.__r || radius(n)) * 1.6); });
    return { c: c, R: Math.max(R, 24) };
  }
  function fitGeometry() { // eixo da câmera na tela (centro da área livre) e meia-largura útil em px
    var sz = galaxySize(), fr = freeRect(), cy = sz.h / 2 - view.target, cx = sz.w / 2 - view.tx;
    var half = Math.min(cy - fr.top, fr.bottom - cy, cx - fr.left, fr.right - cx) - 10;
    return { sz: sz, cx: cx, cy: cy, half: Math.max(half, Math.min(sz.w, sz.h) * 0.16) };
  }
  function fitDistance(R, geo) {
    var cam = Graph.camera(), fov = (cam && cam.fov ? cam.fov : 50) * Math.PI / 180;
    var t = Math.tan(fov / 2) * geo.half / (geo.sz.h / 2);
    return Math.max(R * Math.sqrt(1 + t * t) / t, 60);
  }
  function fitNodes(ms, filter) {
    var pts = placedNodes(filter);
    if (!Graph || !pts.length) return false;
    var sp = sphereOf(pts), c = sp.c, d = fitDistance(sp.R, fitGeometry()), cam = Graph.camera();
    var dir = null;
    try {
      var ctl = Graph.controls(), tg = ctl && ctl.target ? ctl.target : c, p = cam.position;
      var len = Math.hypot(p.x - tg.x, p.y - tg.y, p.z - tg.z);
      if (len > 1e-6) dir = { x: (p.x - tg.x) / len, y: (p.y - tg.y) / len, z: (p.z - tg.z) / len };
    } catch (e) { dir = null; }
    if (!dir) dir = { x: 0, y: 0, z: 1 };
    ms = REDUCED.matches ? 0 : ms;
    flyingUntil = performance.now() + ms + 200;
    Graph.cameraPosition({ x: c.x + dir.x * d, y: c.y + dir.y * d, z: c.z + dir.z * d }, c, ms);
    return true;
  }
  // enquadramento automático: só enquanto a galáxia muda sozinha (boot, notas novas, ativação, giro da tela).
  // Qualquer gesto na galáxia, voo até uma estrela ou pergunta desarma: a câmera não se mexe por conta própria.
  var frame = { until: 0, settle: false, next: 0, touched: false };
  function armFrame(ms, untilSettled) {
    frame.until = Math.max(frame.until, performance.now() + ms);
    if (untilSettled) frame.settle = true;
  }
  function disarmFrame() { frame.until = 0; frame.settle = false; frame.touched = true; }
  function frameState() {
    var pts = placedNodes();
    if (!pts.length) return { out: 0, small: false };
    // dx, dy: onde a estrela fica quando a vista terminar de deslizar
    var fr = freeRect(), dy = view.cur - view.target, dx = view.curX - view.tx, out = 0;
    pts.forEach(function (n) {
      var sc;
      try { sc = Graph.graph2ScreenCoords(n.x, n.y, n.z); } catch (e) { sc = null; }
      if (!sc || !isFinite(sc.x) || !isFinite(sc.y)) return;
      var x = sc.x + dx, y = sc.y + dy;
      if (x < fr.left + 2 || x > fr.right - 2 || y < fr.top + 2 || y > fr.bottom - 2) out++; // depois de enquadrar, sobram 10 px ou mais
    });
    // a mesma esfera do enquadramento: perto demais (algo sai ao girar), longe demais (galáxia miúda) ou fora do centro
    var sp = sphereOf(pts), geo = fitGeometry(), need = fitDistance(sp.R, geo), cur = need, off = 0;
    try {
      var p = Graph.camera().position, sc = Graph.graph2ScreenCoords(sp.c.x, sp.c.y, sp.c.z);
      cur = Math.hypot(p.x - sp.c.x, p.y - sp.c.y, p.z - sp.c.z);
      off = Math.hypot(sc.x + dx - geo.cx, sc.y + dy - geo.cy);
    } catch (e) { /* câmera indisponível */ }
    if (cur < need * 0.94 || off > geo.half * 0.25) out++;
    return { out: out, small: cur > need * 1.35 };
  }
  function runFrame(now) {
    // com o cartão de boas-vindas na tela (nenhuma pergunta em curso) e a galáxia intocada, o enquadramento se mantém
    var welcome = !S.activated && !frame.touched;
    if (!(welcome || frame.settle || now < frame.until) || now < frame.next || !fitDone || pendingFit) return;
    frame.next = now + 650;
    if (now < flyingUntil || HL.nodes.size || !$("panel").hidden) return;
    var st = frameState();
    if (st.out || st.small) flyFit(1100);
  }

  function refreshLook() {
    if (!Graph) return;
    var any = HL.nodes.size > 0;
    LIST.forEach(function (n) {
      if (!n.__core || !n.__glow) return;
      var on = !any || HL.nodes.has(n.key), focus = n.key === HL.focus;
      // apagadas de verdade: a mistura acontece em luz linear, então 6% de opacidade ainda aparecia como um disco
      // borrado a ~30% de brilho no close-up; 1,5% fica como uma silhueta discreta
      n.__core.material.opacity = on ? 1 : 0.015;
      n.__glow.material.opacity = on ? (focus ? 0.9 : any ? 0.55 : 0.4) : 0;
      n.__glow.visible = on;
      if (!n.__pulse) n.__glow.scale.setScalar(n.__r * (focus ? 8 : 5.5));
    });
    try {
      if (!S.bloom) Graph.nodeColor(Graph.nodeColor()).nodeVal(Graph.nodeVal());
      Graph.linkColor(Graph.linkColor()).linkWidth(Graph.linkWidth()).linkDirectionalParticles(Graph.linkDirectionalParticles());
    } catch (e) { /* galáxia ocupada */ }
  }
  function highlight(keys, focusKey) {
    HL.nodes = new Set(keys);
    HL.focus = focusKey || null;
    var links = [];
    if (Graph) {
      try { links = Graph.graphData().links; } catch (e) { links = []; }
    }
    HL.links = new Set(links.filter(function (l) {
      var s = l.source && typeof l.source === "object" ? l.source.key : l.source;
      var t = l.target && typeof l.target === "object" ? l.target.key : l.target;
      return HL.focus ? (s === HL.focus || t === HL.focus) : (HL.nodes.has(s) && HL.nodes.has(t));
    }));
    refreshLook();
  }
  function clearHighlight() { highlight([], null); }
  // auto = voo pedido por uma resposta ou memória nova. No celular a folha da nota cobriria a resposta que acabou de
  // chegar: a câmera voa e acende a fonte, e a folha só abre quando ele toca no chip ou na estrela.
  function focusNode(n, ms, auto) {
    if (!n) return;
    highlight([n.key].concat(Array.from(ADJ.get(n.key) || [])), n.key);
    if (auto && PHONE.matches) closePanel();
    else openPanel(n);
    measureView(); // a fonte se centra na área livre que sobra ao lado (ou acima) do painel
    flyTo(n, ms);
    if (Graph) { var t0 = performance.now(); track = { n: n, start: t0, until: t0 + (REDUCED.matches ? 0 : (ms == null ? 1600 : ms)) + 6000 }; }
  }
  // depois do voo, a câmera acompanha a estrela enquanto a física assenta (memória nova, nota importada): ela não
  // escapa para a borda da tela. Qualquer toque na galáxia solta o acompanhamento.
  var track = null;
  function followTrack(now, dt) {
    if (!track) return;
    if (now > track.until || lastTouch > track.start + 1 || !nodeByKey(track.n.key)) { track = null; return; }
    if (now < flyingUntil) return;
    try {
      var n = track.n, ctl = Graph.controls(), cam = Graph.camera(), tg = ctl && ctl.target;
      if (!tg || !cam || typeof n.x !== "number" || !isFinite(n.x)) return;
      var k = 1 - Math.exp(-6 * (dt > 0 ? dt : 1 / 60));
      var dx = (n.x - tg.x) * k, dy = (n.y - tg.y) * k, dz = (n.z - tg.z) * k;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-3) return;
      tg.x += dx; tg.y += dy; tg.z += dz;
      cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
      cam.lookAt(tg);
    } catch (e) { track = null; }
  }
  function flyToSources(keys) {
    var nodes = keys.map(nodeByKey).filter(Boolean);
    if (!nodes.length) return;
    if (nodes.length >= 4) { // muitas fontes: acende o aglomerado inteiro
      var ks = nodes.map(function (n) { return n.key; });
      highlight(ks, null);
      if (PHONE.matches) closePanel(); else openCluster(nodes);
      measureView();
      disarmFrame();
      flyFit(1600, function (n) { return ks.indexOf(n.key) >= 0; });
      return;
    }
    focusNode(nodes[0], 1800, true);
  }

  var lastFrame = performance.now();
  function tick(now) {
    if (!Graph) return;
    var dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    if (!document.hidden) {
      if (stars) stars.rotation.y += dt * 0.004;
      applyView(false, dt);
      followTrack(now, dt);
      runPendingFit(now);
      runFrame(now);
      for (var i = 0; i < LIST.length; i++) {
        var n = LIST[i];
        if (n.__followUntil && now >= n.__followUntil + 500) { n.fx = n.fy = n.fz = undefined; n.__followUntil = 0; }
        if (!n.__pulse) continue;
        var k = (now - n.__pulse) / 1800;
        if (k >= 1) {
          n.__pulse = 0;
          if (!n.__glow && n.__threeObj) n.__threeObj.scale.setScalar(1);
          refreshLook();
          continue;
        }
        var wave = Math.sin(Math.PI * k) * (1 - k);
        if (n.__glow) { n.__glow.scale.setScalar((n.__r || 4) * (8 + 22 * wave)); n.__glow.material.opacity = 1; }
        else if (n.__threeObj) n.__threeObj.scale.setScalar(1 + 2.4 * wave);
      }
      if (!REDUCED.matches && now - lastTouch > IDLE_MS && now > flyingUntil) { // deriva ociosa
        try {
          var cam = Graph.camera(), ctl = Graph.controls(), tgt = ctl && ctl.target;
          if (cam && tgt) {
            var a = DRIFT * dt, dx = cam.position.x - tgt.x, dz = cam.position.z - tgt.z;
            cam.position.x = tgt.x + dx * Math.cos(a) - dz * Math.sin(a);
            cam.position.z = tgt.z + dx * Math.sin(a) + dz * Math.cos(a);
            cam.lookAt(tgt);
          }
        } catch (e) { /* câmera indisponível */ }
      }
    }
    requestAnimationFrame(tick);
  }

  // a galáxia se centra no espaço livre entre o topo e o console (deslocamento da projeção)
  // (deslocamento da projeção: vertical para o topo/console, horizontal para o painel lateral)
  var view = { cur: 0, target: 0, curX: 0, tx: 0, w: 0, h: 0 };
  function measureView() {
    layoutVars();
    try {
      var sz = galaxySize(), fr = freeRect();
      var shift = sz.h / 2 - (fr.top + fr.bottom) / 2, shiftX = sz.w / 2 - (fr.left + fr.right) / 2;
      view.target = Math.max(0, Math.min(sz.h * 0.3, isFinite(shift) ? shift : 0));
      view.tx = Math.max(-sz.w * 0.3, Math.min(sz.w * 0.3, isFinite(shiftX) ? shiftX : 0));
    } catch (e) { view.target = 0; view.tx = 0; }
  }
  function applyView(force, dt) {
    if (!Graph) return;
    var sz = galaxySize();
    var delta = view.target - view.cur, deltaX = view.tx - view.curX, cam0 = null;
    try { cam0 = Graph.camera(); } catch (e) { cam0 = null; }
    var lost = !!(cam0 && (Math.abs(view.cur) > 0.5 || Math.abs(view.curX) > 0.5) && !(cam0.view && cam0.view.enabled));
    if (!force && !lost && Math.abs(delta) < 0.5 && Math.abs(deltaX) < 0.5 && view.w === sz.w && view.h === sz.h) return;
    // desliza no tempo (≈0,4 s), não por quadro: num aparelho lento a vista chega junto com a câmera
    var jump = REDUCED.matches || force === "jump", k = 1 - Math.exp(-7.5 * (dt > 0 ? dt : 1 / 60));
    view.cur = jump || Math.abs(delta) < 0.5 ? view.target : view.cur + delta * k;
    view.curX = jump || Math.abs(deltaX) < 0.5 ? view.tx : view.curX + deltaX * k;
    view.w = sz.w; view.h = sz.h;
    try {
      var cam = Graph.camera();
      if (cam && typeof cam.setViewOffset === "function") { cam.setViewOffset(sz.w, sz.h, view.curX, view.cur, sz.w, sz.h); cam.updateProjectionMatrix(); }
    } catch (e) { /* câmera indisponível */ }
  }
  function resizeGalaxy() {
    if (!Graph) return;
    var sz = galaxySize();
    try { Graph.width(sz.w).height(sz.h); } catch (e) { /* nada */ }
    measureView();
    applyView("jump");
    armFrame(2500);
  }
  window.addEventListener("resize", resizeGalaxy);
  if (typeof window.ResizeObserver === "function") {
    try { new ResizeObserver(function () { measureView(); }).observe($("console")); } catch (e) { /* sem observador */ }
  }
  document.addEventListener("visibilitychange", function () {
    if (!Graph) return;
    try { if (document.hidden) Graph.pauseAnimation(); else { Graph.resumeAnimation(); lastFrame = performance.now(); } } catch (e) { /* nada */ }
  });

  // carrega o UMD do 3d-force-graph (o núcleo da galáxia); sem ele, o resto segue igual
  (function loadGalaxyLib() {
    if (typeof window.ForceGraph3D === "function") { initGalaxy(); return; }
    var done = false;
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/dist/3d-force-graph.min.js";
    s.async = true;
    s.onload = function () {
      done = true;
      if (typeof window.ForceGraph3D === "function") { dropNotice("galaxy"); initGalaxy(); }
      else galaxyOff("A biblioteca da galáxia 3D veio incompleta. Chat, voz e memórias seguem funcionando.");
    };
    s.onerror = function () {
      done = true;
      galaxyOff("Não consegui baixar a galáxia 3D (rede ou bloqueio). Chat, voz e memórias seguem funcionando.");
    };
    document.head.appendChild(s);
    setTimeout(function () {
      if (!done && !Graph) notice("galaxy", "A galáxia 3D está demorando para carregar. Chat, voz e memórias já funcionam.");
    }, 15000);
  })();

  // ------------------------------------------------------------ legenda ----
  function renderLegend() {
    var countsByGroup = new Map();
    LIST.forEach(function (n) { countsByGroup.set(n.group, (countsByGroup.get(n.group) || 0) + 1); });
    var groups = Array.from(countsByGroup.keys()).sort();
    $("legend").innerHTML = groups.map(function (g) {
      return '<button type="button" data-group="' + esc(g) + '"><span class="dot" style="--c:' + tokenOf(g) + '"></span>' +
        esc(g) + ' <span class="n">' + countsByGroup.get(g) + "</span></button>";
    }).join("");
  }
  $("legend").addEventListener("click", function (e) {
    var b = e.target.closest("[data-group]");
    if (!b) return;
    var ks = LIST.filter(function (n) { return n.group === b.dataset.group; }).map(function (n) { return n.key; });
    highlight(ks, null);
    closePanel();
    disarmFrame();
    flyFit(1200, function (n) { return ks.indexOf(n.key) >= 0; });
  });

  // ------------------------------------------------------------ painel ----
  var panelKey = null;
  var WIKI_RE = /\[\[([^\[\]|#^]+)(?:[#^][^\[\]|]*)?(?:\|([^\[\]]*))?\]\]/g;
  function fmt(s) { // markdown leve num pedaço sem wikilinks
    return esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/^(#{1,6}) (.*)$/gm, '<span class="h">$2</span>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function renderMd(text) {
    var out = "", from = 0, m, s = String(text || "");
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(s))) {
      out += fmt(s.slice(from, m.index));
      var target = m[1].trim(), shown = esc((m[2] || target).trim());
      var key = BYTITLE.get(C.titleKey(target.split("/").pop()));
      out += key ? '<button type="button" class="wl" data-key="' + esc(key) + '">' + shown + "</button>" : '<span class="wl dead">' + shown + "</span>";
      from = m.index + m[0].length;
    }
    return out + fmt(s.slice(from));
  }
  function chipHtml(n) {
    return '<button class="chip" type="button" data-key="' + esc(n.key) + '"><span class="dot" style="--c:' + tokenOf(n.group) + '"></span>' + esc(n.label) + "</button>";
  }
  function kindLabel(n) { return n.kind === "memory" ? "memória" : n.kind === "note" ? "nota sua" : "exemplo"; }
  function openPanel(n) {
    panelKey = n.key;
    var full = false;
    var rel = Array.from(ADJ.get(n.key) || []).map(nodeByKey).filter(Boolean).sort(function (a, b) { return a.label.localeCompare(b.label, "pt-BR"); });
    $("panel-head").innerHTML = '<div class="pn-group"><span class="dot" style="--c:' + tokenOf(n.group) + '"></span>' + esc(n.group) + " · " + kindLabel(n) + "</div>" +
      '<h2 id="panel-title">' + esc(n.label) + '</h2><div class="pn-path">' + esc(n.path || "") + "</div>";
    function body() {
      var text = n.kind === "memory" ? n.fact : full ? n.text : n.excerpt;
      var html = '<div class="pn-body">' + renderMd(text) + "</div>", foot = "";
      if (n.kind !== "memory" && !full && n.excerpt !== String(n.text || "").trim()) foot += '<button class="btn" type="button" id="pn-more">Ver nota inteira</button>';
      if (n.kind === "memory") {
        var anchor = n.anchor ? nodeByKey(n.anchor) : null;
        html += '<div class="pn-meta">Guardada em ' + esc(fmtDateTime(n.createdAt) || "—") + "</div>";
        if (anchor) html += '<div class="pn-section"><div class="pn-title">Âncora</div><div class="chips">' + chipHtml(anchor) + "</div></div>";
      }
      if (rel.length) html += '<div class="pn-section"><div class="pn-title">Ligada a</div><div class="chips">' + rel.map(chipHtml).join("") + "</div></div>";
      if (n.kind === "memory" || n.kind === "note") foot += '<button class="btn danger" type="button" id="pn-delete">Apagar</button>';
      $("panel-scroll").innerHTML = html;
      panelFoot(foot);
      var more = $("pn-more");
      if (more) more.addEventListener("click", function () {
        full = true;
        var sc = $("panel-scroll"), keep = sc.scrollTop;
        body();
        sc.scrollTop = keep; // continua de onde ele estava lendo
        panelEdge();
      });
      var del = $("pn-delete");
      if (del) twoTap(del, "Tocar de novo para apagar", function () {
        if (n.kind === "memory") deleteMemory(n.docId); else deleteImported(n.docId);
      });
    }
    body();
    showPanel(true);
  }
  function openCluster(nodes) {
    panelKey = null;
    $("panel-head").innerHTML = '<div class="pn-group">aglomerado</div><h2 id="panel-title">' + nodes.length + " notas sustentam a resposta</h2>";
    $("panel-scroll").innerHTML = '<div class="chips" style="margin-top:8px">' + nodes.map(chipHtml).join("") + "</div>";
    panelFoot("");
    showPanel(true);
  }
  function panelFoot(html) { var f = $("panel-foot"); f.innerHTML = html; f.hidden = !html; }
  // conteúdo maior que o painel: esmaece a borda de onde há mais texto (a mesma pista da lista de respostas)
  function panelEdge() {
    var sc = $("panel-scroll");
    sc.classList.toggle("more-below", sc.scrollTop + sc.clientHeight < sc.scrollHeight - 6);
    sc.classList.toggle("more-above", sc.scrollTop > 6);
  }
  $("panel-scroll").addEventListener("scroll", panelEdge, { passive: true });
  function showPanel(open) {
    var was = !$("panel").hidden;
    $("panel").hidden = !open;
    document.body.classList.toggle("panel-open", open);
    if (open) { $("panel-scroll").scrollTop = 0; panelEdge(); }
    if (!open) panelKey = null;
    if (was !== open) measureView(); // a área livre da galáxia muda com o painel
  }
  if (typeof window.ResizeObserver === "function") {
    try { new ResizeObserver(function () { measureView(); panelEdge(); }).observe($("panel")); } catch (e) { /* sem observador */ }
  }
  function closePanel() { showPanel(false); }
  $("panel-close").addEventListener("click", function () { overview(); });
  function twoTap(btn, armedText, action) {
    var original = btn.textContent, timer = 0;
    btn.addEventListener("click", function () {
      if (btn.classList.contains("armed")) {
        clearTimeout(timer);
        btn.disabled = true;
        action();
        return;
      }
      btn.classList.add("armed");
      btn.textContent = armedText;
      // tempo de sobra para ler o aviso e tocar de novo (no iPad, com calma); depois desarma sozinho
      timer = setTimeout(function () { btn.classList.remove("armed"); btn.textContent = original; }, 10000);
    });
  }
  // chips e wikilinks em qualquer lugar: voa até a estrela
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-key]");
    if (!el || el.classList.contains("dead")) return;
    var n = nodeByKey(el.dataset.key);
    if (n) focusNode(n);
  });

  // ------------------------------------------------------------ feed ----
  var MAX_EX = 14;
  // atTop: entra antes das trocas que já estão na lista (a saudação que chega depois de o usuário já ter perguntado)
  function addExchange(q, label, atTop) {
    var root = document.createElement("article");
    root.className = "ex glass";
    root.innerHTML = (q ? '<div class="ex-q"><b>' + esc(label || "Você") + "</b></div>" : "") + '<div class="ex-a"></div><div class="ex-meta"></div>';
    if (q) root.querySelector(".ex-q").appendChild(document.createTextNode(q));
    var feed = $("feed");
    if (atTop && feed.firstChild) feed.insertBefore(root, feed.firstChild);
    else {
      feedFollow = true;
      feed.appendChild(root);
      while (feed.children.length > MAX_EX) feed.removeChild(feed.firstChild);
    }
    var ex = { root: root, a: root.querySelector(".ex-a"), meta: root.querySelector(".ex-meta"), chips: null };
    scrollFeed();
    return ex;
  }
  // a lista mostra o começo da troca mais nova; se ela não cabe, o resto fica abaixo (lê-se de cima para baixo).
  // Rolar a lista com o dedo ou a roda solta esse acompanhamento até a próxima pergunta.
  var feedFollow = true;
  function scrollFeed() {
    var f = $("feed"), last = f.lastElementChild;
    if (feedFollow && last) {
      var max = f.scrollHeight - f.clientHeight;
      var top = last.getBoundingClientRect().top - f.getBoundingClientRect().top + f.scrollTop - 16; // a borda de cima no fim do esmaecido
      f.scrollTop = Math.max(0, Math.min(max, top));
    }
    feedEdge();
    if (typeof window.ResizeObserver !== "function") measureView();
  }
  function feedEdge() { var f = $("feed"); f.classList.toggle("more-below", f.scrollTop + f.clientHeight < f.scrollHeight - 6); }
  ["wheel", "touchmove"].forEach(function (ev) { $("feed").addEventListener(ev, function () { feedFollow = false; }, { passive: true }); });
  $("feed").addEventListener("scroll", feedEdge, { passive: true });
  function exPending(ex, label) { ex.a.classList.add("pending"); ex.a.textContent = label || "Pensando…"; scrollFeed(); }
  function exText(ex, text) { ex.a.classList.remove("pending"); ex.a.textContent = text; scrollFeed(); }
  function exMeta(ex, html) { ex.meta.insertAdjacentHTML("beforeend", html); scrollFeed(); }
  function exChips(ex, nodes) {
    if (!nodes.length) return;
    var div = document.createElement("div");
    div.className = "chips";
    div.innerHTML = nodes.map(chipHtml).join("");
    ex.root.insertBefore(div, ex.meta);
    scrollFeed();
  }
  function exArticles(ex, arts) {
    if (!arts.length) return;
    var sub = document.createElement("div");
    sub.className = "ex-sub";
    sub.textContent = "Fontes · PubMed";
    var div = document.createElement("div");
    div.className = "chips";
    div.innerHTML = arts.map(function (a) {
      var url = C.articleUrl(a);
      var meta = [a.journal, a.year].filter(Boolean).join(", ") + (a.doi ? " · doi:" + a.doi : a.pmid ? " · PMID " + a.pmid : "");
      return '<a class="chip" href="' + esc(url) + '" target="_blank" rel="noopener"><span class="dot"></span><span>' + esc(a.title) +
        ' <span class="meta">' + esc(meta) + "</span></span></a>";
    }).join("");
    ex.root.insertBefore(sub, ex.meta);
    ex.root.insertBefore(div, ex.meta);
    scrollFeed();
  }
  function exEvents(ex, events) {
    if (!events.length) return;
    var ul = document.createElement("ul");
    ul.className = "ev-list";
    ul.innerHTML = events.map(function (ev) {
      var t = ev.allDay ? "dia" : ev.time;
      var s = ev.htmlLink ? '<a href="' + esc(ev.htmlLink) + '" target="_blank" rel="noopener">' + esc(ev.summary) + "</a>" : '<span class="s">' + esc(ev.summary) + "</span>";
      return '<li><span class="ev-t">' + esc(t) + "</span>" + s + "</li>";
    }).join("");
    ex.root.insertBefore(ul, ex.meta);
    scrollFeed();
  }
  function exRetry(ex, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = "Tentar de novo";
    b.addEventListener("click", function () { b.disabled = true; userActs++; fn(); });
    ex.meta.appendChild(b);
    scrollFeed();
  }

  // ------------------------------------------------------------ áudio e voz ----
  var audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; audioCtx = new AC(); }
      if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  function chime(up) {
    try {
      var ctx = ensureAudio();
      if (!ctx || !S.settings.voice.on) return;
      var t = ctx.currentTime;
      [[up ? 520 : 660, 0], [up ? 780 : 440, 0.09], [up ? 1040 : 330, 0.18]].forEach(function (p) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = p[0];
        g.gain.setValueAtTime(0.0001, t + p[1]);
        g.gain.exponentialRampToValueAtTime(0.08, t + p[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + p[1] + 0.18);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + p[1]); o.stop(t + p[1] + 0.2);
      });
    } catch (e) { /* sem áudio, sem campainha */ }
  }

  // reator: o núcleo cresce a cada palavra falada e decai sozinho
  var pulseLevel = 0, pulseRaf = 0, pulseAt = 0;
  function pulse(amount) {
    pulseLevel = Math.max(pulseLevel, Math.min(1, amount));
    pulseAt = performance.now();
    if (!pulseRaf) pulseRaf = requestAnimationFrame(pulseStep);
  }
  function pulseStep(now) {
    pulseRaf = 0;
    var r = $("reactor");
    r.style.setProperty("--pulse", (1 + pulseLevel * 0.9).toFixed(3));
    pulseLevel *= Math.pow(0.82, Math.min(now - pulseAt, 200) / 16.7);
    pulseAt = now;
    if (pulseLevel > 0.02) pulseRaf = requestAnimationFrame(pulseStep);
    else r.style.setProperty("--pulse", "1");
  }

  var TOY_VOICES = /\b(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy)\b/i;
  var GOOD_VOICES = /\b(luciana|felipe|fernanda|francisca|antonio|thiago|daniel|arthur|serena|kate|oliver|ryan|sonia|libby|google uk english male|google português do brasil)\b/i;

  var Voice = {
    supported: (function () { try { return "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function"; } catch (e) { return false; } })(),
    unlocked: false, queue: [], current: null, keepAlive: 0, watchdog: 0, pulseTimer: 0, words: 0, lastCancel: -1000,
    voices: function () { try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; } },
    pick: function () {
      var vs = this.voices();
      if (!vs.length) return null;
      var uri = S.settings.voice.voiceURI;
      if (uri) { var chosen = vs.filter(function (v) { return v.voiceURI === uri; })[0]; if (chosen) return chosen; }
      var want = S.settings.lang.toLowerCase(), base = want.slice(0, 2);
      var norm = function (v) { return String(v.lang || "").toLowerCase().replace("_", "-"); };
      var exact = vs.filter(function (v) { return norm(v) === want; });
      var pool = exact.length ? exact : vs.filter(function (v) { return norm(v).indexOf(base) === 0; });
      var score = function (v) {
        return (/premium|enhanced|natural|neural|aprimorad/i.test(v.name) ? 4 : 0) + (GOOD_VOICES.test(v.name) ? 3 : 0) +
          (v.default ? 2 : 0) + (v.localService ? 1 : 0) - (TOY_VOICES.test(v.name) ? 10 : 0);
      };
      return pool.slice().sort(function (a, b) { return score(b) - score(a); })[0] || null;
    },
    unlock: function () { // a 1ª fala precisa nascer dentro do gesto do usuário (Safari/iOS)
      ensureAudio();
      if (this.unlocked || !this.supported) return;
      this.unlocked = true;
      try {
        var u = new window.SpeechSynthesisUtterance(" ");
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch (e) { /* voz indisponível */ }
    },
    say: function (chunk) {
      chunk = String(chunk || "").trim();
      if (!chunk || !this.supported || !S.settings.voice.on) return;
      this.queue.push(chunk);
      if (!this.current) this.next();
    },
    speakText: function (text) {
      var self = this;
      C.splitSentences(text).forEach(function (s) { self.say(s); });
    },
    next: function () {
      var self = this;
      clearTimeout(this.watchdog);
      if (!this.queue.length) { this.current = null; this.end(); return; }
      var wait = 90 - (performance.now() - this.lastCancel);
      if (wait > 0) {
        var hold = this.current = { hold: true };
        setTimeout(function () { if (self.current === hold) { self.current = null; self.next(); } }, wait);
        return;
      }
      var text = this.queue.shift();
      var u;
      try { u = new window.SpeechSynthesisUtterance(text); } catch (e) { this.queue = []; this.end(); return; }
      this.current = u; // referência global: o Chrome coleta e perde o onend
      var v = this.pick();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = S.settings.lang;
      u.rate = S.settings.voice.rate;
      u.pitch = 0.95;
      this.words = 0;
      u.onboundary = function (e) { self.words++; pulse(0.45 + Math.min((e && e.charLength) || 5, 12) / 20); };
      u.onstart = function () { if (self.current === u) self.begin(); };
      var finish = function () { if (self.current === u) { self.current = null; self.next(); } };
      u.onend = finish;
      u.onerror = finish;
      // rede de segurança: no iOS o onend às vezes não chega
      this.watchdog = setTimeout(function () {
        if (self.current !== u) return;
        self.current = null;
        try { window.speechSynthesis.cancel(); } catch (e) { /* nada */ }
        self.lastCancel = performance.now();
        self.next();
      }, 4000 + text.length * 110 / Math.max(0.8, S.settings.voice.rate));
      try { window.speechSynthesis.speak(u); } catch (e) { this.current = null; this.queue = []; this.end(); }
    },
    begin: function () {
      var self = this;
      if (!S.speaking) { S.speaking = true; renderHud(); }
      clearInterval(this.keepAlive);   // o Chrome corta falas longas sem isso
      this.keepAlive = setInterval(function () {
        try { var ss = window.speechSynthesis; if (ss.speaking && !ss.paused) { ss.pause(); ss.resume(); } } catch (e) { /* nada */ }
      }, 9000);
      clearInterval(this.pulseTimer);
      this.pulseTimer = setInterval(function () { if (!self.words) pulse(0.3 + Math.random() * 0.5); }, 230);
    },
    end: function () {
      clearInterval(this.keepAlive);
      clearInterval(this.pulseTimer);
      clearTimeout(this.watchdog);
      if (S.speaking) { S.speaking = false; renderHud(); }
    },
    stop: function () {
      this.queue = [];
      var had = !!this.current;
      this.current = null;
      try {
        if (this.supported && (had || window.speechSynthesis.speaking || window.speechSynthesis.pending)) { window.speechSynthesis.cancel(); this.lastCancel = performance.now(); }
      } catch (e) { /* nada */ }
      this.end();
    }
  };
  if (Voice.supported) {
    try {
      Voice.voices();
      window.speechSynthesis.addEventListener("voiceschanged", function () { renderVoiceList(); });
    } catch (e) { /* sem lista de vozes */ }
  }
  // qualquer controle tocado destrava a voz e o áudio
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest("button, a, label, input, select, textarea")) {
      if (!navigator.userActivation || navigator.userActivation.isActive) Voice.unlock();
    }
  }, true);

  // ------------------------------------------------------------ capabilities ----
  var samplePromise = useCap("sample").then(function (s) {
    var fn = typeof s === "function" ? s : null;
    if (!fn) { S.brain = "off"; S.brainNote = "O cérebro (Claude) não está disponível nesta visualização. Abra o JARVIS pelo claude.ai."; }
    else if (S.brain === "pending") S.brain = "on";
    renderHud();
    updateCardStatus();
    return fn;
  });
  var mcpPromise = useCap("mcp").then(function (m) { return m && typeof m.callTool === "function" ? m : null; });

  var BRAIN_OFF_CODES = { not_granted: 1, sampling_disabled: 1, not_declared: 1, capability_disabled: 1, capability_removed: 1 };
  var BRAIN_PERMISSION = "O cérebro precisa da sua permissão para usar o Claude. Recarregue e toque em Permitir.";
  function brainOff(code) {
    S.brain = "off";
    S.brainNote = code === "sampling_disabled" ? "O Claude está desligado para a sua conta ou organização; o cérebro fica desligado nesta visita." : BRAIN_PERMISSION;
    notice("brain", S.brainNote);
    renderHud();
  }
  // erros do sample por código (nunca tenta de novo sozinho)
  function sampleFailure(e, ex, retry) {
    var code = errCode(e);
    if (code === "cancelled") {
      if (e && e.text) { exText(ex, C.stripSources(e.text).text); exMeta(ex, '<span class="warn">parado</span>'); }
      else exText(ex, "Parado.");
      return;
    }
    if (BRAIN_OFF_CODES[code]) { brainOff(code); exText(ex, S.brainNote); return; }
    if (code === "rate_limited") {
      if (e && e.text) exText(ex, C.stripSources(e.text).text); else exText(ex, "");
      exMeta(ex, '<span class="err">Muitas perguntas seguidas ou limite da sua conta; tente daqui a pouco.</span>');
      return;
    }
    if (code === "session_expired") { exText(ex, "Entre de novo no claude.ai e recarregue o JARVIS."); setStatus("Sessão expirada: entre de novo no claude.ai.", true); return; }
    if (code === "refused") { exText(ex, C.REFUSAL_LINE[C.lgOf(S.settings.lang)]); exMeta(ex, '<span class="warn">O Claude recusou este pedido. Tente perguntar de outro jeito.</span>'); return; }
    if (code === "prompt_too_large") {
      S.compact = true;
      exText(ex, "A pergunta ficou grande demais com o contexto das notas. Reduzi o contexto para as próximas.");
      if (retry) exRetry(ex, retry);
      return;
    }
    if (code === "empty_completion") { exText(ex, "O Claude não devolveu resposta. Tente perguntar de outro jeito."); return; }
    if (code === "invalid_request" || code === "transform_error" || code === "queue_overflow" || code === "images_unavailable" || code === "tools_unavailable") {
      console.warn("JARVIS: pedido malformado ao sample", e);
      exText(ex, "Não consegui montar esse pedido. Tente de novo com outras palavras.");
      return;
    }
    // upstream_error e desconhecidos: mantém o parcial, marca interrompido, oferece repetir
    exText(ex, e && e.text ? C.stripSources(e.text).text : "");
    exMeta(ex, '<span class="err">Resposta interrompida (falha de conexão com o Claude).</span>');
    if (retry) exRetry(ex, retry);
  }
  function noteTier(res, asked) {
    var applied = res && res.modelTierApplied;
    if (!applied || applied === asked) return "";
    var k = asked + ">" + applied;
    if (S.tierNotes[k]) return "";
    S.tierNotes[k] = true;
    return '<span class="warn">Seu plano serviu o modo ' + esc(C.TIER_NAMES[applied] || applied) + " em vez de " + esc(C.TIER_NAMES[asked] || asked) + ".</span>";
  }

  // ------------------------------------------------------------ armazenamento (db + user) ----
  var Store = { mode: "pending", db: null, uid: null, memCol: null, notesCol: null, settingsRef: null, profile: null,
    readOnly: false, queues: new Map(), pendingMem: new Set(), deleting: new Set(), unsub: [] };
  var firstSnapDone = null;
  var firstSnap = new Promise(function (res) { firstSnapDone = res; });

  function serial(path, fn) { // uma escrita por vez por documento
    var prev = Store.queues.get(path) || Promise.resolve();
    var next = prev.catch(function () {}).then(fn);
    Store.queues.set(path, next);
    next.catch(function () {}).then(function () { if (Store.queues.get(path) === next) Store.queues.delete(path); });
    return next;
  }
  function dbFailure(e, what) {
    var code = errCode(e);
    if (code === "invalid_argument" || code === "transform_error" || code === "revoked" || code === "not_granted" ||
        code === "capability_disabled" || code === "capability_removed") {
      if (!Store.readOnly) {
        Store.readOnly = true;
        S.storage = "readonly";
        if (code !== "revoked") notice("storage", "Não consegui gravar na sua conta; nesta visita, " + what + " fica só na tela.");
        renderStorage();
      }
    } else if (code === "quota_exceeded") {
      notice("quota", "O espaço de dados do JARVIS encheu. Apague memórias ou notas importadas antigas para liberar.");
    } else if (code === "resource_exhausted") {
      notice("busy-db", "Muitas gravações seguidas; espere alguns segundos e tente de novo.");
    } else {
      notice("db-down", "O armazenamento da sua conta não respondeu; " + what + " pode não ter sido salvo.");
    }
  }
  function dbWrite(path, fn, what) {
    if (Store.readOnly) return Promise.reject({ code: "readonly" });
    return serial(path, function () {
      return Promise.resolve().then(fn).catch(function (e) {
        var code = errCode(e);
        var transient = code === "unavailable" || ["invalid_argument", "resource_exhausted", "quota_exceeded", "revoked", "not_granted",
          "capability_disabled", "capability_removed", "transform_error"].indexOf(code) < 0;
        if (!transient) throw e;
        return sleep(300 + Math.random() * 1200).then(fn); // uma nova tentativa, após atraso aleatório
      });
    }).catch(function (e) { dbFailure(e, what || "a mudança"); throw e; });
  }
  function fitDoc(doc, field) { // mantém o documento abaixo de 256 KiB
    var limit = 240000;
    while (C.utf8Len(JSON.stringify(doc)) > limit && doc[field].length > 1000) {
      doc[field] = doc[field].slice(0, Math.floor(doc[field].length * 0.85));
    }
    return doc;
  }

  function applyMemoryDocs(docs) {
    firstSnapDone();
    var next = new Map(), changed = false;
    docs.forEach(function (d) {
      if (!d || d.exists === false) return;
      var data = typeof d.data === "function" ? d.data() : null;
      if (!data || Store.deleting.has(d.id)) return;
      var fresh = makeMemory(d.id, data), old = memories.get(d.id);
      if (old && sameContent(old, fresh)) next.set(d.id, old);
      else if (old) { Object.assign(old, fresh); next.set(d.id, old); changed = true; }
      else { next.set(d.id, fresh); changed = true; }
    });
    memories.forEach(function (m, id) {
      if (next.has(id)) return;
      if (Store.pendingMem.has(id)) next.set(id, m); // escrita nossa ainda a caminho
      else changed = true;
    });
    if (changed || next.size !== memories.size) { memories = next; rebuildGalaxy(); }
  }
  function applyNoteDocs(docs) {
    var next = new Map(), changed = false;
    docs.forEach(function (d) {
      if (!d || d.exists === false) return;
      var data = typeof d.data === "function" ? d.data() : null;
      if (!data || Store.deleting.has(d.id)) return;
      var fresh = makeImported(d.id, data), old = imported.get(d.id);
      if (old && sameContent(old, fresh)) next.set(d.id, old);
      else if (old) { Object.assign(old, fresh); next.set(d.id, old); changed = true; }
      else { next.set(d.id, fresh); changed = true; }
    });
    imported.forEach(function (n, id) {
      if (next.has(id)) return;
      if (Store.pendingMem.has(id)) next.set(id, n);
      else changed = true;
    });
    if (changed || next.size !== imported.size) { imported = next; rebuildGalaxy(); renderImportCount(); }
  }
  function subscribe(col, apply, label, retried) { // inscreve uma vez por coleção, no boot
    try {
      var un = col.onSnapshot(function (snap) {
        try { apply(snap && snap.docs ? snap.docs : []); } catch (e) { console.warn("JARVIS: snapshot", e); }
      }, function (e) {
        var code = errCode(e);
        firstSnapDone();
        if (code === "unavailable" && !retried) { // ponte morta: uma inscrição nova é a única saída
          setTimeout(function () { subscribe(col, apply, label, true); }, 800 + Math.random() * 2000);
        } else if (code === "revoked") {
          firstSnapDone();
          Store.readOnly = true; S.storage = "readonly"; renderStorage();
        } else {
          notice("sub-" + label, "Parei de receber atualizações de " + label + " (" + code + "). Recarregue a página para retomar.");
        }
      });
      if (typeof un === "function") Store.unsub.push(un);
    } catch (e) {
      firstSnapDone();
      console.warn("JARVIS: inscrição falhou", e);
      notice("sub-" + label, "Não consegui ler " + label + " da sua conta agora.");
    }
  }

  function loadLocal() {
    var mems = readJSON(LSK.memories, []);
    if (Array.isArray(mems)) mems.forEach(function (m) { if (m && m.id && m.text) memories.set(String(m.id), makeMemory(String(m.id), m)); });
    var notes = readJSON(LSK.notes, []);
    if (Array.isArray(notes)) notes.forEach(function (n) { if (n && n.id && typeof n.text === "string") imported.set(String(n.id), makeImported(String(n.id), n)); });
  }
  function saveLocalMemories() {
    var arr = Array.from(memories.values()).map(function (m) { return { id: m.docId, text: m.fact, title: m.title, createdAt: m.createdAt, anchor: m.anchor }; });
    if (!LS.set(LSK.memories, JSON.stringify(arr))) notice("ls", "O navegador não deixou guardar as memórias neste aparelho (modo privado?). Elas valem só nesta visita.");
  }
  function saveLocalNotes() {
    var arr = Array.from(imported.values()).map(function (n) { return { id: n.docId, label: n.label, group: n.group, text: n.text, importedAt: n.importedAt }; });
    if (!LS.set(LSK.notes, JSON.stringify(arr))) notice("ls-notes", "As notas importadas não couberam no armazenamento do navegador; valem só nesta visita.");
  }

  function renderStorage() {
    var el = $("set-storage");
    el.textContent = S.storage === "account" ? "Memórias, notas, diário e ajustes ficam guardados na sua conta, só para você."
      : S.storage === "readonly" ? "Sua conta recusou gravações nesta visita; o que você mudar agora fica só na tela."
      : S.storage === "local" ? "Sem conta conectada: memórias só neste aparelho. Abra pelo claude.ai, com sua conta, para guardá-las na nuvem."
      : "Verificando onde guardar suas memórias…";
  }

  var bootReady = (async function bootStore() {
    var caps = await Promise.all([useCap("db"), useCap("user")]);
    var db = caps[0], user = caps[1], uid = null;
    if (user) {
      try {
        if (typeof user.id === "function") uid = await user.id();
        else if (typeof user.me === "function") { var me = await user.me(); uid = me && me.id; }
      } catch (e) { uid = null; }
    }
    if (db && typeof db.doc === "function" && typeof uid === "string" && uid) {
      try {
        Store.settingsRef = db.doc("data/users/" + uid + "/settings");
        Store.profile = db.doc("data/users/" + uid + "/profile");
        Store.memCol = Store.profile.collection("memories");
        Store.notesCol = Store.profile.collection("notes");
        Store.daysCol = Store.profile.collection("days");
        Store.db = db; Store.uid = uid; Store.mode = "account"; S.storage = "account";
      } catch (e) {
        console.warn("JARVIS: caminho do db recusado", e);
        Store.mode = "local";
      }
    } else Store.mode = "local";
    if (Store.mode === "account") {
      subscribe(Store.memCol, applyMemoryDocs, "memórias");
      subscribe(Store.notesCol, applyNoteDocs, "notas importadas");
      try {
        var snap = await Store.settingsRef.get();
        var sdata = snap && snap.exists !== false && typeof snap.data === "function" ? snap.data() : null;
        if (sdata && !S.settingsTouched) {
          S.settings = sanitizeSettings(sdata);
          lastSavedSettings = JSON.stringify(S.settings);
          LS.set(LSK.settings, lastSavedSettings);
          applySettings(true);
        } else if (sdata) lastSavedSettings = JSON.stringify(sanitizeSettings(sdata));
      } catch (e) { console.warn("JARVIS: ajustes da conta ilegíveis", e); }
    } else {
      S.storage = "local";
      firstSnapDone();
      loadLocal();
      rebuildGalaxy();
      notice("storage-local", "Sem conta conectada: memórias só neste aparelho.", "info");
    }
    renderStorage();
    renderImportCount();
    updateCardStatus();
  })().catch(function (e) {
    console.warn("JARVIS: armazenamento", e);
    if (Store.mode === "pending") Store.mode = "local";
    if (Store.mode === "local") S.storage = "local";
    firstSnapDone();
    renderStorage();
  });

  // ------------------------------------------------------------ ajustes ----
  var lastSavedSettings = JSON.stringify(S.settings), settingsTimer = 0;
  function persistSettings() {
    LS.set(LSK.settings, JSON.stringify(S.settings));
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () { // junta uma rajada de mudanças numa escrita só
      var body = JSON.stringify(S.settings);
      if (body === lastSavedSettings) return;
      if (Store.mode !== "account" || Store.readOnly || !Store.settingsRef) return;
      var data = JSON.parse(body);
      dbWrite(Store.settingsRef.path || "settings", function () { return Store.settingsRef.set(data); }, "o ajuste")
        .then(function () { lastSavedSettings = body; }).catch(function () {});
    }, 900);
  }
  function changeSettings(mut, logWhat) {
    S.settingsTouched = true;
    var before = JSON.stringify(S.settings);
    mut(S.settings);
    S.settings = sanitizeSettings(S.settings);
    if (JSON.stringify(S.settings) === before) return false;
    applySettings(false);
    persistSettings();
    if (logWhat) logEvent({ kind: "settings", q: logWhat, a: "" });
    return true;
  }
  function applySettings(fromStore) {
    var st = S.settings;
    ["quick", "default", "complex"].forEach(function (t) { $("tier-" + t).checked = st.tier === t; });
    $("set-humor").value = st.humor;
    $("set-humor-out").textContent = st.humor + "%";
    $("set-voice").checked = st.voice.on;
    $("set-rate").value = st.voice.rate;
    $("set-rate-out").textContent = st.voice.rate.toFixed(2).replace(".", ",") + "×";
    $("set-lang").value = st.lang;
    $("set-hide-samples").checked = st.hideSamples;
    renderVoiceList();
    if (!st.voice.on) Voice.stop();
    var hidden = LIST.some(function (n) { return n.kind === "sample"; }) === st.hideSamples;
    if (hidden || fromStore) rebuildGalaxy();
    renderHud();
  }
  function renderVoiceList() {
    var sel = $("set-voiceuri");
    var vs = Voice.voices();
    var base = S.settings.lang.slice(0, 2).toLowerCase();
    var list = vs.filter(function (v) { return String(v.lang || "").toLowerCase().indexOf(base) === 0; })
      .sort(function (a, b) { return cmp(a.name, b.name); });
    var html = '<option value="">Automática (a melhor disponível)</option>' + list.map(function (v) {
      return '<option value="' + esc(v.voiceURI) + '">' + esc(v.name + " · " + v.lang) + "</option>";
    }).join("");
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = list.some(function (v) { return v.voiceURI === S.settings.voice.voiceURI; }) ? S.settings.voice.voiceURI : "";
  }
  ["quick", "default", "complex"].forEach(function (t) {
    $("tier-" + t).addEventListener("change", function () { if (this.checked) changeSettings(function (s) { s.tier = t; }, "modo " + C.TIER_NAMES[t]); });
  });
  $("set-humor").addEventListener("input", function () {
    var v = +this.value;
    $("set-humor-out").textContent = v + "%";
    changeSettings(function (s) { s.humor = v; });
  });
  $("set-humor").addEventListener("change", function () { logEvent({ kind: "settings", q: "humor " + S.settings.humor + "%", a: "" }); });
  $("set-voice").addEventListener("change", function () { var on = this.checked; changeSettings(function (s) { s.voice.on = on; }, on ? "voz ligada" : "voz desligada"); });
  $("set-rate").addEventListener("input", function () { var v = +this.value; changeSettings(function (s) { s.voice.rate = v; }); });
  $("set-voiceuri").addEventListener("change", function () { var v = this.value; changeSettings(function (s) { s.voice.voiceURI = v; }); });
  $("set-lang").addEventListener("change", function () { var v = this.value; changeSettings(function (s) { s.lang = v; s.voice.voiceURI = ""; }, "idioma " + v); });
  $("set-hide-samples").addEventListener("change", function () {
    var v = this.checked;
    changeSettings(function (s) { s.hideSamples = v; }, v ? "escondeu as notas de exemplo" : "mostrou as notas de exemplo");
  });
  $("set-test-voice").addEventListener("click", function () {
    Voice.unlock();
    Voice.stop();
    if (!Voice.supported) { setStatus("Este navegador não tem voz falada.", true, 5000); return; }
    if (!S.settings.voice.on) { setStatus("A voz está desligada.", false, 4000); return; }
    Voice.speakText(C.lgOf(S.settings.lang) === "pt" ? "Às suas ordens, senhor. Esta é a minha voz." : "At your service, sir. This is my voice.");
  });
  $("chip-tier").addEventListener("click", function () { openSheet("settings"); });
  $("chip-humor").addEventListener("click", function () { openSheet("settings"); });

  // ------------------------------------------------------------ diário (db) ----
  function dayDoc(date) { return Store.daysCol.doc(date); }
  // corta em até n caracteres numa fronteira de palavra, com reticências (o diário mostra o trecho inteiro)
  function clipText(v, n) {
    var s = String(v == null ? "" : v).trim();
    if (s.length <= n) return s;
    var c = s.slice(0, n - 1), sp = c.lastIndexOf(" ");
    if (sp > n * 0.6) c = c.slice(0, sp);
    if (/[\ud800-\udbff]$/.test(c)) c = c.slice(0, -1);
    return c.replace(/[\s,;:.\u2014-]+$/, "") + "…";
  }
  // documento do dia: no máximo 200 eventos e sempre abaixo do limite de 256 KiB do db (descarta os mais antigos)
  function fitDay(doc) {
    doc.events = doc.events.slice(-200);
    while (doc.events.length > 1 && C.utf8Len(JSON.stringify(doc)) > 230000) doc.events.shift();
    return doc;
  }
  var pendingLog = [];
  function logEvent(ev) {
    try {
      var now = new Date();
      var date = C.isoDate(now);
      var entry = { t: now.toISOString(), kind: ev.kind, q: clipText(ev.q, 300), a: clipText(ev.a, 300),
        sources: (ev.sources || []).slice(0, 8).map(function (s) { return String(s).slice(0, 120); }) };
      if (Store.mode === "pending") { // a conta ainda está resolvendo: o evento espera por ela, não se perde
        if (!pendingLog.length) bootReady.then(flushLog, flushLog);
        pendingLog.push({ date: date, entry: entry });
        return;
      }
      writeEvents(date, [entry]);
    } catch (e) { console.warn("JARVIS: diário", e); }
  }
  function flushLog() {
    var items = pendingLog.splice(0), byDate = {};
    if (Store.mode === "pending") Store.mode = "local";
    items.forEach(function (it) { (byDate[it.date] = byDate[it.date] || []).push(it.entry); });
    Object.keys(byDate).forEach(function (d) { try { writeEvents(d, byDate[d]); } catch (e) { console.warn("JARVIS: diário", e); } });
  }
  function writeLocalDay(date, entries) {
    var days = readJSON(LSK.days, {});
    if (!days || typeof days !== "object") days = {};
    var d = days[date] || { date: date, events: [] };
    d.events = (Array.isArray(d.events) ? d.events : []).concat(entries).slice(-200);
    days[date] = d;
    var keys = Object.keys(days).sort();
    while (keys.length > 60) delete days[keys.shift()];
    LS.set(LSK.days, JSON.stringify(days));
  }
  function writeEvents(date, entries) {
    if (Store.mode === "account" && !Store.readOnly && Store.daysCol) {
      var ref = dayDoc(date);
      dbWrite(ref.path || ("days/" + date), function () {
        return ref.get().then(function (snap) {
          var cur = snap && snap.exists !== false && typeof snap.data === "function" ? snap.data() : null;
          var events = cur && Array.isArray(cur.events) ? cur.events.slice() : [];
          return ref.set(fitDay({ date: date, events: events.concat(entries) }));
        });
      }, "o diário").catch(function () { writeLocalDay(date, entries); }); // recusado: ao menos fica neste aparelho
    } else writeLocalDay(date, entries);
  }
  async function readDays(dates) {
    var days = readJSON(LSK.days, {}) || {};
    var local = function (d) { return (days[d] && Array.isArray(days[d].events)) ? days[d].events : []; };
    if (Store.mode === "account" && Store.daysCol) {
      var snaps = await Promise.all(dates.map(function (d) {
        return dayDoc(d).get().catch(function () { return null; });
      }));
      return snaps.map(function (s, i) {
        var data = s && s.exists !== false && typeof s.data === "function" ? s.data() : null;
        var evs = data && Array.isArray(data.events) ? data.events : [];
        // conta recusou gravações nesta visita: o que ficou no aparelho entra junto
        if (Store.readOnly) evs = evs.concat(local(dates[i])).sort(function (a, b) { return cmp(String(a.t), String(b.t)); });
        return { date: dates[i], events: evs };
      });
    }
    return dates.map(function (d) { return { date: d, events: local(d) }; });
  }
  var KIND_PT = { ask: "pergunta", research: "pubmed", remember: "memória", briefing: "briefing", settings: "ajuste", journal: "diário" };

  // ------------------------------------------------------------ agenda (mcp) ----
  var GCAL = "Google Calendar", PUBMED = "PubMed";
  var agendaCache = null, agendaWarned = false;
  function payloadOf(res) {
    if (!res || typeof res !== "object") return res;
    if ("payload" in res && res.payload !== undefined) return res.payload;
    if (res.structuredContent) return res.structuredContent;
    var blocks = Array.isArray(res.content) ? res.content : [];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i] && blocks[i].type === "text") { try { return JSON.parse(blocks[i].text); } catch (e) { return blocks[i].text; } }
    }
    return res;
  }
  function mcpCopy(e, server) {
    var cal = server === GCAL, code = errCode(e);
    var name = cal ? "o Google Agenda" : "o PubMed";
    switch (code) {
      case "server_not_connected": case "selection_required": case "server_not_found":
        return "Conecte " + name + " em claude.ai → Configurações → Conectores.";
      case "needs_reauth":
        return "Reconecte " + name + " em claude.ai → Configurações → Conectores.";
      case "not_in_manifest": case "consent_required":
        return cal ? "Você não liberou a agenda para o JARVIS; dá para liberar no menu de permissões do artifact."
          : "Você não liberou o PubMed para o JARVIS; dá para liberar no menu de permissões do artifact.";
      case "blocked_by_policy": case "approval_required":
        return cal ? "A agenda está bloqueada pela sua organização." : "O PubMed está bloqueado pela sua organização.";
      case "no_mcp": case "not_granted": case "capability_disabled": case "capability_removed":
        return "Os conectores não estão disponíveis nesta visualização; abra o JARVIS pelo claude.ai.";
      case "tool_error": // o serviço respondeu, mas recusou o pedido: diz o que houve, o que fazer e o detalhe que ele mandou
        return (cal ? "O Google Agenda recusou a leitura da agenda (erro do próprio serviço). Tente de novo em alguns minutos."
          : "O PubMed recusou esta busca (erro do próprio serviço). Tente de novo em alguns minutos ou mude as palavras da pesquisa.") +
          mcpDetail(e);
      case "server_unavailable":
        return (cal ? "O Google Agenda" : "O PubMed") + " não respondeu (fora do ar ou lento). Tente de novo em alguns minutos.";
      case "rate_limited":
        return "Muitas consultas seguidas " + (cal ? "à agenda" : "ao PubMed") + "; espere alguns segundos e tente de novo.";
      case "user_changed":
        return "A conta mudou; recarregue a página.";
      default:
        return (cal ? "Não consegui ler a agenda agora." : "Não consegui consultar o PubMed agora.") + " Tente de novo em instantes; se continuar, recarregue a página.";
    }
  }
  // códigos que só a pessoa resolve (conectar, reconectar, liberar, política): sem botão de tentar de novo
  var NEEDS_USER = { server_not_connected: 1, selection_required: 1, server_not_found: 1, needs_reauth: 1, not_in_manifest: 1,
    consent_required: 1, blocked_by_policy: 1, approval_required: 1, no_mcp: 1, not_granted: 1, capability_disabled: 1,
    capability_removed: 1, user_changed: 1, bad_request: 1, transform_error: 1 };
  function mcpDetail(e) { // a mensagem que o conector mandou, curta e só como detalhe técnico
    var m = e && typeof e.message === "string" ? e.message.replace(/\s+/g, " ").trim() : "";
    return m ? " (Detalhe técnico: " + m.slice(0, 120) + ")" : "";
  }
  async function callMcp(server, tool, input, signal) {
    var mcp = await mcpPromise;
    if (!mcp) throw { code: "no_mcp", message: "mcp indisponível" };
    var opts = signal ? { signal: signal } : undefined;
    try {
      return await mcp.callTool(server, tool, input, opts);
    } catch (e) {
      // só leitura, e só com retryable: uma nova tentativa após retryAfterMs (ou 1–3 s)
      if (e && e.retryable === true && !(signal && signal.aborted)) {
        var wait = typeof e.retryAfterMs === "number" ? e.retryAfterMs : 1000 + Math.random() * 2000;
        if (wait <= 8000) {
          await sleep(wait);
          if (signal && signal.aborted) throw { code: "cancelled" };
          return await mcp.callTool(server, tool, input, opts);
        }
      }
      throw e;
    }
  }
  async function todayEvents(force, signal) {
    var range = C.dayRange(new Date());
    if (!force && agendaCache && agendaCache.date === range.date && Date.now() - agendaCache.at < 600000) return agendaCache.events;
    setAgendaState("loading");
    try {
      var input = { startTime: range.startTime, endTime: range.endTime, orderBy: "startTime", pageSize: 20 };
      if (TZ) input.timeZone = TZ;
      var res = await callMcp(GCAL, "list_events", input, signal);
      var events = C.normalizeEvents(payloadOf(res));
      agendaCache = { date: range.date, at: Date.now(), events: events };
      setAgendaState("ok", "", events.length);
      return events;
    } catch (e) {
      if (errCode(e) === "cancelled") { setAgendaState(agendaCache ? "ok" : "idle"); throw e; }
      setAgendaState(errCode(e) === "no_mcp" ? "off" : "error", mcpCopy(e, GCAL));
      throw e;
    }
  }

  // ------------------------------------------------------------ fluxo de conversa ----
  var RUN = null; // pedido em andamento: {ctl}
  // ações do usuário (mensagem enviada, Parar, "silêncio", toque no reator, briefing pedido, Tentar de novo).
  // Só uma ação dele cancela um pedido; o que a página faz sozinha (o briefing da ativação) nunca passa na frente.
  var userActs = 0;
  function startRun(ex, keepVoice) {
    stopRun(keepVoice);
    var run = { ctl: new AbortController(), ex: ex || null };
    RUN = run;
    return run;
  }
  function stopRun(keepVoice) {
    if (RUN) {
      var old = RUN;
      RUN = null;
      try { old.ctl.abort(); } catch (e) { /* já abortado */ }
      if (old.ex && old.ex.a.classList.contains("pending")) {
        if (old.auto) { // briefing automático atropelado por um pedido do usuário: vira dica, não "Parado."
          exText(old.ex, C.lgOf(S.settings.lang) === "pt" ? "Briefing adiado." : "Briefing postponed.");
          exMeta(old.ex, C.lgOf(S.settings.lang) === "pt" ? "é só dizer “o que tenho hoje?”" : "just say “what's on today?”");
        } else exText(old.ex, "Parado.");
      }
    }
    setThinking(false);
    setStreaming(false);
    if (!keepVoice) Voice.stop();
  }
  function alive(run) { return RUN === run && !run.ctl.signal.aborted; }
  function endRun(run) { if (RUN === run) { RUN = null; setThinking(false); setStreaming(false); } }
  function setThinking(on) { if (S.thinking !== on) { S.thinking = on; renderHud(); } }
  function setStreaming(on) { if (S.streaming !== on) { S.streaming = on; renderHud(); } }

  function renderSend() {
    var btn = $("send");
    var busy = S.thinking || S.streaming || S.speaking;
    var stop = busy && !$("q").value.trim();
    btn.textContent = stop ? "Parar" : "Enviar";
    btn.classList.toggle("is-stop", stop);
    btn.setAttribute("aria-label", stop ? "Parar a resposta" : "Enviar pergunta");
  }

  // texto que o sample vai escrevendo → bolha + fala frase a frase (sem marcador parcial)
  function streamer(ex, run) {
    var spoken = 0, first = true;
    return {
      update: function (text) {
        if (!alive(run)) return;
        var vis = C.stripSources(text, { streaming: true }).text;
        if (first) { first = false; setThinking(false); setStreaming(true); setStatus(""); }
        exText(ex, vis);
        this.feed(vis, false);
      },
      feed: function (vis, final) {
        if (vis.length < spoken) return;
        var r = C.takeSentences(vis.slice(spoken), final);
        if (r.consumed > 0) { spoken += r.consumed; r.sentences.forEach(function (s) { Voice.say(s); }); }
      }
    };
  }
  function pushHistory(q, a) {
    S.history.push({ role: "user", content: q }, { role: "assistant", content: a });
    S.history = S.history.slice(-C.HISTORY_TURNS * 2);
  }
  function retrievalItems(question, prev) {
    var k = S.compact ? 3 : C.TOP_K;
    var picks = C.retrieve(INDEX, question, prev, k);
    var map = {};
    var items = picks.map(function (i) {
      var n = LIST[i], id = "n" + i;
      map[id] = n.key;
      return { id: id, label: n.label, group: n.group, text: n.kind === "memory" ? n.fact : n.text,
        date: n.kind === "memory" ? C.isoDate(new Date(n.createdAt || Date.now())) : "" };
    });
    return { items: items, map: map, keys: picks.map(function (i) { return LIST[i].key; }) };
  }

  async function ask(question, intent) {
    var ex = addExchange(question);
    var run = startRun(ex);
    var prev = S.lastQuestion;
    S.lastQuestion = question;
    exPending(ex, "Pensando…");
    setThinking(true);
    var sample = await samplePromise;
    if (!alive(run)) return;
    var ret = retrievalItems(question, prev);
    if (!sample || S.brain === "off") { // sem cérebro: ainda mostro as notas mais próximas
      exText(ex, (S.brainNote || BRAIN_PERMISSION) + (ret.keys.length ? " Separei as notas mais próximas da pergunta." : ""));
      var nodes = ret.keys.slice(0, 3).map(nodeByKey).filter(Boolean);
      exChips(ex, nodes);
      flyToSources(nodes.map(function (n) { return n.key; }));
      endRun(run);
      return;
    }
    var agendaText = "";
    if (intent && intent.agenda && (await mcpPromise)) {
      try {
        var evs = await todayEvents(false, run.ctl.signal);
        agendaText = C.agendaBlock(evs, { date: C.dayRange(new Date()).date, timeZone: TZ, descChars: S.compact ? 2000 : 6000 });
      } catch (e) {
        if (!alive(run)) return;
        exMeta(ex, '<span class="warn">' + esc(mcpCopy(e, GCAL)) + "</span>");
      }
      if (!alive(run)) return;
    }
    var instructions = C.chatInstructions({ lang: S.settings.lang, humor: S.settings.humor,
      notesBlock: C.notesBlock(ret.items, S.compact ? 3000 : C.NOTE_CHARS), agendaBlock: agendaText });
    var fit = C.fitTurns(instructions, S.compact ? [] : S.history, question);
    var st = streamer(ex, run), tier = S.settings.tier;
    try {
      var res = await sample(fit.turns, { onText: function (u) { st.update(u.text); }, signal: run.ctl.signal, modelTier: tier, cache: false });
      if (!alive(run)) return;
      var out = C.stripSources(res.text);
      var answer = out.text;
      if (!answer) { sampleFailure({ code: "empty_completion" }, ex); return; }
      exText(ex, answer);
      st.feed(answer, true);
      var keys = out.ids.map(function (id) { return ret.map[id]; }).filter(function (k) { return k && nodeByKey(k); });
      keys = keys.filter(function (k, i) { return keys.indexOf(k) === i; });
      exChips(ex, keys.map(nodeByKey));
      var tn = noteTier(res, tier);
      if (tn) exMeta(ex, tn);
      if (res.truncated) exMeta(ex, '<span class="warn">Resposta cortada no limite de tamanho; peça menos de cada vez.</span>');
      pushHistory(question, res.text);
      S.lastAnswer = answer; S.lastSources = keys;
      S.compact = false;
      flyToSources(keys);
      logEvent({ kind: "ask", q: question, a: answer, sources: keys.map(function (k) { var n = nodeByKey(k); return n ? n.label : k; }) });
    } catch (e) {
      if (errCode(e) === "cancelled") sampleFailure(e, ex);
      else sampleFailure(e, ex, function () { ask(question, intent); });
    } finally {
      endRun(run);
    }
  }

  async function remember(fact, original) {
    var ex = addExchange(original);
    var run = startRun(null);
    exPending(ex, "Guardando na memória…");
    var title = C.makeTitle(fact);
    var anchorIdx = null;
    try { anchorIdx = C.mostRelated(INDEX, fact); } catch (e) { anchorIdx = null; }
    var anchor = anchorIdx !== null && LIST[anchorIdx] ? LIST[anchorIdx] : null;
    var id = newId("m");
    var data = { text: fact, title: title, createdAt: new Date().toISOString(), anchor: anchor ? anchor.key : null };
    var m = makeMemory(id, data);
    // nasce colada na nota-mãe, com pulso de luz; sem âncora, nasce na borda da galáxia
    var jitter = function () { return (Math.random() - 0.5) * 6; };
    var hasAnchor = !!(anchor && anchor.x != null);
    var at = hasAnchor ? anchor : edgePoint();
    m.__new = true;
    m.__off = { x: jitter(), y: jitter(), z: jitter() };
    m.x = (at.x || 0) + m.__off.x; m.y = (at.y || 0) + m.__off.y; m.z = (at.z || 0) + m.__off.z;
    m.fx = m.x; m.fy = m.y; m.fz = m.z;
    m.__anchor = hasAnchor ? anchor : null;
    m.__followUntil = performance.now() + (hasAnchor ? 900 : 2600);
    Store.pendingMem.add(id);
    memories.set(id, m);
    rebuildGalaxy();
    disarmFrame(); // o voo até a memória nova vem logo abaixo
    m.__pulse = performance.now();
    setTimeout(function () { if (nodeByKey(m.key)) focusNode(m, 1600, true); }, 350);

    // a conta ainda pode estar resolvendo (use() leva até ~10 s): espera o armazenamento decidir antes de gravar,
    // senão a memória iria só para o aparelho e sumiria quando a lista da conta chegasse
    var writeMem = function () {
      var ref = Store.memCol.doc(id);
      return dbWrite(ref.path || ("memories/" + id), function () { return ref.set(data); }, "a memória")
        .then(function () { return true; }, function () { return false; });
    };
    var saved = (async function () {
      if (Store.mode === "pending") {
        exPending(ex, "Guardando na memória… (conectando à sua conta)");
        await Promise.race([bootReady, sleep(12000)]);
      }
      if (Store.mode === "account") return Store.readOnly ? false : writeMem();
      saveLocalMemories();
      if (Store.mode === "pending") { // a conta não respondeu a tempo: fica no aparelho e sobe quando ela chegar
        bootReady.then(function () {
          if (Store.mode === "account" && !Store.readOnly && memories.has(id)) return writeMem();
        }).catch(function () {}).then(function () { Store.pendingMem.delete(id); });
        return "later";
      }
      return true;
    })();
    saved.then(function (r) { if (r !== "later") Store.pendingMem.delete(id); });

    var line = "";
    var sample = await samplePromise;
    if (sample && S.brain === "on" && alive(run)) {
      setThinking(true);
      try {
        var res = await sample(C.quipInstructions({ lang: S.settings.lang, humor: S.settings.humor, title: title, fact: fact }),
          { modelTier: "quick", signal: run.ctl.signal, cache: false });
        line = C.stripSources(res.text).text.replace(/\s+/g, " ").trim().slice(0, 220);
      } catch (e) {
        if (BRAIN_OFF_CODES[errCode(e)]) brainOff(errCode(e));
      }
      if (RUN === run) setThinking(false);
    }
    if (!line) line = C.cannedLine(S.settings.lang);
    var ok = await saved;
    exText(ex, line);
    exChips(ex, [m]);
    if (!ok) exMeta(ex, '<span class="warn">Não consegui salvar na sua conta; esta memória vale só nesta visita.</span>');
    else if (ok === "later") exMeta(ex, '<span class="warn">Sua conta ainda não respondeu: guardei neste aparelho e envio para a conta assim que ela conectar.</span>');
    else if (Store.mode === "local") exMeta(ex, '<span class="warn">Guardada só neste aparelho.</span>');
    if (RUN === run) Voice.speakText(line);
    logEvent({ kind: "remember", q: fact, a: title, sources: anchor ? [anchor.label] : [] });
    endRun(run);
  }

  async function research(query, original) {
    var ex = addExchange(original);
    var run = startRun(ex);
    exPending(ex, "Pesquisando no PubMed…");
    setThinking(true);
    var sample = await samplePromise;
    if (!(await mcpPromise)) {
      exText(ex, mcpCopy({ code: "no_mcp" }, PUBMED));
      endRun(run);
      return;
    }
    var q = query;
    if (sample && S.brain === "on" && typeof sample.json === "function") { // consulta PubMed em inglês; se falhar, vai o texto cru
      try {
        var j = await sample.json(C.pubmedQueryPrompt(query), { modelTier: "quick", signal: run.ctl.signal });
        if (j && typeof j.query === "string" && j.query.trim().length >= 2) q = j.query.trim().slice(0, 300);
      } catch (e) {
        if (!alive(run)) return;
        var jc = errCode(e);
        if (BRAIN_OFF_CODES[jc] && jc !== "capability_removed") brainOff(jc);
      }
    }
    if (!alive(run)) return;
    var arts = [];
    try {
      var found = await callMcp(PUBMED, "search_articles", { query: q, max_results: 5, sort: "relevance" }, run.ctl.signal);
      var pmids = C.pmidsFrom(payloadOf(found));
      if (!alive(run)) return;
      if (pmids.length) {
        var meta = await callMcp(PUBMED, "get_article_metadata", { pmids: pmids }, run.ctl.signal);
        arts = C.articlesFrom(payloadOf(meta));
      }
    } catch (e) {
      if (!alive(run) || errCode(e) === "cancelled") { exText(ex, "Parado."); endRun(run); return; }
      var pc = errCode(e);
      exText(ex, mcpCopy(e, PUBMED));
      setStatus(pc === "tool_error" ? "O PubMed recusou a busca." : "PubMed indisponível agora.", true, 8000);
      // falhas passageiras: um botão para tentar de novo (nunca sozinho)
      if (!NEEDS_USER[pc]) {
        exRetry(ex, function () { research(query, original); });
      }
      endRun(run);
      return;
    }
    if (!alive(run)) return;
    if (!arts.length) {
      var none = C.lgOf(S.settings.lang) === "pt" ? "Nada encontrado no PubMed para essa busca, senhor." : "Nothing on PubMed for that search, sir.";
      exText(ex, none);
      exMeta(ex, "<span>Consulta: " + esc(q) + "</span>");
      Voice.speakText(none);
      logEvent({ kind: "research", q: query, a: none });
      endRun(run);
      return;
    }
    if (!sample || S.brain !== "on") {
      exText(ex, (C.lgOf(S.settings.lang) === "pt" ? "Encontrei " + arts.length + " artigos no PubMed. Sem o cérebro, deixo a lista para o senhor." : "Found " + arts.length + " PubMed articles."));
      exArticles(ex, arts);
      endRun(run);
      return;
    }
    exPending(ex, "Lendo os resumos…");
    var st = streamer(ex, run), tier = S.settings.tier;
    try {
      var res = await sample(C.researchInstructions({ lang: S.settings.lang, humor: S.settings.humor, articles: arts, question: query }),
        { onText: function (u) { st.update(u.text); }, signal: run.ctl.signal, modelTier: tier, cache: false });
      if (!alive(run)) return;
      var out = C.stripSources(res.text);
      exText(ex, out.text);
      st.feed(out.text, true);
      var used = out.ids.map(function (id) { var k = +String(id).slice(1); return /^a/i.test(id) ? arts[k - 1] : null; }).filter(Boolean);
      used = used.filter(function (a, i) { return used.indexOf(a) === i; });
      exArticles(ex, used.length ? used : arts); // atribuição + DOI de cada artigo usado (licença do PubMed)
      exMeta(ex, "<span>Consulta: " + esc(q) + "</span>");
      var tn = noteTier(res, tier);
      if (tn) exMeta(ex, tn);
      pushHistory("[PubMed] " + query, out.text);
      logEvent({ kind: "research", q: query, a: out.text, sources: (used.length ? used : arts).map(function (a) { return a.title; }) });
    } catch (e) {
      exArticles(ex, arts);
      sampleFailure(e, ex, function () { research(query, original); });
    } finally {
      endRun(run);
    }
  }

  async function briefing(fromActivation) {
    if (fromActivation && RUN) return; // o automático nunca cancela um pedido do usuário
    var ex = addExchange(fromActivation ? "Briefing do dia" : "O que tenho hoje?", fromActivation ? "JARVIS" : "Você");
    var run = startRun(ex, fromActivation);
    run.auto = !!fromActivation;
    exPending(ex, "Lendo a agenda…");
    var mcp = await mcpPromise;
    if (!alive(run)) return;
    if (!mcp) {
      var msg = mcpCopy({ code: "no_mcp" }, GCAL);
      setAgendaState("off", msg);
      if (fromActivation && agendaWarned) { ex.root.remove(); endRun(run); return; }
      agendaWarned = true;
      exText(ex, "Sem agenda conectada; sigo sem briefing.");
      exMeta(ex, '<span class="warn">' + esc(msg) + "</span>");
      if (fromActivation) Voice.speakText(C.lgOf(S.settings.lang) === "pt" ? "Sem agenda conectada, senhor. Sigo sem briefing." : "No calendar connected, sir. Carrying on without a briefing.");
      endRun(run);
      return;
    }
    var events;
    try {
      events = await todayEvents(!fromActivation, run.ctl.signal);
    } catch (e) {
      if (!alive(run)) return;
      var copy = mcpCopy(e, GCAL);
      if (fromActivation && agendaWarned) { ex.root.remove(); endRun(run); return; }
      agendaWarned = true;
      exText(ex, "Não li a agenda; sigo sem briefing.");
      exMeta(ex, '<span class="warn">' + esc(copy) + "</span>");
      if (fromActivation) Voice.speakText(C.lgOf(S.settings.lang) === "pt" ? "Não consegui ler a agenda, senhor. Sigo sem briefing." : "I couldn't read the calendar, sir. Carrying on without a briefing.");
      endRun(run);
      return;
    }
    if (!alive(run)) return;
    exEvents(ex, events);
    var sample = await samplePromise;
    if (!alive(run)) return;
    if (!events.length || !sample || S.brain !== "on") {
      var line = C.localBriefing(events, S.settings.lang);
      exText(ex, line);
      Voice.speakText(line);
      logEvent({ kind: "briefing", q: "briefing", a: line });
      endRun(run);
      return;
    }
    exPending(ex, "Resumindo o dia…");
    setThinking(true);
    var st = streamer(ex, run);
    try {
      var block = C.agendaBlock(events, { date: C.dayRange(new Date()).date, timeZone: TZ, descChars: 600 });
      var res = await sample(C.briefingInstructions({ lang: S.settings.lang, humor: S.settings.humor, agendaBlock: block }),
        { onText: function (u) { st.update(u.text); }, signal: run.ctl.signal, modelTier: "quick" });
      if (!alive(run)) return;
      var text = C.stripSources(res.text).text;
      exText(ex, text);
      st.feed(text, true);
      logEvent({ kind: "briefing", q: "briefing", a: text, sources: events.map(function (e) { return e.summary; }) });
    } catch (e) {
      if (BRAIN_OFF_CODES[errCode(e)] || errCode(e) === "rate_limited") {
        var fb = C.localBriefing(events, S.settings.lang);
        if (BRAIN_OFF_CODES[errCode(e)]) brainOff(errCode(e));
        exText(ex, fb);
        Voice.speakText(fb);
      } else sampleFailure(e, ex, function () { briefing(false); });
    } finally {
      endRun(run);
    }
  }

  async function journal(win, question) {
    var ex = addExchange(question);
    var run = startRun(ex);
    exPending(ex, "Abrindo o diário…");
    var days;
    try { days = await readDays(win.days); } catch (e) { days = []; }
    if (!alive(run)) return;
    var lines = [], multi = win.days.length > 1;
    days.forEach(function (d) {
      d.events.forEach(function (e) {
        var stamp = multi ? d.date.slice(5) + " " + fmtTime(e.t) : fmtTime(e.t);
        var k = e.kind === "ask" ? "asked" : e.kind === "research" ? "PubMed research" : e.kind === "remember" ? "saved memory" : e.kind === "briefing" ? "briefing" : e.kind === "settings" ? "changed setting" : String(e.kind);
        lines.push("[" + stamp + "] " + k + ": " + String(e.q || "") + (e.a ? " -> " + String(e.a) : ""));
      });
    });
    var mems = Array.from(memories.values()).filter(function (m) {
      var d = m.createdAt ? C.isoDate(new Date(m.createdAt)) : "";
      return d >= win.start && d <= win.end;
    });
    var label = win.label;
    if (!lines.length && !mems.length) {
      var empty = C.emptyJournalLine(label, S.settings.lang);
      exText(ex, empty);
      Voice.speakText(empty);
      endRun(run);
      return;
    }
    mems.forEach(function (m) { lines.push("[" + (multi ? C.isoDate(new Date(m.createdAt)).slice(5) + " " : "") + fmtTime(m.createdAt) + "] memory: " + m.fact); });
    var sample = await samplePromise;
    if (!alive(run)) return;
    if (!sample || S.brain !== "on") {
      exText(ex, "Diário de " + label + ": " + lines.length + " registros. Sem o cérebro, abro a lista para o senhor.");
      exChips(ex, mems);
      openSheet("diary", win);
      endRun(run);
      return;
    }
    setThinking(true);
    var st = streamer(ex, run);
    try {
      var res = await sample(C.journalInstructions({ lang: S.settings.lang, humor: S.settings.humor, label: label, lines: lines.slice(-80).join("\n"), question: question }),
        { onText: function (u) { st.update(u.text); }, signal: run.ctl.signal, modelTier: S.settings.tier, cache: false });
      if (!alive(run)) return;
      var text = C.stripSources(res.text).text;
      exText(ex, text);
      st.feed(text, true);
      exChips(ex, mems);
      exMeta(ex, "<span>diário · " + esc(label) + "</span>");
      pushHistory(question, text);
    } catch (e) {
      sampleFailure(e, ex, function () { journal(win, question); });
    } finally {
      endRun(run);
    }
  }

  function quickLine(question, line) {
    stopRun();
    var ex = addExchange(question);
    exText(ex, line);
    Voice.speakText(line);
    return ex;
  }

  function submit(raw) {
    var text = String(raw || "").trim();
    if (!text) return;
    userActs++;
    disarmFrame();
    var intent;
    try { intent = C.parseIntent(text, { humor: S.settings.humor }); } catch (e) { intent = { kind: "ask", text: text, agenda: false }; }
    S.lastIntent = intent.kind;
    if (intent.kind === "hush") { stopRun(); setStatus("Silêncio.", false, 2000); return; }
    if (PHONE.matches) closePanel(); // no celular a folha da nota cobriria a resposta que vem aí
    if (intent.kind === "tier") {
      changeSettings(function (s) { s.tier = intent.tier; }, "modo " + C.TIER_NAMES[intent.tier]);
      quickLine(text, C.tierLine(intent.tier, intent.alias, S.settings.lang));
      return;
    }
    if (intent.kind === "humor") {
      changeSettings(function (s) { s.humor = intent.value; }, "humor " + intent.value + "%");
      quickLine(text, C.humorLine(intent.value, S.settings.lang));
      return;
    }
    if (intent.kind === "help") {
      quickLine(text, C.lgOf(S.settings.lang) === "pt" ? "Abri a lista de comandos, senhor." : "The list of commands is open, sir.");
      openSheet("help");
      return;
    }
    var p = intent.kind === "remember" ? remember(intent.fact, text)
      : intent.kind === "research" ? research(intent.query, text)
      : intent.kind === "briefing" ? briefing(false)
      : intent.kind === "journal" ? journal(intent.window, text)
      : ask(intent.text || text, intent);
    var mine = RUN; // cada pedido abre o seu run antes do primeiro await
    Promise.resolve(p).catch(function (e) {
      console.warn("JARVIS: falha inesperada", e);
      setStatus("Algo deu errado nesse pedido. Tente de novo.", true, 6000);
      if (RUN === mine) stopRun(); // um pedido mais novo dele segue intacto
    });
  }

  // ------------------------------------------------------------ ativação ----
  function updateCardStatus() {
    if (S.activated) return;
    var parts = [countLine(counts())];
    if (S.brain === "off") parts.push("cérebro indisponível aqui");
    else if (S.brain === "on") parts.push("cérebro pronto");
    cardStatus(parts.join(" · ") + ". Toque para ligar a voz e ouvir o briefing.");
  }
  async function activate() {
    if (S.activated) return;
    S.activated = true;
    var acts = userActs;
    Voice.unlock();          // dentro do gesto: destrava a fala e o AudioContext
    chime(true);
    $("card").hidden = true;
    $("dock-wrap").hidden = false;
    renderHud();
    measureView();
    armFrame(3000);
    frame.next = 0;
    if (!COARSE.matches) { try { $("q").focus({ preventScroll: true }); } catch (e) { /* nada */ } }
    setStatus("Inicializando…");
    await Promise.race([bootReady.then(function () { return firstSnap; }), sleep(2500)]);
    await Promise.race([samplePromise, sleep(1500)]);
    if ($("status").textContent === "Inicializando…") setStatus("");
    // enquanto a página se preparava, ele já pediu algo (pergunta, memória, "para") ou há um pedido em curso:
    // a saudação entra calada no topo da lista e o briefing automático não começa — nada aqui cancela, atropela
    // ou fala por cima do pedido dele. O briefing continua a um "o que tenho hoje?" de distância.
    var userFirst = userActs !== acts || !!RUN;
    var c = counts();
    var greet = C.greetingLine(S.settings.lang, c.notes, c.memories);
    var ex = addExchange("", null, userFirst);
    exText(ex, greet);
    if (!userFirst) Voice.speakText(greet);
    if (S.brain === "off" && S.brainNote) exMeta(ex, '<span class="warn">' + esc(S.brainNote) + "</span>");
    if (Store.mode === "local") exMeta(ex, '<span class="warn">Sem conta conectada: memórias só neste aparelho.</span>');
    if (userFirst) {
      exMeta(ex, "<span>" + esc(C.lgOf(S.settings.lang) === "pt" ? "Briefing do dia: é só dizer “o que tenho hoje?”." : "For today's briefing, just say “what's on my agenda?”.") + "</span>");
      return;
    }
    try { await briefing(true); } catch (e) { console.warn("JARVIS: briefing", e); }
  }
  $("activate").addEventListener("click", function () { activate().catch(function (e) { console.warn("JARVIS: ativação", e); }); });
  $("chip-agenda").addEventListener("click", function () {
    if (!S.activated) { activate().catch(function () {}); return; }
    userActs++;
    briefing(false).catch(function () {});
  });
  $("reactor").addEventListener("click", function () {
    userActs++;
    Voice.stop();
    if (S.activated && !S.thinking && !S.streaming) setStatus("Silêncio.", false, 1500);
  });

  // ------------------------------------------------------------ dock ----
  var form = $("dock"), box = $("q");
  function autosize() {
    box.style.height = "auto";
    box.style.height = Math.min(140, Math.max(48, box.scrollHeight)) + "px";
  }
  function handleSend() {
    var text = box.value;
    if (!text.trim()) {
      if (S.thinking || S.streaming || S.speaking) { userActs++; stopRun(); setStatus("Parado.", false, 1500); }
      return;
    }
    box.value = "";
    autosize();
    renderSend();
    if (COARSE.matches) { try { box.blur(); } catch (e) { /* nada */ } }
    hideTip();
    submit(text);
  }
  form.addEventListener("submit", function (e) { e.preventDefault(); handleSend(); });
  box.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); handleSend(); }
  });
  box.addEventListener("input", function () { autosize(); renderSend(); });

  var tipTimer = 0;
  function hideTip() { clearTimeout(tipTimer); $("dictation-tip").hidden = true; }
  $("mic").addEventListener("click", function () {
    var tip = $("dictation-tip");
    tip.textContent = COARSE.matches ? "No iPad ou iPhone: toque no 🎤 do teclado e fale. Depois toque em Enviar."
      : IS_MAC ? "No Mac: aperte a tecla de ditado (🎤) ou Fn duas vezes e fale. Enter envia."
      : "No computador: use o ditado do sistema (no Windows, tecla Windows + H) e fale. Enter envia.";
    tip.hidden = false;
    if (PHONE.matches) closePanel(); // a dica sobe do dock; a folha da nota a esconderia
    try { box.focus(); } catch (e) { /* nada */ }
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 7000);
  });

  // menu ⋯
  function setMenu(open) {
    if (open && PHONE.matches) closePanel(); // no celular o menu abriria por baixo da folha da nota
    $("menu").hidden = !open;
    $("menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { var first = $("menu").querySelector("button"); if (first) try { first.focus({ preventScroll: true }); } catch (e) { /* nada */ } }
  }
  $("menu-btn").addEventListener("click", function (e) { e.stopPropagation(); setMenu($("menu").hidden); });
  document.addEventListener("click", function (e) {
    if (!$("menu").hidden && !e.target.closest("#menu") && !e.target.closest("#menu-btn")) setMenu(false);
  });
  $("menu-import").addEventListener("click", function () { setMenu(false); openSheet("import"); });
  $("menu-settings").addEventListener("click", function () { setMenu(false); openSheet("settings"); });
  $("menu-diary").addEventListener("click", function () { setMenu(false); openSheet("diary"); });
  $("menu-help").addEventListener("click", function () { setMenu(false); openSheet("help"); });

  // ------------------------------------------------------------ folhas ----
  var SHEETS = { settings: "Ajustes", import: "Adicionar notas", diary: "Diário de hoje", help: "Ajuda" };
  var sheetReturn = null;
  function openSheet(name, arg) {
    sheetReturn = document.activeElement;
    Object.keys(SHEETS).forEach(function (k) { $("page-" + k).hidden = k !== name; });
    $("sheet-title").textContent = name === "diary" && arg && arg.label && arg.label !== "hoje" ? "Diário · " + arg.label : SHEETS[name];
    $("sheet").hidden = false;
    $("scrim").hidden = false;
    $("sheet-scroll").scrollTop = 0;
    if (name === "settings") { applySettings(false); renderStorage(); }
    if (name === "help") renderHelp();
    if (name === "diary") renderDiary(arg);
    if (name === "import") renderImportCount();
    try { $("sheet-close").focus({ preventScroll: true }); } catch (e) { /* nada */ }
  }
  function closeSheet() {
    $("sheet").hidden = true;
    $("scrim").hidden = true;
    if (sheetReturn && sheetReturn.focus) { try { sheetReturn.focus({ preventScroll: true }); } catch (e) { /* nada */ } }
  }
  $("sheet-close").addEventListener("click", closeSheet);
  $("scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!$("sheet").hidden) closeSheet();
      else if (!$("menu").hidden) setMenu(false);
      else overview();
    }
    if (e.key === "/" && document.activeElement !== box && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "") && S.activated) {
      e.preventDefault(); box.focus();
    }
  });
  function renderHelp() {
    $("help-list").innerHTML = C.HELP.map(function (h) { return "<li><b>" + esc(h[0]) + "</b><span>" + esc(h[1]) + "</span></li>"; }).join("");
  }
  async function renderDiary(win) {
    var body = $("diary-body");
    body.innerHTML = '<p class="empty">Carregando o diário…</p>';
    var dates = win && win.days ? win.days : [C.isoDate(new Date())];
    var days;
    try { days = await readDays(dates); } catch (e) { days = []; }
    var items = [];
    days.forEach(function (d) { d.events.forEach(function (e) { items.push({ d: d.date, e: e }); }); });
    items.sort(function (a, b) { return cmp(String(b.e.t), String(a.e.t)); });
    if (!items.length) {
      body.innerHTML = '<p class="empty">' + (Store.mode === "pending" ? "Ainda verificando o armazenamento…" : "Nada registrado ainda. Perguntas, pesquisas, memórias e ajustes aparecem aqui.") + "</p>";
      return;
    }
    body.innerHTML = '<ul class="diary">' + items.slice(0, 200).map(function (it) {
      var e = it.e;
      return '<li><div class="d-head"><span>' + esc((dates.length > 1 ? it.d.slice(8) + "/" + it.d.slice(5, 7) + " " : "") + fmtTime(e.t)) + '</span><span class="kind">' +
        esc(KIND_PT[e.kind] || e.kind) + "</span></div>" + (e.q ? '<div class="d-q">' + esc(e.q) + "</div>" : "") +
        (e.a ? '<div class="d-a">' + esc(e.a) + "</div>" : "") + "</li>";
    }).join("") + "</ul>";
  }

  // ------------------------------------------------------------ apagar ----
  function deleteMemory(id) {
    var m = memories.get(id);
    if (!m) return;
    Store.deleting.add(id);
    memories.delete(id);
    rebuildGalaxy();
    overview(); // a estrela que ele olhava sumiu: volta para a galáxia inteira
    setStatus("Memória apagada.", false, 3000);
    if (Store.mode === "account") {
      if (Store.readOnly) { Store.deleting.delete(id); return; }
      var ref = Store.memCol.doc(id);
      dbWrite(ref.path || ("memories/" + id), function () { return ref.delete(); }, "a remoção")
        .catch(function () {}).then(function () { Store.deleting.delete(id); });
    } else { saveLocalMemories(); Store.deleting.delete(id); }
    logEvent({ kind: "settings", q: "apagou a memória " + m.title, a: "" });
  }
  function deleteImported(id) {
    var n = imported.get(id);
    if (!n) return;
    Store.deleting.add(id);
    imported.delete(id);
    rebuildGalaxy();
    renderImportCount();
    overview();
    setStatus("Nota apagada.", false, 3000);
    if (Store.mode === "account") {
      if (Store.readOnly) { Store.deleting.delete(id); return; }
      var ref = Store.notesCol.doc(id);
      dbWrite(ref.path || ("notes/" + id), function () { return ref.delete(); }, "a remoção")
        .catch(function () {}).then(function () { Store.deleting.delete(id); });
    } else { saveLocalNotes(); Store.deleting.delete(id); }
  }

  // ------------------------------------------------------------ importar notas ----
  var MAX_NOTES = 500, MAX_CHARS = 60000;
  var SKIP_DIRS = { ".obsidian": 1, ".trash": 1, ".git": 1, "node_modules": 1, "__pycache__": 1, ".venv": 1 };
  function renderImportCount() {
    var n = imported.size;
    $("import-count").textContent = n === 0 ? "Nenhuma nota importada" : n === 1 ? "1 nota importada" : n + " notas importadas";
    $("import-clear").hidden = n === 0;
  }
  function okFile(f) { return /\.(md|markdown|txt)$/i.test(f.name || "") || /^text\/(markdown|plain|x-markdown)/i.test(f.type || ""); }
  function fileText(f) {
    if (typeof f.text === "function") return f.text();
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result || "")); }; r.onerror = function () { rej(r.error); }; r.readAsText(f); });
  }
  async function importFiles(list) {
    var progress = $("import-progress");
    list = list.filter(function (x) { return x && x.file && okFile(x.file) && !/^\./.test(x.file.name || ""); });
    if (!list.length) { progress.textContent = "Nenhum arquivo .md, .markdown ou .txt na seleção."; return; }
    var byPath = new Map();
    imported.forEach(function (n) { byPath.set(n.path.toLowerCase(), n); });
    var room = MAX_NOTES - imported.size, added = 0, updated = 0, cut = 0, skipped = 0, failed = 0, jobs = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i], text;
      try { text = await fileText(x.file); } catch (e) { failed++; continue; }
      var note = C.importNote(x.file.name, x.rel || x.file.webkitRelativePath || "", text, MAX_CHARS);
      if (note.truncated) cut++;
      var existing = byPath.get(note.path.toLowerCase());
      if (existing) {
        if (existing.text === note.text) continue;
        updated++;
        jobs.push({ id: existing.docId, note: note });
      } else {
        if (room <= 0) { skipped++; continue; }
        room--; added++;
        var id = newId("n");
        jobs.push({ id: id, note: note });
        byPath.set(note.path.toLowerCase(), { docId: id, text: note.text });
      }
      if (i % 10 === 0) progress.textContent = "Lendo " + (i + 1) + " de " + list.length + "…";
    }
    var stamp = new Date().toISOString();
    jobs.forEach(function (j) {
      var doc = fitDoc({ label: j.note.label, group: j.note.group, text: j.note.text, importedAt: stamp }, "text");
      j.doc = doc;
      Store.pendingMem.add(j.id);
      var old = imported.get(j.id);
      var fresh = makeImported(j.id, doc);
      if (old) Object.assign(old, fresh); else imported.set(j.id, fresh);
    });
    rebuildGalaxy();
    renderImportCount();
    if (Store.mode === "account" && !Store.readOnly && jobs.length) {
      var done = 0, k = 0, writeFailed = 0;
      var worker = async function () {
        while (k < jobs.length && !Store.readOnly) {
          var j = jobs[k++];
          var ref = Store.notesCol.doc(j.id);
          try { await dbWrite(ref.path || ("notes/" + j.id), function () { return ref.set(j.doc); }, "a nota importada"); }
          catch (e) { writeFailed++; }
          Store.pendingMem.delete(j.id);
          done++;
          progress.textContent = "Salvando na sua conta: " + done + " de " + jobs.length + "…";
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      jobs.forEach(function (j) { Store.pendingMem.delete(j.id); });
      failed += writeFailed;
    } else {
      jobs.forEach(function (j) { Store.pendingMem.delete(j.id); });
      if (Store.mode !== "account") saveLocalNotes();
    }
    var parts = [];
    if (added) parts.push(added + (added === 1 ? " nota nova" : " notas novas"));
    if (updated) parts.push(updated + (updated === 1 ? " atualizada" : " atualizadas"));
    if (!added && !updated) parts.push("nada novo (as notas já estavam iguais)");
    var msg = parts.join(", ") + ".";
    if (cut) msg += " " + cut + (cut === 1 ? " foi cortada" : " foram cortadas") + " em 60 000 caracteres.";
    if (skipped) msg += " " + skipped + " ficaram de fora (limite de 500 notas).";
    if (failed) msg += " " + failed + " não puderam ser lidas ou salvas.";
    if ((added || updated) && Store.readOnly) msg += " Sua conta recusou gravações: elas valem só nesta visita.";
    progress.textContent = msg;
    setStatus("Notas: " + msg, false, 8000);
    if (added || updated) logEvent({ kind: "settings", q: "importou notas: " + msg, a: "" });
    if (added && Graph) requestFit(1400, 300);
  }
  $("file-input").addEventListener("change", function () {
    var files = Array.from(this.files || []).map(function (f) { return { file: f, rel: f.webkitRelativePath || "" }; });
    this.value = "";
    importFiles(files).catch(function (e) { console.warn("JARVIS: importação", e); $("import-progress").textContent = "A importação falhou. Tente de novo."; });
  });
  twoTap($("import-clear"), "Tocar de novo para remover todas", function () {
    var ids = Array.from(imported.keys());
    $("import-clear").disabled = false;
    $("import-clear").classList.remove("armed");
    $("import-clear").textContent = "Remover todas";
    ids.forEach(function (id) { Store.deleting.add(id); });
    imported = new Map();
    rebuildGalaxy();
    renderImportCount();
    $("import-progress").textContent = ids.length + " notas removidas.";
    if (Store.mode === "account" && !Store.readOnly) {
      ids.forEach(function (id) {
        var ref = Store.notesCol.doc(id);
        dbWrite(ref.path || ("notes/" + id), function () { return ref.delete(); }, "a remoção").catch(function () {}).then(function () { Store.deleting.delete(id); });
      });
    } else { saveLocalNotes(); ids.forEach(function (id) { Store.deleting.delete(id); }); }
  });

  // arrastar e soltar (arquivos ou pastas, no Mac)
  var dragDepth = 0;
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, "Files") >= 0; }
  window.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; });
  window.addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = "copy"; } catch (x) { /* nada */ } });
  window.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-overlay").hidden = true; });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("drop-overlay").hidden = true;
    var dt = e.dataTransfer;
    var items = dt.items ? Array.from(dt.items) : [];
    var entries = items.map(function (it) { try { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; } catch (x) { return null; } }).filter(Boolean);
    var plain = Array.from(dt.files || []).map(function (f) { return { file: f, rel: "" }; });
    openSheet("import");
    $("import-progress").textContent = "Lendo os arquivos…";
    collectEntries(entries).then(function (found) {
      return importFiles(found.length || !plain.length ? found : plain);
    }).catch(function (x) { console.warn("JARVIS: soltar", x); return importFiles(plain); });
  });
  async function collectEntries(entries) {
    var out = [];
    async function walk(entry, depth) {
      if (out.length >= 2000 || depth > 12 || !entry) return;
      if (entry.isFile) {
        if (/\.(md|markdown|txt)$/i.test(entry.name) && entry.name[0] !== ".") {
          try {
            var f = await new Promise(function (res, rej) { entry.file(res, rej); });
            out.push({ file: f, rel: String(entry.fullPath || entry.name).replace(/^\//, "") });
          } catch (e) { /* arquivo ilegível */ }
        }
      } else if (entry.isDirectory) {
        if (entry.name[0] === "." || SKIP_DIRS[entry.name]) return;
        var reader = entry.createReader(), batch;
        do {
          batch = await new Promise(function (res) { reader.readEntries(res, function () { res([]); }); });
          for (var i = 0; i < batch.length; i++) await walk(batch[i], depth + 1);
        } while (batch.length);
      }
    }
    for (var i = 0; i < entries.length; i++) await walk(entries[i], 0);
    return out;
  }

  // ------------------------------------------------------------ teclado do iPad ----
  function onViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    var root = document.documentElement.style;
    root.setProperty("--kb", (kb > 60 ? Math.round(kb) : 0) + "px");
    root.setProperty("--vvh", Math.round(vv.height) + "px");
    measureView(); // o teclado empurra o dock: a folha da nota e o centro da galáxia acompanham
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewport);
    window.visualViewport.addEventListener("scroll", onViewport);
    onViewport();
  }

  // erros das capabilities que escapem de algum caminho não derrubam nada
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    if (r && typeof r === "object" && typeof r.code === "string" && !(r instanceof Error)) {
      console.warn("JARVIS: rejeição tratada", r.code, r.message || "");
      e.preventDefault();
    }
  });

  // ------------------------------------------------------------ boot ----
  rebuildGalaxy();
  applySettings(false);
  renderHud();
  setAgendaState("idle");
  updateCardStatus();
  renderStorage();

  // ganchos de teste, só leitura
  try {
    Object.defineProperty(window, "__jarvis", {
      configurable: false, enumerable: false,
      value: Object.freeze({
        get state() {
          var c = counts();
          return Object.freeze({
            activated: S.activated, thinking: S.thinking, streaming: S.streaming, speaking: S.speaking,
            busy: !!RUN, brain: S.brain, storage: S.storage, agenda: S.agenda, galaxy: S.galaxy, bloom: S.bloom,
            tier: S.settings.tier, humor: S.settings.humor, lang: S.settings.lang, voice: Object.freeze(Object.assign({}, S.settings.voice)),
            hideSamples: S.settings.hideSamples, notes: c.notes, memories: c.memories, nodes: LIST.length, links: LINKS.length,
            history: S.history.length, lastIntent: S.lastIntent, lastAnswer: S.lastAnswer, lastSources: S.lastSources.slice(),
            readOnly: Store.readOnly, focus: HL.focus, panelOpen: !$("panel").hidden, queue: Voice.queue.length
          });
        },
        get graph() { return Graph; }
      })
    });
  } catch (e) { /* já definido */ }
})();
