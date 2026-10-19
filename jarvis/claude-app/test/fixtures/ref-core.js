// Reference port of the JARVIS core used ONLY to validate the test suite itself (adapters and
// expectations of core.test.cjs). It is not the app. Ported from ref/build.py, ref/server.py and the
// regexes of ref/old-viewer.html, with the additions SPEC.md asks for (PubMed/evidence research, tiers,
// briefing, help, streaming-safe source markers).
(function () {
  "use strict";
  const STOPWORDS = new Set(("a about agora ainda ali all also an and anotacao anotacoes antes any ao aos apenas aquela aquelas aquele aqueles aqui aquilo are as assim at ate be been being bem by cada can com como conte could da das de dela delas dele deles depois deve did diga do does done dos down e each ela elas ele eles em entao entre era essa essas esse esses esta estao estar estas estava este estes eu explique fale faz fazer fica foi for foram from ha had has have havia he her here him houve how i if in into is isso isto it its ja jarvis just la lembra lembrar lembre less lhe mais mas me menos mesma mesmo meu meus minha minhas more most muita muito my na nao nas nem no nos not nota notas note notes num numa nunca o of on onde only or os other ou our out outra outro over own para pela pelas pelo pelos please pode pois por porque posso pouco pra quais qual qualquer quando quanta quanto que quem same sao se sem sempre sendo senhor ser sera seria seu seus she should sido sim sir so sobre some sua suas such tambem te tell tem temos tenho ter than that the their them then there these they this those tinha to toda todas todo todos too tu um uma umas under uns up vai veja vejo ver very voce vos vou was we were what when where which who whom why will with without would yes you your").split(" "));
  const GENERIC_TITLES = new Set(["inbox", "index", "notas", "notes", "readme", "sem titulo", "todo", "untitled"]);
  const ATTACHMENT_EXT = new Set("avi bmp canvas csv doc docx excalidraw gif heic jpeg jpg m4a mkv mov mp3 mp4 ogg pdf png ppt pptx svg tif tiff wav webm webp xls xlsx zip".split(" "));
  const CLIQUE_MAX = 10, EXCERPT_CHARS = 700;
  const TOKEN_G = /[\p{L}\p{N}]+/gu;
  const WIKILINK_RE = /\[\[([^\[\]|#^]+)(?:[#^][^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g;

  const fold = s => String(s).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  const tokens = s => fold(s).match(TOKEN_G) || [];
  const titleKey = l => tokens(l).join(" ");
  function mentionable(label) {
    const tt = tokens(label), key = tt.join(" ");
    return tt.length > 0 && key.length >= 3 && !GENERIC_TITLES.has(key) && !(tt.length === 1 && STOPWORDS.has(tt[0]));
  }
  function wikilinkTargets(text) {
    const out = [];
    for (const m of String(text).matchAll(WIKILINK_RE)) {
      let target = m[1].trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const name = target.split("/").pop();
      if (name.toLowerCase().endsWith(".md")) target = target.slice(0, -3);
      else if (name.includes(".") && ATTACHMENT_EXT.has(name.split(".").pop().toLowerCase())) continue;
      if (target) out.push(target);
    }
    return out;
  }
  function makeExcerpt(body, title) {
    let text = String(body).trim();
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[0].startsWith("# ") && fold(lines[0].slice(2).trim()) === fold(title)) text = lines.slice(1).join("\n").trim();
    text = text.replace(/\n{3,}/g, "\n\n");
    if (text.length <= EXCERPT_CHARS) return text;
    let cut = text.lastIndexOf(" ", EXCERPT_CHARS - 1);
    if (cut < EXCERPT_CHARS * 0.6) cut = EXCERPT_CHARS;
    return text.slice(0, cut).trimEnd() + "…";
  }
  const isUpper = s => s === s.toUpperCase() && s !== s.toLowerCase();
  function buildLinks(notes) {
    const pairs = new Map();
    const add = (a, b) => { if (a !== b) { const x = Math.min(a, b), y = Math.max(a, b); pairs.set(x + ":" + y, [x, y]); } };
    const byKey = new Map(), byTuple = new Map(), sizes = new Map(), acronyms = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    notes.forEach((n, i) => {
      const key = titleKey(n.label);
      if (key) push(byKey, key, i);
      if (mentionable(n.label)) {
        const tt = tokens(n.label);
        push(byTuple, tt.join("\u0001"), i);
        if (!sizes.has(tt[0])) sizes.set(tt[0], new Set());
        sizes.get(tt[0]).add(tt.length);
      }
    });
    notes.forEach((n, i) => {
      const label = String(n.label).trim();
      if (!mentionable(label) && label.length >= 2 && isUpper(label) && /^[\p{L}\p{N}]+$/u.test(label)) push(acronyms, label, i);
    });
    notes.forEach((n, i) => {
      const tk = tokens(n.text);
      tk.forEach((t, pos) => {
        const ss = sizes.get(t);
        if (!ss) return;
        for (const size of ss) (byTuple.get(tk.slice(pos, pos + size).join("\u0001")) || []).forEach(j => add(i, j));
      });
      if (acronyms.size) for (const t of new Set(String(n.text).match(TOKEN_G) || [])) (acronyms.get(t) || []).forEach(j => add(i, j));
    });
    const paths = notes.map(n => fold(String(n.path).replace(/\.md$/i, "")));
    const folders = notes.map(n => { const p = String(n.path); const k = p.lastIndexOf("/"); return k < 0 ? "" : p.slice(0, k); });
    function resolve(i, target) {
      let cands = byKey.get(titleKey(target.split("/").pop())) || [];
      if (target.includes("/")) {
        const want = fold(target);
        const f = cands.filter(j => paths[j] === want || paths[j].endsWith("/" + want));
        if (f.length) cands = f;
      }
      if (cands.length > 1) {
        const same = cands.filter(j => folders[j] === folders[i]);
        cands = same.length ? same : cands.slice().sort((a, b) => notes[a].path.length - notes[b].path.length || (notes[a].path < notes[b].path ? -1 : notes[a].path > notes[b].path ? 1 : 0));
      }
      return cands.length ? cands[0] : null;
    }
    const sharers = new Map();
    notes.forEach((n, i) => {
      for (const target of (n.wikilinks || wikilinkTargets(n.text))) {
        const j = resolve(i, target);
        if (j !== null) add(i, j);
        else { const key = titleKey(target.split("/").pop()); if (key) { if (!sharers.has(key)) sharers.set(key, new Set()); sharers.get(key).add(i); } }
      }
    });
    for (const members of sharers.values()) {
      const m = [...members].sort((a, b) => a - b);
      if (m.length <= CLIQUE_MAX) { for (let x = 0; x < m.length; x++) for (let y = x + 1; y < m.length; y++) add(m[x], m[y]); }
      else m.slice(1).forEach(y => add(m[0], y));
    }
    return [...pairs.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]).map(([source, target]) => ({ source, target }));
  }

  const stem = t => (t.length > 6 ? t.slice(0, 6) : t);
  const queryTerms = text => tokens(text).filter(t => t.length >= 2 && !STOPWORDS.has(t)).map(stem);
  function indexNotes(notes) {
    const postings = new Map(), titles = [];
    notes.forEach((n, i) => {
      const counts = new Map();
      for (const t of tokens(n.label + "\n" + n.text)) if (t.length >= 2 && !STOPWORDS.has(t)) { const s = stem(t); counts.set(s, (counts.get(s) || 0) + 1); }
      for (const [s, c] of counts) { if (!postings.has(s)) postings.set(s, new Map()); postings.get(s).set(i, c); }
      titles.push(new Set(tokens(n.label).map(stem)));
    });
    return { postings, titles, n: notes.length };
  }
  function score(ix, text) {
    const sc = new Map(), total = Math.max(ix.n, 1);
    for (const q of new Set(queryTerms(text))) {
      const docs = ix.postings.get(q);
      if (!docs) continue;
      const idf = Math.log(1 + total / docs.size);
      for (const [i, tf] of docs) {
        let s = idf * (1 + Math.log(tf));
        if (ix.titles[i].has(q)) s += 2.5 * idf;
        sc.set(i, (sc.get(i) || 0) + s);
      }
    }
    return sc;
  }
  function retrieve(ix, text, k = 6) {
    const sc = score(ix, text);
    return [...sc.keys()].sort((a, b) => sc.get(b) - sc.get(a) || a - b).slice(0, k);
  }
  function mostRelated(ix, text) {
    const common = Math.max(1, Math.floor(ix.n / 2));
    const terms = new Set(queryTerms(text).filter(q => (ix.postings.get(q) || new Map()).size <= common));
    const sc = score(ix, text);
    const ok = [...sc.keys()].filter(i => [...terms].filter(q => (ix.postings.get(q) || new Map()).has(i)).length >= 2 || [...terms].some(q => ix.titles[i].has(q)));
    if (!ok.length) return null;
    return ok.sort((a, b) => sc.get(b) - sc.get(a) || a - b)[0];
  }
  function makeTitle(fact) {
    const first = String(fact).split(/[.?!;:](?:\s|$)|\n/)[0];
    const words = (first.match(/[\p{L}\p{N}_'’-]+(?:[.,]\d+)*/gu) || []).slice(0, 6);
    while (words.length > 2 && STOPWORDS.has(fold(words[words.length - 1]))) words.pop();
    let title = words.join(" ").slice(0, 60).replace(/^[ \-'’]+|[ \-'’]+$/g, "");
    if (!title) { const d = new Date(); return `Captura ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
    if (words.length && words[0] === words[0].toLowerCase() && words[0] !== words[0].toUpperCase()) title = title[0].toUpperCase() + title.slice(1);
    return title;
  }

  // ------------------------------------------------------------- intents ----
  const WAKE_PREFIX_RE = /^\s*(?:(?:ei|oi|hey|ok|ô|o)\s+)?(?:jarvis|jarves|jarbis|jarviz|jarvez|djarvis|jarvi)\b[\s,:;.!?-]*/i;
  const HUSH_RE = /^\s*(?:para|pare|chega|silêncio|silencio|cala(?:\s+a\s+boca)?|quieto|calado|stop|hush|quiet|shut up|enough)\s*[.!]?\s*$/i;
  const REMEMBER_RE = /^\s*(?:jarvis[\s,:;.!-]*)?(?:remember\s+that|lembr(?:e|a|ar)(?:[-\s]se)?(?:\s+de)?\s+que|anot(?:e|a|ar)(?:\s+a[ií])?(?:\s+que)?|guard(?:e|a)(?:\s+a[ií])?\s+(?:que|isso)|memoriz(?:e|a)(?:\s+que)?)(?=[\s:,.!-]|$)[\s:,.!-]*/i;
  const RESEARCH_RE = /^\s*(?:(?:pesquis[ae]r?|research|google|look\s+up)|(?:procur[ae]r?|busc[ae]r?|search)(?=\s+(?:artigos?|estudos?|papers?|evid[eê]ncias?|na\s+literatura|no\s+pubmed|na\s+internet|na\s+web|no\s+google)))\b(?!\s+(?:nas?|em|in)\s+(?:minhas?\s+)?(?:notas?|anota|gal[aá]xia|my\s+notes))[\s:,.-]*(?:(?:(?:na|no|em|on|in|the)\s+)?(?:internet|web|google|rede|net|online|pubmed|literatura|literature)\s*[,:]?\s*)?(?:(?:artigos?|estudos?|papers?)\s+)?(?:(?:sobre|por|about|for|de)\s+)?(.{3,})$/i;
  const EVIDENCE_RE = /^\s*(?:qual\s+(?:[ée]\s+)?a\s+|quais\s+(?:s[aã]o\s+)?as\s+)?evid[eê]ncias?\s+(?:sobre|de|para|em|do|da)\s+(.{3,}?)\s*[?.!]*\s*$/i;
  const MODEL_RE = /^\s*(?:(?:troc[ae]r?|mud[ae]r?|us[ae]r?|coloc[ae]r?|põe|poe|bot[ae]r?|experiment[ae]r?|try\s+on|switch\s+to|swap\s+to|change\s+to|use)\s+(?:pra|para|pro|to|o|a|the)?\s*(?:o\s+|the\s+)?(?:modelo\s+|model\s+)?)?(haiku|sonnet|opus|fable)\s*[.!]?\s*$/i;
  const MODE_RE = /^\s*(?:modo|mode)\s+(r[aá]pido|normal|m[aá]ximo|quick|fast|default|max(?:imum)?)\s*[.!]?\s*$/i;
  const STRONGEST_RE = /^\s*(?:us[ae]r?|coloc[ae]|p[oõ]e|bot[ae])\s+o\s+mais\s+forte\s*[.!]?\s*$/i;
  const HUMOR_CMD_RE = /^\s*(?:(?:põe|poe|coloca|coloque|bota|deixa|ajusta|ajuste|set|turn)\s+(?:o\s+|the\s+)?)?(?:(mais|menos|more|less)\s+)?(?:humor|wit|sarcasmo|sarcasm)\b\s*(?:(?:em|para|pra|at|to|=|de)\s*)?(\d{1,3})?\s*(?:%|por\s+cento|percent)?\s*(mais|menos|up|down|pra\s+cima|pra\s+baixo)?\s*[.!]?\s*$/i;
  const BRIEFING_RE = /^\s*(?:o\s+que\s+(?:eu\s+)?tenho\s+(?:para\s+|pra\s+)?hoje|(?:qual\s+(?:[ée]\s+)?)?(?:a\s+)?minha\s+agenda(?:\s+de\s+hoje)?|o\s+que\s+tem\s+na\s+(?:minha\s+)?agenda(?:\s+(?:de\s+)?hoje)?|agenda(?:\s+de\s+hoje)?|briefing(?:\s+do\s+dia)?|what'?s\s+on\s+today|my\s+agenda)\s*[?.!]*\s*$/i;
  const HELP_RE = /^\s*(?:ajuda|help|socorro|comandos|lista\s+de\s+comandos|o\s+que\s+voc[eê]\s+sabe\s+fazer)\s*[?.!]*\s*$/i;
  const WEEKDAYS = { segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, domingo: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
  const JOURNAL_INTENT = /\b(fiz|fizemos|falei|falamos|perguntei|anotei|lembrei|pesquisei|conversamos|disse|rolou|aconteceu|resumo|resume|resumir|maquina do tempo|did i|was i|i asked|i noted|we talked|happened|recap|time machine)\b/;

  function toDate(today) {
    if (today == null) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    if (typeof today === "string") { const [y, m, d] = today.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
    return new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }
  const plus = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
  function journalWindow(question, today) {
    const t = toDate(today), q = fold(question);
    if (!JOURNAL_INTENT.test(q)) return null;
    const mondayBack = (t.getDay() + 6) % 7;
    if (/\b(hoje|today)\b/.test(q)) return { start: t, end: t, label: "hoje" };
    if (/\banteontem\b/.test(q)) { const d = plus(t, -2); return { start: d, end: d, label: "anteontem" }; }
    if (/\b(ontem|yesterday)\b/.test(q)) { const d = plus(t, -1); return { start: d, end: d, label: "ontem" }; }
    if (/\b(semana passada|last week)\b/.test(q)) { const s = plus(t, -(mondayBack + 7)); return { start: s, end: plus(s, 6), label: "semana passada" }; }
    if (/\b(esta semana|essa semana|this week|semana)\b/.test(q)) return { start: plus(t, -mondayBack), end: t, label: "esta semana" };
    let m = q.match(/\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (m) {
      let back = (t.getDay() - WEEKDAYS[m[1]] + 7) % 7;
      if (back === 0 && /\b(passad[ao]|ultim[ao]|last)\b/.test(q)) back = 7;
      const d = plus(t, -back);
      return { start: d, end: d, label: m[1] };
    }
    m = q.match(/\bdia (\d{1,2})\b/);
    if (m) {
      const day = +m[1];
      let y = t.getFullYear(), mo = t.getMonth();
      if (day > t.getDate()) { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } }
      const d = new Date(y, mo, day);
      if (d.getMonth() !== mo || day < 1) return null;
      return { start: d, end: d, label: "dia " + day };
    }
    return null;
  }
  function humorOf(text) {
    const m = HUMOR_CMD_RE.exec(text);
    if (!m) return null;
    if (m[2]) return { value: Math.max(0, Math.min(100, +m[2])) };
    const dir = (m[1] || m[3] || "").toLowerCase();
    if (!dir) return null;
    return { delta: /^(mais|more|up|pra\s+cima)$/.test(dir) ? 20 : -20 };
  }
  function tierOf(text) {
    let m = MODE_RE.exec(text);
    if (m) { const w = fold(m[1]); return /^(rapido|quick|fast)$/.test(w) ? "quick" : /^(normal|default)$/.test(w) ? "default" : "complex"; }
    if (STRONGEST_RE.test(text)) return "complex";
    m = MODEL_RE.exec(text);
    if (m) { const w = m[1].toLowerCase(); return w === "haiku" ? "quick" : w === "sonnet" ? "default" : "complex"; }
    return null;
  }
  function parseIntent(raw) {
    const original = String(raw == null ? "" : raw);
    const text = original.replace(WAKE_PREFIX_RE, "").trim();
    if (!text) return { kind: "ask", text: "" };
    if (HUSH_RE.test(text)) return { kind: "hush" };
    const tier = tierOf(text);
    if (tier) return { kind: "tier", tier };
    const humor = humorOf(text);
    if (humor) return Object.assign({ kind: "humor" }, humor);
    if (REMEMBER_RE.test(text) && !/\?\s*$/.test(text)) {
      const fact = text.replace(REMEMBER_RE, "").trim().replace(/[.!]+$/, "");
      if (fact) return { kind: "remember", fact };
    }
    let m = RESEARCH_RE.exec(text) || EVIDENCE_RE.exec(text);
    if (m) return { kind: "research", query: m[1].trim().replace(/[?.!]+$/, "") };
    if (journalWindow(text)) return { kind: "journal", question: text };
    if (BRIEFING_RE.test(text)) return { kind: "briefing" };
    if (HELP_RE.test(text)) return { kind: "help" };
    return { kind: "ask", text };
  }

  function stripSources(text) {
    const s = String(text);
    const i = s.indexOf("⟦");
    if (i < 0) return { text: s.trim(), ids: [] };
    const j = s.indexOf("⟧", i);
    if (j < 0) return { text: s.slice(0, i).trim(), ids: [], partial: true };
    const m = s.slice(i + 1, j).match(/^\s*fontes?\s*:\s*([\s\S]*)$/i);
    const ids = m ? m[1].split(/[\s,;]+/).filter(x => /^[a-z]{0,3}\d+$/i.test(x)) : [];
    return { text: (s.slice(0, i) + s.slice(j + 1)).trim(), ids };
  }
  function splitLong(sentence, max = 220) {
    const out = [];
    let rest = sentence.trim();
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf("; ", max));
      if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }
  function splitSentences(text) {
    const parts = String(text).split(/(?<=[.!?…])\s+(?!\d)|\n+/).map(x => x.trim()).filter(Boolean);
    return parts.flatMap(p => splitLong(p));
  }
  function personaPrompt(opts) {
    const o = opts || {};
    const humor = o.humor == null ? 70 : o.humor;
    return `Você é J.A.R.V.I.S., mordomo britânico seco e espirituoso. Humor: ${humor} de 100. Responda em pt-BR.`;
  }

  globalThis.JarvisCore = { fold, tokens, stem, queryTerms, buildLinks, makeExcerpt, wikilinkTargets, indexNotes, retrieve, mostRelated,
    makeTitle, parseIntent, journalWindow, stripSources, splitSentences, personaPrompt, mentionable };
})();
