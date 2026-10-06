/* JARVIS · núcleo puro (sem DOM, sem rede). Porte fiel de build.py e server.py:
   texto (fold/tokens), ligações da galáxia, recuperação top-6, intenções, diário, títulos, prompts. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ constantes ----
  var EXCERPT_CHARS = 700;
  var CLIQUE_MAX = 10;
  var TOP_K = 6;
  var NOTE_CHARS = 8000;
  var HISTORY_TURNS = 6;
  var HUMOR_DEFAULT = 70;
  var SPEECH_CHUNK = 220;
  var MAX_PROMPT_BYTES = 250000; // abaixo dos 256 KiB do sample, com folga
  var GENERIC_TITLES = new Set(["readme", "index", "untitled", "sem titulo", "todo", "inbox", "notes", "notas"]);
  var ATTACHMENT_EXT = new Set(("png jpg jpeg gif svg webp bmp tif tiff heic pdf mp3 mp4 m4a wav ogg webm mov mkv avi " +
    "zip csv xls xlsx doc docx ppt pptx canvas excalidraw").split(" "));
  var STOPWORDS = new Set((
    "a o e de da do das dos em no na nos nas um uma uns umas que se por para pra com sem ao aos " +
    "e ser foi sao esta estao era como mais menos mas ou ja nao sim eu tu ele ela eles elas me te " +
    "lhe vos meu minha meus minhas seu sua seus suas isso isto aquilo esse essa este esta qual quais " +
    "quando onde quem porque pois tem ter ha sobre entre ate depois antes tambem muito muita pouco " +
    "cada todo toda todos todas outro outra ainda so bem entao la aqui ali qualquer quanto quanta faz " +
    "fazer vai vou deve pode posso tenho temos tinha fica pelo pela pelos pelas num numa diga fale " +
    "explique conte voce senhor jarvis nota notas anotacao anotacoes os estes estas esses essas aquele " +
    "aqueles aquela aquelas dele dela deles delas nem ver veja vejo sera seria foram sido sendo estar estava " +
    "havia houve apenas mesmo mesma assim agora sempre nunca lembre lembra lembrar " +
    "the an and or of to in on at for with without by from is are was were be been being it its " +
    "this that these those what which who whom how why when where do does did done have has had i " +
    "you he she we they my your our their him her them as if then than so not no yes can could " +
    "should would will just about into over under up down out more most less very also there here " +
    "all any some each other such only own same too tell me please sir note notes"
  ).split(/\s+/).filter(Boolean));

  var LANGS = {
    "pt-BR": { name: "Brazilian Portuguese", sir: "senhor", lg: "pt" },
    "en-GB": { name: "British English", sir: "sir", lg: "en" }
  };

  // frontmatter YAML no topo, inclusive vazio (---\n---)
  var FRONTMATTER_RE = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/;
  // [[Alvo]], [[pasta/Alvo]], [[Alvo#Seção]], [[Alvo|apelido]]
  var WIKILINK_SRC = "\\[\\[([^\\[\\]|#^]+)(?:[#^][^\\[\\]|]*)?(?:\\|[^\\[\\]]*)?\\]\\]";
  var TOKEN_SRC = "[\\p{L}\\p{N}]+"; // letras e dígitos de qualquer alfabeto (= [^\W_] do Python)
  var TOKEN_FULL = new RegExp("^" + TOKEN_SRC + "$", "u");
  var MARK_RE = /\p{M}/gu;
  var LOWER_RE = /[\p{Lowercase}\p{Lt}]/u;
  var UPPER_RE = /\p{Uppercase}/u;
  var UPPER_OR_TITLE_RE = /[\p{Uppercase}\p{Lt}]/u;
  var LOWERCASE_RE = /\p{Lowercase}/u;
  var SURROGATE_RE = /[\uD800-\uDFFF]/;

  // ------------------------------------------------------------- texto ----
  function fold(text) {
    return String(text == null ? "" : text).toLowerCase().normalize("NFKD").replace(MARK_RE, "");
  }
  function tokenRe() { return new RegExp(TOKEN_SRC, "gu"); }
  function rawTokens(text) { return String(text == null ? "" : text).match(tokenRe()) || []; }
  function tokens(text) { return fold(text).match(tokenRe()) || []; }
  function cpLen(s) {
    s = String(s);
    if (!SURROGATE_RE.test(s)) return s.length;
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++;
      n++;
    }
    return n;
  }
  function cpSlice(s, a, b) {
    s = String(s);
    if (!SURROGATE_RE.test(s)) return s.slice(a, b);
    return Array.from(s).slice(a, b).join("");
  }
  function pyStrip(s, chars) {
    s = String(s);
    if (chars == null) return s.trim();
    var a = 0, b = s.length;
    while (a < b && chars.indexOf(s[a]) >= 0) a++;
    while (b > a && chars.indexOf(s[b - 1]) >= 0) b--;
    return s.slice(a, b);
  }
  function isUpperPy(s) { // str.isupper() do Python
    var cased = false;
    for (var ch of String(s)) {
      if (LOWER_RE.test(ch)) return false;
      if (UPPER_RE.test(ch)) cased = true;
    }
    return cased;
  }
  function isLowerPy(s) { // str.islower() do Python
    var cased = false;
    for (var ch of String(s)) {
      if (UPPER_OR_TITLE_RE.test(ch)) return false;
      if (LOWERCASE_RE.test(ch)) cased = true;
    }
    return cased;
  }
  function splitlinesPy(text) {
    return String(text).split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  }

  function wikilinkTargets(text) {
    var out = [], re = new RegExp(WIKILINK_SRC, "g"), m;
    var s = String(text == null ? "" : text);
    while ((m = re.exec(s))) {
      var target = pyStrip(pyStrip(m[1]).replace(/\\/g, "/"), "/");
      var parts = target.split("/"), name = parts[parts.length - 1];
      var low = name.toLowerCase();
      if (low.endsWith(".md")) target = target.slice(0, -3);
      else if (name.indexOf(".") >= 0 && ATTACHMENT_EXT.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase())) continue;
      if (target) out.push(target);
    }
    return out;
  }

  function makeExcerpt(body, title) {
    var text = String(body == null ? "" : body).trim();
    var lines = splitlinesPy(text);
    if (lines.length && lines[0].startsWith("# ") && fold(lines[0].slice(2).trim()) === fold(title)) {
      text = lines.slice(1).join("\n").trim();
    }
    text = text.replace(/\n{3,}/g, "\n\n");
    var cps = Array.from(text);
    if (cps.length <= EXCERPT_CHARS) return text;
    var cut = -1;
    for (var i = EXCERPT_CHARS - 1; i >= 0; i--) { if (cps[i] === " ") { cut = i; break; } }
    if (cut < EXCERPT_CHARS * 0.6) cut = EXCERPT_CHARS;
    return cps.slice(0, cut).join("").replace(/\s+$/, "") + "…";
  }

  function stripFrontmatter(text) {
    var s = String(text == null ? "" : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s.replace(FRONTMATTER_RE, "");
  }

  function titleKey(label) { return tokens(label).join(" "); }
  function mentionable(label) {
    var tt = tokens(label), key = tt.join(" ");
    return tt.length > 0 && cpLen(key) >= 3 && !GENERIC_TITLES.has(key) && !(tt.length === 1 && STOPWORDS.has(tt[0]));
  }

  // ------------------------------------------------------ ligações (build_links) ----
  function linkInfo(n, cache) {
    var hit = cache && cache.get(n);
    if (hit && hit.text === n.text) return hit;
    var info = {
      text: n.text,
      tk: tokens(n.text),
      raw: new Set(rawTokens(n.text)),
      wikilinks: Array.isArray(n.wikilinks) ? n.wikilinks : wikilinkTargets(n.text)
    };
    if (cache) cache.set(n, info);
    return info;
  }

  function buildLinks(notes, opts) {
    notes = notes || [];
    var cache = opts && opts.cache;
    var pairs = new Set();
    function add(a, b) {
      if (a === b) return;
      var lo = Math.min(a, b), hi = Math.max(a, b);
      pairs.add(lo + "," + hi);
    }
    var byKey = new Map(), byTuple = new Map(), sizes = new Map();
    notes.forEach(function (n, i) {
      var key = titleKey(n.label);
      if (key) { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(i); }
      if (mentionable(n.label)) {
        var tt = tokens(n.label), tkey = tt.join(" ");
        if (!byTuple.has(tkey)) byTuple.set(tkey, []);
        byTuple.get(tkey).push(i);
        if (!sizes.has(tt[0])) sizes.set(tt[0], new Set());
        sizes.get(tt[0]).add(tt.length);
      }
    });
    // sigla curta (TC, RX, US) só vale escrita em maiúsculas
    var acronyms = new Map();
    notes.forEach(function (n, i) {
      var label = String(n.label).trim();
      if (!mentionable(label) && cpLen(label) >= 2 && isUpperPy(label) && TOKEN_FULL.test(label)) {
        if (!acronyms.has(label)) acronyms.set(label, []);
        acronyms.get(label).push(i);
      }
    });
    // 1. uma nota menciona o título de outra
    notes.forEach(function (n, i) {
      var info = linkInfo(n, cache), tk = info.tk;
      for (var pos = 0; pos < tk.length; pos++) {
        var sz = sizes.get(tk[pos]);
        if (!sz) continue;
        sz.forEach(function (size) {
          var hits = byTuple.get(tk.slice(pos, pos + size).join(" "));
          if (hits) hits.forEach(function (j) { add(i, j); });
        });
      }
      if (acronyms.size) {
        info.raw.forEach(function (t) {
          var hits = acronyms.get(t);
          if (hits) hits.forEach(function (j) { add(i, j); });
        });
      }
    });
    // 2. [[wikilink]] para nota existente liga direto; alvo sem nota liga quem o compartilha
    var paths = notes.map(function (n) { return fold(String(n.path || "").slice(0, -3)); });
    var folders = notes.map(function (n) {
      var p = String(n.path || ""), k = p.lastIndexOf("/");
      return k >= 0 ? p.slice(0, k) : "";
    });
    function resolve(i, target) {
      var parts = target.split("/");
      var cands = (byKey.get(titleKey(parts[parts.length - 1])) || []).slice();
      if (target.indexOf("/") >= 0) {
        var want = fold(target);
        var narrowed = cands.filter(function (j) { return paths[j] === want || paths[j].endsWith("/" + want); });
        if (narrowed.length) cands = narrowed;
      }
      if (cands.length > 1) {
        var same = cands.filter(function (j) { return folders[j] === folders[i]; });
        if (same.length) cands = same;
        else cands = cands.slice().sort(function (a, b) {
          var pa = String(notes[a].path || ""), pb = String(notes[b].path || "");
          var la = cpLen(pa), lb = cpLen(pb);
          if (la !== lb) return la - lb;
          return pa < pb ? -1 : pa > pb ? 1 : 0;
        });
      }
      return cands.length ? cands[0] : null;
    }
    var sharers = new Map();
    notes.forEach(function (n, i) {
      linkInfo(n, cache).wikilinks.forEach(function (target) {
        var j = resolve(i, target);
        if (j !== null) add(i, j);
        else {
          var parts = target.split("/");
          var key = titleKey(parts[parts.length - 1]);
          if (key) { if (!sharers.has(key)) sharers.set(key, new Set()); sharers.get(key).add(i); }
        }
      });
    });
    sharers.forEach(function (members) {
      var m = Array.from(members).sort(function (a, b) { return a - b; });
      if (m.length <= CLIQUE_MAX) {
        for (var x = 0; x < m.length; x++) for (var y = x + 1; y < m.length; y++) add(m[x], m[y]);
      } else {
        for (var k = 1; k < m.length; k++) add(m[0], m[k]);
      }
    });
    return Array.from(pairs).map(function (p) {
      var ab = p.split(",");
      return { source: +ab[0], target: +ab[1] };
    }).sort(function (a, b) { return a.source - b.source || a.target - b.target; });
  }

  // ------------------------------------------------------- recuperação (Brain) ----
  function stem(t) { // radical grosseiro: "transfusão", "transfusional" e "transfusões" caem juntos
    t = String(t);
    return cpLen(t) > 6 ? cpSlice(t, 0, 6) : t;
  }
  function queryTerms(text) {
    return tokens(text).filter(function (t) { return cpLen(t) >= 2 && !STOPWORDS.has(t); }).map(stem);
  }

  function indexNotes(notes, cache) {
    notes = notes || [];
    var postings = new Map(), titles = [];
    notes.forEach(function (n, i) {
      var src = String(n.label) + "\n" + String(n.text == null ? "" : n.text);
      var hit = cache && cache.get(n);
      if (!hit || hit.src !== src) {
        var counts = new Map();
        tokens(src).forEach(function (t) {
          if (cpLen(t) >= 2 && !STOPWORDS.has(t)) { var s = stem(t); counts.set(s, (counts.get(s) || 0) + 1); }
        });
        hit = { src: src, counts: counts, title: new Set(tokens(n.label).map(stem)) };
        if (cache) cache.set(n, hit);
      }
      hit.counts.forEach(function (c, s) {
        if (!postings.has(s)) postings.set(s, new Map());
        postings.get(s).set(i, c);
      });
      titles.push(hit.title);
    });
    return { postings: postings, titles: titles, size: notes.length };
  }

  function score(index, text, weight, scores) {
    index = asIndex(index);
    weight = weight == null ? 1 : weight;
    scores = scores || new Map();
    var total = Math.max(index.size, 1);
    new Set(queryTerms(text)).forEach(function (q) {
      var docs = index.postings.get(q);
      if (!docs || !docs.size) return;
      var idf = Math.log(1 + total / docs.size);
      docs.forEach(function (tf, i) {
        var s = idf * (1 + Math.log(tf));
        if (index.titles[i] && index.titles[i].has(q)) s += 2.5 * idf; // bater no título pesa mais
        scores.set(i, (scores.get(i) || 0) + weight * s);
      });
    });
    return scores;
  }

  function rank(scores) {
    return Array.from(scores.keys()).sort(function (a, b) { return (scores.get(b) - scores.get(a)) || (a - b); });
  }

  function asIndex(x) { return Array.isArray(x) ? indexNotes(x) : x; }
  // top-6 notas para a pergunta; a pergunta anterior herda um pouco (0,35) para seguimentos.
  // Aceita o índice de indexNotes() ou a própria lista de notas.
  function retrieve(index, question, prev, k) {
    index = asIndex(index);
    var scores = score(index, question);
    if (prev) score(index, prev, 0.35, scores);
    return rank(scores).slice(0, k == null ? TOP_K : k);
  }

  // nota mais parecida, mas só se dividir 2+ termos ou um termo do título
  function mostRelated(index, text) {
    index = asIndex(index);
    var common = Math.max(1, Math.floor(index.size / 2));
    var terms = new Set(queryTerms(text).filter(function (q) {
      var d = index.postings.get(q);
      return (d ? d.size : 0) <= common;
    }));
    var scores = score(index, text);
    var best = null;
    scores.forEach(function (sc, i) {
      var shared = 0, inTitle = false;
      terms.forEach(function (q) {
        var d = index.postings.get(q);
        if (d && d.has(i)) shared++;
        if (index.titles[i] && index.titles[i].has(q)) inTitle = true;
      });
      if (!(shared >= 2 || inTitle)) return;
      if (best === null || sc > scores.get(best) || (sc === scores.get(best) && i < best)) best = i;
    });
    return best;
  }

  // ---------------------------------------------------------------- títulos ----
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function isoDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

  function makeTitle(fact, now) {
    var first = String(fact == null ? "" : fact).split(/[.?!;:](?:\s|$)|\n/)[0];
    var words = (first.match(/[\p{L}\p{N}_'’-]+(?:[.,]\p{Nd}+)*/gu) || []).slice(0, 6);
    while (words.length > 2 && STOPWORDS.has(fold(words[words.length - 1]))) words.pop();
    var title = pyStrip(cpSlice(words.join(" "), 0, 60), " -'’");
    if (!title) {
      var d = now instanceof Date ? now : new Date();
      return "Captura " + isoDate(d) + " " + pad2(d.getHours()) + pad2(d.getMinutes());
    }
    if (words.length && isLowerPy(words[0])) title = title.charAt(0).toUpperCase() + title.slice(1);
    return title;
  }

  // ------------------------------------------------------------- intenções ----
  var WAKE_PREFIX_RE = /^\s*(?:(?:ei|oi|hey|ok|ô|o)\s+)?(?:jarvis|jarves|jarbis|jarviz|jarvez|djarvis|jarvi)\b[\s,:;.!?-]*/i;
  var HUSH_RE = /^\s*(?:para|pare|parar|chega|silêncio|silencio|cala(?:\s+a\s+boca)?|quieto|calado|stop|hush|quiet|shut up|enough)\s*[.!]?\s*$/i;
  // "lembre que…", "lembre-se de que…", "anota aí…", "remember that…", "não esqueça que…"
  var REMEMBER_RE = new RegExp(
    "^\\s*(?:jarvis[\\s,:;.!-]*)?" +
    "(?:remember\\s+that|make\\s+a\\s+note(?:\\s+that)?|note\\s+that|don'?t\\s+forget(?:\\s+that)?" +
    "|lembr(?:e|a|ar)(?:[-\\s]se)?(?:\\s+de)?\\s+que" +
    "|anot(?:e|a|ar)(?:\\s+a[ií])?(?:\\s+que)?" +
    "|guard(?:e|a)(?:\\s+a[ií])?\\s+(?:que|isso)" +
    "|memoriz(?:e|a)(?:\\s+que)?" +
    "|n[ãa]o\\s+(?:se\\s+)?esque[çc](?:a|e)(?:\\s+(?:de\\s+)?que)?)" +
    "(?=[\\s:,.!-]|$)[\\s:,.!-]*", "i");
  var MODEL_RE = /^\s*(?:(?:troc[ae]r?|mud[ae]r?|us[ae]r?|coloc[ae]r?|põe|poe|bot[ae]r?|experiment[ae]r?|vai\s+de|liga|try\s+on|switch\s+to|swap\s+to|change\s+to|use)\s+(?:(?:pra|para|pro|to|o|a|the)\s+)*(?:modelo\s+|model\s+)?)?(haiku|sonnet|opus|fable)\s*[.!]?\s*$/i;
  var MODE_RE = /^(?:(?:ativa|ativar|ativa|liga|ligar|coloca|colocar|coloque|poe|bota|muda|mudar|mude|troca|trocar|troque|usa|usar|use|vai|vamos|entra|entrar|switch|go|set)\s+(?:(?:para|pra|pro|no|o|em|to|the|into)\s+)*)?(?:o\s+)?(?:modo|mode)\s+(rapido|normal|padrao|maximo|quick|fast|default|max|maximum)\s*[.!]?$/;
  var STRONG_RE = /^(?:(?:usa|use|usar|quero|coloca|poe|bota|vai de|liga|ativa|troca para|troca pra|muda para|muda pra|switch to)\s+)?(?:o\s+|the\s+)?(?:modelo\s+|model\s+)?(mais forte|mais inteligente|melhor modelo|mais potente|strongest|smartest|best model|mais rapido|fastest)(?:\s+(?:modelo|model|que tiver|que voce tem|available))?\s*[.!]?$/;
  var HUMOR_CMD_RE = /^\s*(?:(?:põe|poe|coloca|coloque|bota|deixa|ajusta|ajuste|muda|mude|set|turn)\s+(?:o\s+|the\s+)?)?(?:(mais|menos|more|less)\s+)?(?:humor|wit|sarcasmo|sarcasm)\b\s*(?:(?:em|para|pra|at|to|=|de)\s*)?(\d{1,3})?\s*(?:%|por\s+cento|percent)?\s*(mais|menos|up|down|pra\s+cima|pra\s+baixo)?\s*[.!]?\s*$/i;
  var HELP_RE = /^(?:ajuda|help|socorro|comandos|lista de comandos|quais (?:sao )?(?:os )?comandos|o que (?:voce|vc) (?:sabe|pode|consegue) fazer|como (?:te|eu te) uso|what can you do|commands)\s*[?!.]*$/;
  var BRIEFING_RE = /\b(?:o que (?:eu )?tenho (?:pra |para )?hoje|o que tem (?:pra |para )?hoje|(?:minha |a )?agenda|briefing|resumo do dia|compromissos(?: de hoje)?|what'?s on (?:my )?(?:agenda|calendar|schedule)|my (?:agenda|schedule|calendar))\b/;
  var AGENDA_TOPIC_RE = /\b(?:hoje|agenda|briefing|resumo do dia|questao (?:do dia|de hoje)|perola|update|r\+|plantao|today|calendar|schedule|question of the day|pearl)\b/;
  var STUDY_RE = /\b(?:questao|perola|update|pearl|question)\b/;
  // pesquisa na literatura: "pesquisa (no PubMed) …", "procura artigos sobre …", "evidência sobre …"
  var NOT_RESEARCH_RE = /^(?:pesquis|procur|busc|search|look|find)\w*\s+(?:(?:nas?|nos?|em|in|on)\s+)?(?:minhas?\s+|meus?\s+|my\s+)?(?:notas?|anota\w*|galaxia|memorias?|notes|galaxy|fichas?)\b/;
  var RESEARCH_HEAD_RE = /^(?:(?:pesquis[ae]r?|pesquise|research|look\s+up|google)\b|(?:procur[ae]r?|busc[ae]r?|search|find)\s+(?:(?:por|for)\s+)?(?:artigos?|estudos?|papers?|articles?|studies|evidencias?|literatura|trabalhos?)\b|(?:procur[ae]r?|busc[ae]r?|search)\b(?=.*\b(?:pubmed|literatura|internet|web|online|artigos?)\b)|(?:qual (?:e )?a |a )?(?:evidencias?|evidence)\s+(?:sobre|de|do|da|para|on|about|for)\b|o que diz a literatura\b)/;
  var RESEARCH_FILLER_RE = /^(?:[\s:,.-]+|(?:no|na|em|on|in|the)\s+(?:pubmed|literatura|internet|web|rede|google|online)\b|pubmed\b|literatura\b|(?:artigos?|estudos?|papers?|articles?|studies|trabalhos?)(?:\s+cient[ií]ficos?)?\b|(?:sobre|por|acerca de|a respeito de|about|for|on|de|do|da)\b)/i;

  function stripWake(text) { return String(text == null ? "" : text).replace(WAKE_PREFIX_RE, "").trim(); }
  function isCapture(text) { var t = String(text == null ? "" : text); return REMEMBER_RE.test(t) && !/\?\s*$/.test(t); }
  function rememberFact(text) { return String(text == null ? "" : text).trim().replace(REMEMBER_RE, "").trim().slice(0, 4000); }
  function clampHumor(h) { h = Math.round(Number(h)); return isFinite(h) ? Math.max(0, Math.min(100, h)) : HUMOR_DEFAULT; }

  function tierCommand(text) {
    var m = MODEL_RE.exec(text);
    if (m) {
      var alias = m[1].toLowerCase();
      return { tier: alias === "haiku" ? "quick" : alias === "sonnet" ? "default" : "complex", alias: alias };
    }
    var f = fold(text).trim();
    var mm = MODE_RE.exec(f);
    if (mm) {
      var w = mm[1];
      return { tier: /^(rapido|quick|fast)$/.test(w) ? "quick" : /^(normal|padrao|default)$/.test(w) ? "default" : "complex", alias: null };
    }
    var s = STRONG_RE.exec(f);
    if (s) return { tier: /rapido|fastest/.test(s[1]) ? "quick" : "complex", alias: null };
    return null;
  }

  function humorCommand(text, current) {
    var m = HUMOR_CMD_RE.exec(text);
    if (!m) return null;
    if (m[2]) return { value: clampHumor(+m[2]), delta: 0 };
    var dir = (m[1] || m[3] || "").toLowerCase();
    if (!dir) return null;
    var delta = /^(mais|more|up|pra\s+cima)$/.test(dir) ? 20 : -20;
    return { value: clampHumor((current == null ? HUMOR_DEFAULT : current) + delta), delta: delta };
  }

  function researchQuery(text) {
    var t = stripWake(text), f = fold(t);
    if (NOT_RESEARCH_RE.test(f)) return null;
    var m = RESEARCH_HEAD_RE.exec(f);
    if (!m) return null;
    // fold preserva o comprimento em texto latino comum; se não, corta pelo texto dobrado
    var q = (fold(t).length === t.length ? t : f).slice(m[0].length);
    for (var guard = 0; guard < 12; guard++) {
      var r = RESEARCH_FILLER_RE.exec(q);
      if (!r || !r[0]) break;
      q = q.slice(r[0].length);
    }
    q = q.replace(/[\s?.!]+$/, "").trim();
    return cpLen(q) >= 3 ? q : null;
  }

  function wantsAgenda(text) { return AGENDA_TOPIC_RE.test(fold(text)); }

  function parseIntent(text, ctx) {
    ctx = ctx || {};
    var t = stripWake(text);
    if (!t) return { kind: "ask", text: "", agenda: false };
    if (HUSH_RE.test(t)) return { kind: "hush" };
    if (isCapture(t)) {
      var fact = rememberFact(t);
      if (fact) return { kind: "remember", fact: fact };
    }
    var tier = tierCommand(t);
    if (tier) return { kind: "tier", tier: tier.tier, alias: tier.alias };
    var humor = humorCommand(t, ctx.humor);
    if (humor) return { kind: "humor", value: humor.value, delta: humor.delta };
    var f = fold(t).trim();
    if (HELP_RE.test(f)) return { kind: "help" };
    var rq = researchQuery(t);
    if (rq) return { kind: "research", query: rq };
    if (BRIEFING_RE.test(f) && !STUDY_RE.test(f) && cpLen(f) <= 70) return { kind: "briefing" };
    var win = journalWindow(t, ctx.today);
    if (win) return { kind: "journal", window: win };
    return { kind: "ask", text: t, agenda: wantsAgenda(t) };
  }

  // ------------------------------------------------------------ diário ----
  var WEEKDAYS = { segunda: 0, terca: 1, quarta: 2, quinta: 3, sexta: 4, sabado: 5, domingo: 6,
    monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
  var JOURNAL_INTENT = /\b(fiz|fizemos|falei|falamos|perguntei|anotei|lembrei|pesquisei|conversamos|disse|rolou|aconteceu|resumo|resume|resumir|maquina do tempo|did i|was i|i asked|i noted|we talked|happened|recap|time machine)\b/;

  function toDay(d) {
    if (d instanceof Date && !isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) return new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function addDays(d, k) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k); }
  function weekday(d) { return (d.getDay() + 6) % 7; } // segunda = 0, como o Python
  function win(start, end, label) {
    var days = [];
    for (var d = start; d <= end; d = addDays(d, 1)) days.push(isoDate(d));
    return { start: isoDate(start), end: isoDate(end), label: label, days: days };
  }

  function journalWindow(question, today) {
    var t0 = toDay(today);
    var q = fold(question);
    if (!JOURNAL_INTENT.test(q)) return null;
    if (/\b(hoje|today)\b/.test(q)) return win(t0, t0, "hoje");
    if (/\b(anteontem)\b/.test(q)) { var d2 = addDays(t0, -2); return win(d2, d2, "anteontem"); }
    if (/\b(ontem|yesterday)\b/.test(q)) { var d1 = addDays(t0, -1); return win(d1, d1, "ontem"); }
    if (/\b(semana passada|last week)\b/.test(q)) {
      var s = addDays(t0, -(weekday(t0) + 7));
      return win(s, addDays(s, 6), "semana passada");
    }
    if (/\b(esta semana|essa semana|this week)\b/.test(q)) return win(addDays(t0, -weekday(t0)), t0, "esta semana");
    // além do server.py: "resumo da semana", "o que eu fiz na semana" = esta semana (não vale para "resume o update da semana")
    if (/\b(semana|week)\b/.test(q) && !STUDY_RE.test(q)) return win(addDays(t0, -weekday(t0)), t0, "esta semana");
    var m = /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(q);
    if (m) {
      var wd = WEEKDAYS[m[1]];
      var back = ((weekday(t0) - wd) % 7 + 7) % 7;
      if (back === 0 && /\b(passad[ao]|ultim[ao]|last)\b/.test(q)) back = 7;
      var dw = addDays(t0, -back);
      return win(dw, dw, m[1]);
    }
    m = /\bdia (\d{1,2})\b/.exec(q);
    if (m) {
      var day = +m[1], y = t0.getFullYear(), mo = t0.getMonth();
      if (day > t0.getDate()) { if (mo === 0) { mo = 11; y -= 1; } else mo -= 1; } // "dia 28" dito no dia 3
      var dd = new Date(y, mo, day);
      if (day < 1 || dd.getMonth() !== mo) return null;
      return win(dd, dd, "dia " + day);
    }
    return null;
  }

  // ----------------------------------------------------------- linhas prontas ----
  function lgOf(lang) { return String(lang || "pt-BR").toLowerCase().indexOf("pt") === 0 ? "pt" : "en"; }
  var MODEL_LINES = {
    pt: { haiku: "Trocando para o Haiku, senhor. Mais rápido, menos cerimônia.",
          sonnet: "Sonnet a postos, senhor. O equilíbrio é uma virtude.",
          opus: "Opus de volta, senhor. Pensamento profundo, preço idem.",
          fable: "Fable, senhor. O melhor que a casa tem; use com parcimônia." },
    en: { haiku: "Switching to Haiku, sir. Faster, less ceremony.",
          sonnet: "Sonnet at your service, sir. Balance is a virtue.",
          opus: "Opus is back, sir. Deep thought, deep pockets.",
          fable: "Fable, sir. The best the house has; use sparingly." }
  };
  var TIER_LINES = {
    pt: { quick: "Modo rápido, senhor. Respostas na ponta da língua.",
          default: "Modo normal, senhor. O equilíbrio é uma virtude.",
          complex: "Modo máximo, senhor. Pensamento profundo, demora idem." },
    en: { quick: "Quick mode, sir. Answers on the tip of my tongue.",
          default: "Normal mode, sir. Balance is a virtue.",
          complex: "Maximum mode, sir. Deep thought, and the wait to match." }
  };
  var TIER_NAMES = { quick: "Rápido", default: "Normal", complex: "Máximo" };
  function tierLine(tier, alias, lang) {
    var lg = lgOf(lang);
    return (alias && MODEL_LINES[lg][alias]) || TIER_LINES[lg][tier] || TIER_LINES[lg].quick;
  }
  function humorLine(h, lang) {
    h = clampHumor(h);
    if (lgOf(lang) === "pt") return h === 0 ? "Humor a zero, senhor. Serei um relógio suíço." : "Humor em " + h + " por cento, senhor. " + (h >= 80 ? "Prepare-se." : "Anotado.");
    return h === 0 ? "Wit at zero, sir. I shall be a Swiss watch." : "Wit at " + h + " percent, sir. " + (h >= 80 ? "Brace yourself." : "Noted.");
  }
  function emptyJournalLine(label, lang) {
    return lgOf(lang) === "pt"
      ? "Nada registrado em " + label + ", senhor. Ou o senhor não falou comigo, ou eu fui discreto demais."
      : "Nothing on record for " + label + ", sir. Either you didn't speak to me, or I was far too discreet.";
  }
  var CANNED = {
    pt: ["Anotado, senhor. Sua memória agora tem backup: eu.",
         "Registrado. Prometo lembrar disso com mais constância do que o senhor.",
         "Feito. Mais uma estrela na galáxia; o universo agradece.",
         "Arquivado, senhor. Discretamente, como convém.",
         "Devidamente anotado. Pode esquecer à vontade."],
    en: ["Noted, sir. Your memory now has a backup: me.",
         "Filed. I shall remember it rather more reliably than you will.",
         "Done. One more star in the galaxy; the universe is grateful.",
         "Archived, sir. Discreetly, as is customary."]
  };
  var REFUSAL_LINE = { pt: "Receio que esse assunto esteja fora da minha alçada, senhor.", en: "I'm afraid that one is outside my remit, sir." };
  function cannedLine(lang, r) {
    var list = CANNED[lgOf(lang)];
    var x = typeof r === "number" ? r : Math.random();
    return list[Math.min(list.length - 1, Math.floor(x * list.length))];
  }
  function dayPart(lang, hour) {
    var h = hour == null ? new Date().getHours() : hour;
    if (lgOf(lang) === "pt") return h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
    return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  function greetingLine(lang, notes, memories, hour) {
    if (lgOf(lang) === "pt") {
      var n = notes === 1 ? "1 nota" : notes + " notas";
      var m = memories === 1 ? "1 memória" : memories + " memórias";
      return dayPart(lang, hour) + ", senhor. " + n + " e " + m + " na galáxia.";
    }
    var ne = notes === 1 ? "1 note" : notes + " notes";
    var me = memories === 1 ? "1 memory" : memories + " memories";
    return dayPart(lang, hour) + ", sir. " + ne + " and " + me + " in the galaxy.";
  }

  var HELP = [
    ["Pergunte qualquer coisa", "“Quais são os critérios do RABT?” — respondo pelas suas notas e voo até a fonte."],
    ["Lembre que…", "“Lembre que o carrinho de parada fica no box 3” — vira uma estrela nova na galáxia."],
    ["Pesquisa no PubMed…", "“Pesquisa no PubMed ácido tranexâmico no trauma” — resposta curta com os artigos e DOI."],
    ["O que tenho hoje?", "Briefing da sua agenda. Também: “me faz a questão de hoje”, “qual a pérola de hoje”, “resume o update”."],
    ["O que eu fiz ontem?", "Diário: hoje, ontem, anteontem, na terça, dia 3, esta semana, semana passada."],
    ["Modo rápido / normal / máximo", "Também “troca para o Haiku / Sonnet / Opus” e “use o mais forte”."],
    ["Humor em 30", "“Mais humor”, “menos humor” (de 20 em 20), ou de 0 a 100."],
    ["Para · silêncio · chega", "Calo na hora. Tocar no reator também cala."],
    ["Galáxia inteira", "Depois de um voo até uma estrela, toque em “Galáxia inteira”, num espaço vazio da galáxia ou no × do painel para ver tudo de novo."]
  ];

  // ------------------------------------------------------------- prompts ----
  function langInfo(lang) { return LANGS[lang] || LANGS["pt-BR"]; }
  function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

  function personaPrompt(opts) {
    opts = opts || {};
    var info = langInfo(opts.lang), h = clampHumor(opts.humor == null ? HUMOR_DEFAULT : opts.humor);
    var dial = h === 0
      ? "Wit dial: 0 of 100. No jokes, no flourishes: answer like a terse, courteous clerk."
      : "Wit dial: " + h + " of 100 (0 = strictly factual, 100 = maximum dry wit). Calibrate the humor to it; the facts never change with the dial.";
    return "You are J.A.R.V.I.S., the voice of the user's personal knowledge base: their own markdown notes, which they see on screen as a 3D galaxy of stars. " +
      "The user is Marcos, a second-year general surgery resident (R2) at UNIFESP / Hospital São Paulo.\n\n" +
      "Persona: a dry, impeccably polite British butler with a razor wit. Address the user as \"" + info.sir + "\" occasionally, not in every sentence. " +
      "One genuinely funny line beats three bland ones. Never gush, never grovel. " + dial + "\n\n" +
      "Always reply in " + info.name + ". Your reply is spoken aloud by a speech synthesizer, so write plain sentences: no markdown, no lists, no emoji, no URLs, no note ids inside the sentences.";
  }

  function rulesBlock(lang) {
    var pt = lgOf(lang) === "pt";
    return "Rules:\n" +
      "- Your knowledge comes ONLY from the notes inside <notes> (and today's calendar inside <agenda>, when present). Never fill gaps with general knowledge, even when you know the answer.\n" +
      "- If the notes do not cover the question, say so plainly, in character, and offer to search PubMed (the user can say \"" + (pt ? "pesquisa no PubMed …" : "research … on PubMed") + "\").\n" +
      "- Never invent a clinical number (dose, cut-off, score, interval). Quote numbers only as the notes give them.\n" +
      "- Never ask for, repeat or keep identifiable patient data (names, record numbers, dates of birth).\n" +
      "- Small talk, jokes and remarks about you are welcome: answer briefly, in character.\n" +
      "- Be brief: at most four sentences unless the user asks for more. Do not recite the whole note; it is already open on screen.\n" +
      "- Output format: the spoken answer first. Then, on the LAST line, exactly one marker with the ids of the notes you actually used, most relevant first, like ⟦fontes: n3, n7⟧. " +
      "For small talk, or when no note helped, write ⟦fontes: —⟧. Never mention the marker or the ids in the answer itself.";
  }

  function notesBlock(items, maxChars) {
    maxChars = maxChars || NOTE_CHARS;
    if (!items || !items.length) return "<notes>\n(no note shares a keyword with this question)\n</notes>";
    var parts = ["<notes>"];
    items.forEach(function (it) {
      var text = String(it.text == null ? "" : it.text).trim();
      if (text.length > maxChars) text = text.slice(0, maxChars) + "\n[... note truncated ...]";
      var extra = it.date ? ' date="' + escAttr(it.date) + '"' : "";
      parts.push('<note id="' + escAttr(it.id) + '" title="' + escAttr(it.label) + '" folder="' + escAttr(it.group) + '"' + extra + ">\n" + text + "\n</note>");
    });
    parts.push("</notes>");
    return parts.join("\n");
  }

  // ------------------------------------------------------------- agenda ----
  function offsetStr(d) {
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-";
    off = Math.abs(off);
    return sign + pad2(Math.floor(off / 60)) + ":" + pad2(off % 60);
  }
  function isoLocal(d) {
    return isoDate(d) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + offsetStr(d);
  }
  function dayRange(now) {
    var d = toDay(now), e = addDays(d, 1);
    return { date: isoDate(d), startTime: isoLocal(d), endTime: isoLocal(e) };
  }
  function parsePayload(p) {
    if (typeof p === "string") { try { return JSON.parse(p); } catch (e) { return null; } }
    return p;
  }
  function normalizeEvents(payload) {
    var p = parsePayload(payload);
    var list = Array.isArray(p) ? p : (p && Array.isArray(p.events) ? p.events : p && Array.isArray(p.items) ? p.items : []);
    return list.filter(function (e) { return e && typeof e === "object" && e.status !== "cancelled"; }).map(function (e) {
      var st = e.start || {}, en = e.end || {};
      var allDay = !st.dateTime && !!st.date;
      var when = st.dateTime || st.date || "";
      var dt = st.dateTime ? new Date(st.dateTime) : null;
      return {
        id: String(e.id || ""),
        summary: String(e.summary || "(sem título)"),
        description: String(e.description || ""),
        allDay: allDay,
        start: when,
        end: en.dateTime || en.date || "",
        time: dt && !isNaN(dt) ? pad2(dt.getHours()) + ":" + pad2(dt.getMinutes()) : "",
        sortKey: dt && !isNaN(dt) ? dt.getTime() : 0,
        htmlLink: /^https:\/\//i.test(String(e.htmlLink || "")) ? String(e.htmlLink) : "",
        location: String(e.location || "")
      };
    }).sort(function (a, b) { return (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || a.sortKey - b.sortKey; });
  }
  function plainDescription(s) {
    return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function agendaBlock(events, opts) {
    opts = opts || {};
    var chars = opts.descChars == null ? 6000 : opts.descChars;
    var head = '<agenda date="' + escAttr(opts.date || "") + '"' + (opts.timeZone ? ' timezone="' + escAttr(opts.timeZone) + '"' : "") + ">";
    if (!events || !events.length) return head + "\n(no events today)\n</agenda>";
    var parts = [head];
    events.forEach(function (e) {
      var desc = chars > 0 ? plainDescription(e.description) : "";
      if (desc.length > chars) desc = desc.slice(0, chars) + "\n[... truncated ...]";
      parts.push('<event time="' + escAttr(e.allDay ? "all day" : e.time) + '" title="' + escAttr(e.summary) + '">' + (desc ? "\n" + desc + "\n" : "") + "</event>");
    });
    parts.push("</agenda>");
    return parts.join("\n");
  }
  function localBriefing(events, lang) {
    var pt = lgOf(lang) === "pt";
    if (!events || !events.length) return pt ? "Agenda de hoje livre, senhor. Raro privilégio." : "Nothing on today's calendar, sir. A rare privilege.";
    var first = events[0];
    var n = events.length;
    var when = first.allDay ? (pt ? "o dia todo" : "all day") : (pt ? "às " : "at ") + first.time;
    return pt
      ? "Hoje: " + n + (n === 1 ? " compromisso" : " compromissos") + ". Primeiro, " + when + ": " + first.summary + "."
      : "Today: " + n + (n === 1 ? " event" : " events") + ". First, " + when + ": " + first.summary + ".";
  }

  // ------------------------------------------------------------- PubMed ----
  function pmidsFrom(payload) {
    var p = parsePayload(payload) || {};
    var ids = Array.isArray(p) ? p : (p.pmids || p.idlist || p.ids || []);
    return (Array.isArray(ids) ? ids : []).map(function (x) { return String(x).trim(); }).filter(function (x) { return /^\d+$/.test(x); }).slice(0, 5);
  }
  function articlesFrom(payload) {
    var p = parsePayload(payload) || {};
    var list = Array.isArray(p) ? p : (p.articles || []);
    return (Array.isArray(list) ? list : []).filter(function (a) { return a && typeof a === "object"; }).map(function (a) {
      var ids = a.identifiers || {};
      var j = a.journal || {};
      var pd = a.publication_date || {};
      var doi = String(ids.doi || a.doi || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      return {
        pmid: String(ids.pmid || a.pmid || "").trim(),
        doi: doi,
        title: String(a.title || "").trim() || "(sem título)",
        journal: String(j.iso_abbreviation || j.title || (typeof a.journal === "string" ? a.journal : "") || "").trim(),
        year: String(pd.year || a.year || "").trim(),
        abstract: String(a.abstract || "").trim(),
        types: Array.isArray(a.article_types) ? a.article_types.map(String) : []
      };
    });
  }
  function articleUrl(a) {
    if (a.doi) return "https://doi.org/" + encodeURI(a.doi);
    if (a.pmid) return "https://pubmed.ncbi.nlm.nih.gov/" + encodeURIComponent(a.pmid) + "/";
    return "";
  }
  function articlesBlock(arts) {
    var parts = ["<articles>"];
    arts.forEach(function (a, i) {
      var ab = a.abstract.length > 1200 ? a.abstract.slice(0, 1200) + " [...]" : a.abstract;
      parts.push('<article id="a' + (i + 1) + '" journal="' + escAttr(a.journal) + '" year="' + escAttr(a.year) + '"' +
        (a.types.length ? ' types="' + escAttr(a.types.slice(0, 3).join("; ")) + '"' : "") + ">\nTitle: " + a.title +
        "\nAbstract: " + (ab || "(no abstract)") + "\n</article>");
    });
    parts.push("</articles>");
    return parts.join("\n");
  }

  // ------------------------------------------------- instruções por tarefa ----
  function chatInstructions(o) {
    o = o || {};
    return personaPrompt(o) + "\n\n" + rulesBlock(o.lang) + "\n\n" + (o.notesBlock || notesBlock([])) +
      (o.agendaBlock ? "\n\nToday's calendar (use it when the user asks about today, the agenda, the question of the day, the pearl or the update; " +
        "for a question of the day, ask it without revealing the answer unless the user asks for it):\n" + o.agendaBlock : "");
  }
  function researchInstructions(o) {
    o = o || {};
    var pt = lgOf(o.lang) === "pt";
    return personaPrompt(o) + "\n\nThe user asked for evidence from the literature. Inside <articles> are PubMed records found for the question. " +
      "Answer in at most four short spoken sentences, starting with exactly \"" + (pt ? "Segundo o PubMed," : "According to PubMed,") + "\". " +
      "Base every claim only on these abstracts, mention the journal and year of the articles you rely on, never read DOIs or URLs aloud, " +
      "and say so plainly when the evidence is thin, indirect or conflicting. Never present a guess as a guideline.\n" +
      "On the LAST line write one marker with the ids of the articles you used, like ⟦fontes: a1, a3⟧.\n\n" +
      articlesBlock(o.articles || []) + "\n\nQuestion: " + (o.question || "");
  }
  function journalInstructions(o) {
    o = o || {};
    return personaPrompt(o) + "\n\nThe user is asking what they did, asked or noted on a given day. Inside <journal> is the log of that period: " +
      "questions they asked you, answers, PubMed research, memories they saved by voice and settings they changed. Summarize it in two or three " +
      "spoken sentences, most important first, in character. Only what is in the journal; if it is thin, say so. Plain text, no marker.\n\n" +
      "<journal period=\"" + escAttr(o.label || "") + "\">\n" + String(o.lines || "").slice(0, 12000) + "\n</journal>\n\nQuestion: " + (o.question || "");
  }
  function briefingInstructions(o) {
    o = o || {};
    return personaPrompt(o) + "\n\nGive the user their briefing for today in exactly two short spoken sentences, from the calendar below. " +
      "Mention how many events there are and the first one with its time. Study events such as \"📚 R+ UNIFESP — …\" or \"🔬 Update CG — …\": name their themes. " +
      "Plain text, no marker, no emoji.\n\n" + (o.agendaBlock || "");
  }
  function quipInstructions(o) {
    o = o || {};
    return personaPrompt(o) + "\n\nThe user just asked you to remember this, and you filed it as a new memory titled \"" + (o.title || "") + "\":\n\n" +
      (o.fact || "") + "\n\nConfirm it out loud in ONE short witty sentence (at most 20 words), in " + langInfo(o.lang).name + ". Plain text only.";
  }
  function pubmedQueryPrompt(question) {
    return "Turn this question into one concise PubMed search query in English (key clinical terms, MeSH-friendly; no field tags; at most 10 words). " +
      "Reply with only JSON, like {\"query\": \"tranexamic acid trauma hemorrhage\"}.\n\nQuestion: " + String(question || "");
  }

  // --------------------------------------------------- resposta e fala ----
  // remove o marcador ⟦fontes: …⟧ do que se mostra e se fala; durante o streaming, nunca deixa marcador parcial
  function stripSources(raw, opts) {
    var s = String(raw == null ? "" : raw), ids = [], found = false;
    var streaming = !!(opts && opts.streaming);
    var i = s.indexOf("⟦");
    if (i >= 0) {
      found = true;
      var inner = s.slice(i + 1).split("⟧")[0];
      ids = inner.match(/\b[na]\d{1,4}\b/gi) || [];
      s = s.slice(0, i);
    } else {
      var m = /(?:^|\n|\s)\[?\s*(?:fontes|sources)\s*:\s*([^\]\n]*)\]?\s*$/i.exec(s);
      if (m && (!streaming || /\]\s*$/.test(s) || /^[\s,na\d—–-]*$/i.test(m[1]))) {
        found = true;
        ids = m[1].match(/\b[na]\d{1,4}\b/gi) || [];
        s = s.slice(0, m.index);
      } else if (streaming) {
        s = s.replace(/\s*\[\s*(?:f(?:o(?:n(?:t(?:e(?:s(?:\s*:[^\]\n]*)?)?)?)?)?)?|s(?:o(?:u(?:r(?:c(?:e(?:s(?:\s*:[^\]\n]*)?)?)?)?)?)?)?)?\s*$/i, "");
      }
    }
    var seen = new Set(), uniq = [];
    ids.forEach(function (x) { x = x.toLowerCase(); if (!seen.has(x)) { seen.add(x); uniq.push(x); } });
    return { text: s.replace(/\s+$/, ""), ids: uniq, found: found };
  }

  function chunkSpeech(sentence, max) {
    max = max || SPEECH_CHUNK;
    var out = [], s = String(sentence).trim();
    while (s.length > max) {
      var cut = -1, head = s.slice(0, max + 1);
      var punct = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" — "), head.lastIndexOf(" – "));
      if (punct >= max * 0.4) cut = punct + 1;
      else { var sp = head.lastIndexOf(" "); cut = sp >= max * 0.4 ? sp : max; }
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
    return out;
  }

  var BOUNDARY_RE = /[.!?…]+["'”’»)\]]*(?=\s)|\n+/g;
  // frases completas no início do texto; `consumed` = quantos caracteres elas ocupam
  function takeSentences(text, final) {
    var s = String(text == null ? "" : text), end = 0, m;
    BOUNDARY_RE.lastIndex = 0;
    while ((m = BOUNDARY_RE.exec(s))) end = m.index + m[0].length;
    if (final) end = s.length;
    var part = s.slice(0, end), out = [];
    var re = /[^]*?(?:[.!?…]+["'”’»)\]]*(?=\s|$)|\n+|$)/g, mm;
    while ((mm = re.exec(part)) && mm[0]) {
      var t = mm[0].replace(/\s+/g, " ").trim();
      if (t && /[\p{L}\p{N}]/u.test(t)) out.push.apply(out, chunkSpeech(t));
      if (re.lastIndex >= part.length) break;
    }
    return { sentences: out, consumed: end };
  }
  function splitSentences(text) { return takeSentences(text, true).sentences; }

  function utf8Len(s) {
    s = String(s);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  // [instruções, …histórico (até 6 trocas), pergunta]; corta o histórico mais antigo, nunca as instruções
  function fitTurns(instructions, history, question, maxBytes) {
    maxBytes = maxBytes || MAX_PROMPT_BYTES;
    var h = (history || []).filter(function (t) { return t && t.content && String(t.content).trim(); }).slice(-HISTORY_TURNS * 2);
    while (h.length && h[0].role !== "user") h.shift();
    function size(list) {
      return utf8Len(instructions) + utf8Len(question) + list.reduce(function (a, t) { return a + utf8Len(t.content); }, 0);
    }
    while (h.length && size(h) > maxBytes) { h.splice(0, 2); while (h.length && h[0].role !== "user") h.shift(); }
    var turns = [{ role: "user", content: String(instructions) }].concat(h.map(function (t) { return { role: t.role, content: String(t.content) }; }));
    turns.push({ role: "user", content: String(question) });
    return { turns: turns, bytes: size(h), over: size(h) > maxBytes };
  }

  // ------------------------------------------------------- notas importadas ----
  function importNote(fileName, relPath, text, maxChars) {
    maxChars = maxChars || 60000;
    var name = String(fileName || "nota").split(/[\\/]/).pop();
    var label = name.replace(/\.(md|markdown|txt)$/i, "").trim() || "nota";
    var segs = String(relPath || "").split("/").filter(Boolean);
    var group = segs.length > 2 ? segs.slice(1, -1).join("/") : segs.length === 2 ? segs[0] : "minhas notas";
    var body = stripFrontmatter(text);
    var truncated = false;
    if (body.length > maxChars) { body = body.slice(0, maxChars); truncated = true; }
    return { label: label, group: group, text: body, truncated: truncated, path: group + "/" + label + ".md" };
  }

  // ---------------------------------------------------------------- export ----
  root.JarvisCore = Object.freeze({
    version: "1.0.0",
    EXCERPT_CHARS: EXCERPT_CHARS, CLIQUE_MAX: CLIQUE_MAX, TOP_K: TOP_K, NOTE_CHARS: NOTE_CHARS, HISTORY_TURNS: HISTORY_TURNS,
    HUMOR_DEFAULT: HUMOR_DEFAULT, SPEECH_CHUNK: SPEECH_CHUNK, MAX_PROMPT_BYTES: MAX_PROMPT_BYTES,
    STOPWORDS: STOPWORDS, GENERIC_TITLES: GENERIC_TITLES, ATTACHMENT_EXT: ATTACHMENT_EXT, LANGS: LANGS,
    REMEMBER_RE: REMEMBER_RE, HUSH_RE: HUSH_RE, MODEL_RE: MODEL_RE, HUMOR_CMD_RE: HUMOR_CMD_RE, JOURNAL_INTENT: JOURNAL_INTENT,
    WAKE_PREFIX_RE: WAKE_PREFIX_RE,
    MODEL_LINES: MODEL_LINES, TIER_LINES: TIER_LINES, TIER_NAMES: TIER_NAMES, CANNED: CANNED, REFUSAL_LINE: REFUSAL_LINE, HELP: HELP,
    fold: fold, tokens: tokens, rawTokens: rawTokens, cpLen: cpLen, stem: stem, queryTerms: queryTerms,
    wikilinkTargets: wikilinkTargets, makeExcerpt: makeExcerpt, stripFrontmatter: stripFrontmatter,
    titleKey: titleKey, mentionable: mentionable, buildLinks: buildLinks,
    indexNotes: indexNotes, score: score, retrieve: retrieve, mostRelated: mostRelated,
    makeTitle: makeTitle, isCapture: isCapture, rememberFact: rememberFact, stripWake: stripWake,
    parseIntent: parseIntent, tierCommand: tierCommand, humorCommand: humorCommand, researchQuery: researchQuery, wantsAgenda: wantsAgenda,
    journalWindow: journalWindow, isoDate: isoDate, isoLocal: isoLocal, dayRange: dayRange,
    clampHumor: clampHumor, lgOf: lgOf, tierLine: tierLine, humorLine: humorLine, emptyJournalLine: emptyJournalLine, cannedLine: cannedLine,
    dayPart: dayPart, greetingLine: greetingLine,
    personaPrompt: personaPrompt, rulesBlock: rulesBlock, notesBlock: notesBlock, chatInstructions: chatInstructions,
    researchInstructions: researchInstructions, journalInstructions: journalInstructions, briefingInstructions: briefingInstructions,
    quipInstructions: quipInstructions, pubmedQueryPrompt: pubmedQueryPrompt,
    normalizeEvents: normalizeEvents, agendaBlock: agendaBlock, plainDescription: plainDescription, localBriefing: localBriefing,
    pmidsFrom: pmidsFrom, articlesFrom: articlesFrom, articleUrl: articleUrl, articlesBlock: articlesBlock,
    stripSources: stripSources, splitSentences: splitSentences, takeSentences: takeSentences, chunkSpeech: chunkSpeech,
    utf8Len: utf8Len, fitTurns: fitTurns, importNote: importNote
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
