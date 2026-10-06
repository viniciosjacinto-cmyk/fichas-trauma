# JARVIS como Artifact do claude.ai — especificação de construção

Diretório de trabalho: esta pasta, `jarvis/claude-app` (abaixo, `$A`; na construção, `ref/` também tinha cópias de `../build.py`, `../server.py` e `../viewer/index.html` como `old-viewer.html`).

## Objetivo

Um único arquivo `$A/jarvis.html`, publicado como Artifact no claude.ai, que entrega o JARVIS funcionando em qualquer aparelho (iPad, iPhone, Mac) **sem instalar nada**: galáxia 3D das notas, cérebro Claude (pago pela conta do próprio usuário via capability `sample`), voz falada, memórias e diário persistentes (capability `db`), briefing do dia pela agenda Google e pesquisa no PubMed (capability `mcp`). Usuário: Marcos, residente R2 de Cirurgia Geral da UNIFESP/HSP, não programador, fala português do Brasil, usa sobretudo o iPad no app/Safari do Claude. Ele foi explícito: quer o app funcionando, sem idas e vindas. Qualidade e robustez acima de tudo: nada pode quebrar a página.

Referências no disco (leia antes de escrever):
- `$A/ref/old-viewer.html` — a versão anterior (servidor local). Porte dela a galáxia, visual, painel, voz, regex de intenções, pulso do reator, chips de fonte, `flyTo`, aglomerado (4+ fontes), nó novo nascendo junto da âncora com pulso de luz.
- `$A/ref/build.py` — `fold`, `tokens`, `STOPWORDS`, `GENERIC_TITLES`, `mentionable`, `wikilink_targets`, `build_links` (com índice de menções, siglas só em maiúsculas, `resolve()` com `[[pasta/Nota]]`, preferência pela mesma pasta, clique ≤10 senão estrela). Porte fiel para JS.
- `$A/ref/server.py` — `query_terms`/`stem`, `Brain.index_note`/`score`/`most_related` (recuperação top-6 com título pesando mais), `persona`, `system_prompt`, `notes_block`, `research_prompt`, `journal_prompt`, `JOURNAL_INTENT` + `journal_window`, `REMEMBER_RE`, `make_title`, `MODEL_LINES`, `HUMOR_LINES`, `EMPTY_JOURNAL`, `CANNED`. Porte a lógica e os textos (pt-BR e en-GB).
- `$A/ref/notes.json` — as 26 notas de exemplo `{path,label,group,text}`; `$A/ref/links.json` — as 71 ligações que o `build.py` gera para elas (paridade obrigatória).
- Contratos da plataforma (autoridade máxima sobre a API): `/tmp/claude-0/bundled-skills/2.1.290/9815a0a1613a923949592860ad5a7815/artifact-capabilities/0.2.69/{claude,sample,db,user,mcp,permissions}.d.ts`. Leia com a ferramenta Read.

## Contrato da página (regras do Artifact — violar = página quebrada)

1. O arquivo é **conteúdo de body**: sem `<!doctype>`, `<html>`, `<head>`, `<body>`. Começa com `<title>JARVIS</title>` e depois `<style>`. A plataforma embrulha num esqueleto com charset, viewport `viewport-fit=cover` e um reset (`:root` com padding das safe-areas, `body{margin:0}`, `[hidden]{display:none!important}`).
2. Scripts externos só de `https://cdn.jsdelivr.net/npm/`, `https://cdnjs.cloudflare.com`, `https://unpkg.com`. Fontes só Google Fonts (com fallback real). Nenhum `fetch` para fora (bloqueado). Versões fixas: `3d-force-graph@1.80.1` (UMD, `dist/3d-force-graph.min.js`) e `three@0.186.1` (ESM via importmap, só para bloom/brilho).
3. **O núcleo não pode depender do módulo ESM.** A galáxia tem de funcionar só com o UMD (nós padrão do 3d-force-graph). O `<script type="module">` de realce (importmap → `three` + `UnrealBloomPass`, nós esfera+sprite de brilho) roda em try/catch e, se falhar, a página segue igual sem bloom. Se até o UMD falhar (WebGL ausente, CDN fora), mostre um aviso discreto e mantenha chat, voz e memórias funcionando sem galáxia.
4. `alert/confirm/prompt` não existem (confirm devolve false): confirmações são UI da própria página. `window.open` não serve: links são `<a href target="_blank" rel="noopener">`. Nada de download, print, service worker, iframe, `<object>`.
5. **Microfone, câmera e afins são recusados sem prompt para todos.** Não use SpeechRecognition. O botão 🎙 foca a caixa de texto e mostra a dica de ditado do sistema: no iPad/iPhone, "toque no 🎤 do teclado e fale"; no Mac, "aperte a tecla de ditado (🎤) ou Fn duas vezes". Detecte toque (`matchMedia('(pointer: coarse)')`) para escolher a dica. Enter envia; no iPad, o botão Enviar grande também.
6. Som só depois de interação: o primeiro toque em "Ativar JARVIS" (ou em qualquer controle) destrava `speechSynthesis` (fale um enunciado vazio/curto dentro do gesto) e o `AudioContext`.
7. `localStorage`/`sessionStorage` sempre em try/catch; a página funciona sem eles. Só para conveniências (último modo do painel etc.) e como reserva quando o `db` não existe.
8. Layout: funciona em 390×844 (iPhone), 820×1180 (iPad retrato), 1180×820 (iPad paisagem), 1440×900. Nunca rolagem horizontal do body. Gutter lateral ≥16px. App de tela única: `html,body{height:100%}` (não `100vh`), barra inferior fixa somando `env(safe-area-inset-bottom,0px)` ao próprio padding, barra superior somando `env(safe-area-inset-top,0px)`. Alvos de toque ≥44px. Teclado do iPad abrindo não pode esconder a caixa de texto (use `visualViewport` para ajustar o dock).
9. Tema: o JARVIS é deliberadamente escuro (um só mundo visual). Defina todas as cores como tokens no `:root` com `color-scheme: dark`, `body` com `background` explícito por token; nenhuma cor literal fora dos tokens. Foco visível no teclado. `prefers-reduced-motion`: sem deriva nem voos longos. Todo controle de formulário com `id` estável.
10. `<title>JARVIS</title>` nos primeiros 8 KB.
11. Tamanho total < 1 MB.

## Capabilities (declaradas na publicação)

```js
{ sample: {}, db: {}, user: {},
  mcp: { servers: [
    { server: "Google Calendar", tools: ["list_events"] },
    { server: "PubMed", tools: ["search_articles", "get_article_metadata"] } ] } }
```

Regras gerais do contrato: tudo via `await claude.use(nome)`, que resolve depois (nunca no primeiro run síncrono) ou `null` em até ~10 s. `window.claude` pode nem existir (arquivo aberto fora do claude.ai): use `window.claude?.use ? window.claude.use(n) : Promise.resolve(null)`. Renderize tudo sem as capabilities e acenda os recursos quando resolverem. Os namespaces são congelados: nunca atribua neles. Nenhuma chamada paga ou que pede consentimento no carregamento: `sample` e `mcp` só depois de um gesto do usuário (o toque em "Ativar JARVIS" conta).

### Cérebro — `sample`

- Chat: `sample(turns, { onText, signal, modelTier, cache: false })`, onde `turns = [{role:"user", content: INSTRUÇÕES}, ...histórico (até 6 trocas), {role:"user", content: pergunta}]`. INSTRUÇÕES = persona (com o dial de humor) + regras + bloco das notas recuperadas (top-6, cada nota cortada em 8000 caracteres, com id, título e pasta) + memórias relevantes + (quando a pergunta fala de hoje/agenda/resumo do dia/questão do dia/update) os eventos de hoje da agenda. Lembre: sem system prompt, sem memória entre chamadas, até 256 KiB (corte o histórico mais antigo, nunca as instruções).
- Formato da resposta: texto falável em pt-BR, curto (até 4 frases salvo pedido), e **na última linha** um marcador `⟦fontes: n3, n7⟧` com os ids das notas usadas (ou `⟦fontes: —⟧` em conversa fiada). A página remove o marcador do que mostra e do que fala (inclusive durante o streaming: nunca exiba nem fale `⟦` parcial) e usa os ids para o voo até a fonte; ids inválidos são ignorados.
- Streaming: mostre "Pensando…" e anime o reator até o primeiro `onText`; depois atualize a bolha com `text` (o texto inteiro até agora, atribua, nunca `+=`). Fale frase a frase conforme as frases completam (fila de enunciados), sem repetir nem pular.
- Botão Parar enquanto pensa/fala: `AbortController` novo por chamada; `cancelled` não é erro para o usuário.
- Erros por `code`: `not_granted`/`sampling_disabled`/`not_declared`/`capability_disabled`/`capability_removed` → desliga o cérebro nesta visita com aviso claro ("O cérebro precisa da sua permissão para usar o Claude. Recarregue e toque em Permitir."); `rate_limited` → "Muitas perguntas seguidas ou limite da sua conta; tente daqui a pouco"; `session_expired` → "Entre de novo no claude.ai"; `refused` → limpa o parcial e avisa; `prompt_too_large` → reduz contexto e avisa; `empty_completion` → avisa; `upstream_error`/desconhecido → mantém `e.text`, marca interrompido, botão "Tentar de novo". Nunca tente de novo sozinho em laço.
- Modo (dial de modelo): `quick` = "Rápido" (padrão — resposta quase instantânea, bom para voz), `default` = "Normal", `complex` = "Máximo". Comandos: "modo rápido/normal/máximo", "troca para o Haiku/Sonnet/Opus" (Haiku→quick, Sonnet→default, Opus/Fable→complex), "use o mais forte" → complex. Mostre o modo num chip; se `modelTierApplied` vier diferente, diga que o plano dele serviu outro.
- Humor 0–100 (padrão 70): "humor em 30", "mais/menos humor" (±20), slider nas configurações. Persona: mordomo britânico, seco e espirituoso, trata por "senhor", em pt-BR (ou en-GB se o idioma for inglês); conhecimento só das notas — se não está nas notas, diz que não está e oferece pesquisar no PubMed; conversa fiada liberada; nunca inventa número clínico; não grava dados identificáveis de paciente.
- Lembretes curtos (confirmação de memória, título da memória) podem usar `sample` com `modelTier:"quick"`; se falhar, a memória continua salva com título local (`make_title`).

### Memórias, notas próprias, diário e ajustes — `db` + `user`

- `const user = await claude.use("user"); const uid = user ? await user.id() : null`. Com `db` e `uid`: tudo por pessoa sob `data/users/<uid>/` (privado por padrão). Sem `uid` ou sem `db`: guarde em `localStorage` (try/catch) e mostre um aviso discreto "memórias só neste aparelho".
- Caminhos (conte segmentos: coleção = ímpar, documento = par):
  - ajustes: documento `data/users/<uid>/settings` → `{humor, tier, voice:{on, rate, voiceURI}, lang, hideSamples}`.
  - memórias: `db.doc("data/users/"+uid+"/profile").collection("memories")` → documentos `{text, title, createdAt (ISO), anchor (id da nota âncora ou null)}`.
  - notas importadas: `.../profile` → `.collection("notes")` → `{label, group, text (≤ 60 000 caracteres), importedAt}`.
  - diário: `.../profile` → `.collection("days")` → um documento por dia `YYYY-MM-DD` com `{date, events:[{t (ISO), kind:"ask"|"research"|"remember"|"briefing"|"settings", q, a (≤300 caracteres), sources:[rótulos]}]}`; no máximo 200 eventos por dia (descarte os mais antigos).
- `onSnapshot` uma vez por coleção no boot (memórias e notas), nunca em render; escreva um documento por vez, só em mudança real; trate `invalid_argument` (escrita recusada → modo somente leitura nesta visita), `quota_exceeded` (avise), `unavailable` (uma nova tentativa após atraso aleatório), `revoked`.
- "Lembre que …" (regex `REMEMBER_RE` do viewer antigo + inglês): salva a memória, cria o nó na galáxia ao vivo, colado na nota mais parecida (`most_related` portado; âncora só se houver sobreposição real), com pulso de luz e voo da câmera, responde com confirmação curta no tom do mordomo. Memórias entram na recuperação como notas do grupo "memórias".
- Painel de uma memória ou nota importada: botão "Apagar" com confirmação inline (dois toques), remove do `db` e da galáxia.
- "Adicionar notas" (botão no menu): `<input type=file multiple accept=".md,.markdown,.txt,text/markdown,text/plain">` + arrastar e soltar. Remove frontmatter YAML, rótulo = nome do arquivo sem extensão, grupo = "minhas notas" (ou a pasta de `webkitRelativePath` se houver). Até 500 notas, 60 000 caracteres cada (corta com aviso). Mostra "Não importe dados de pacientes." Reconstrói a galáxia com `buildLinks` sobre todas as notas visíveis. "Esconder notas de exemplo" nos ajustes.
- Diário: "o que eu fiz ontem / na terça / dia 3 / hoje / esta semana?" (`JOURNAL_INTENT` + `journal_window` portados, em pt-BR e inglês) lê os documentos de dia da janela e pede ao Claude um resumo; as memórias daquele período viram fontes clicáveis.

### Briefing e agenda — `mcp` "Google Calendar"

- Payload real de `list_events`: `{accessRole, summary, timeZone, events?: [{id, summary, description?, start:{dateTime?|date?, timeZone?}, end:{...}, htmlLink, status, ...}]}` (sem `events` quando o dia está vazio). Chame com `{startTime: <hoje 00:00 local ISO com offset>, endTime: <amanhã 00:00>, orderBy:"startTime", pageSize: 20, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}`.
- No toque em "Ativar JARVIS": saudação falada com a contagem real de notas e memórias ("Boa noite, senhor. 26 notas e 3 memórias na galáxia.") e, em seguida, o briefing: busca os eventos de hoje e pede ao Claude (`quick`) duas frases resumindo o dia. A agenda dele tem eventos de estudo diários ("📚 R+ UNIFESP — …", "🔬 Update CG — …") com o conteúdo completo na descrição: o briefing cita os temas; "me faz a questão de hoje", "qual a pérola de hoje", "resume o update" usam as descrições (cada uma cortada em 6000 caracteres) como contexto.
- Comando "o que tenho hoje / agenda / briefing" refaz o briefing. Eventos de hoje ficam em memória por 10 minutos.
- Erros por `code` (nunca um banner genérico único): `server_not_connected`/`selection_required` → "Conecte o Google Agenda em claude.ai → Configurações → Conectores"; `needs_reauth` → "Reconecte o Google Agenda em claude.ai → Configurações → Conectores"; `not_in_manifest` → "Você não liberou a agenda para o JARVIS; dá para liberar no menu de permissões do artifact"; `blocked_by_policy`/`approval_required` → "A agenda está bloqueada pela sua organização"; `server_unavailable`/`upstream_error` com `retryable` → uma nova tentativa após `retryAfterMs` ou 1–3 s; demais → "Não consegui ler a agenda agora". Sem agenda, o JARVIS segue sem briefing e diz isso uma vez, sem insistir.

### Pesquisa — `mcp` "PubMed"

- Gatilho: "pesquisa (no PubMed/na literatura/na internet) …", "procura artigos sobre …", "evidência sobre …" (adapte `RESEARCH_RE`; "procura na minha nota/galáxia" NÃO é pesquisa).
- Fluxo feito pela página (sem `tools` do sample, para ser rápido e funcionar em todo lugar): (1) `sample.json` `quick` traduz a pergunta para uma consulta PubMed em inglês `{query}`; se falhar, use o texto cru; (2) `callTool("PubMed","search_articles",{query, max_results:5, sort:"relevance"})` → payload `{pmids:[...], total_count, returned_count, has_more}`; (3) `callTool("PubMed","get_article_metadata",{pmids})` → payload `{articles:[{identifiers:{pmid,doi}, title, abstract, journal:{title, iso_abbreviation}, publication_date:{year,month,day}, article_types:[...]}], count}`; (4) `sample` (modo atual) com os artigos (abstract cortado em 1200 caracteres) responde em pt-BR, curto e falável, começando com "Segundo o PubMed," e citando os artigos; (5) mostre as fontes como links clicáveis `https://doi.org/<doi>` (ou `https://pubmed.ncbi.nlm.nih.gov/<pmid>/` sem DOI) com título, revista e ano — **obrigatório pela licença do PubMed: atribuição + DOI de cada artigo usado**. A câmera não se mexe na pesquisa. Nada encontrado → diga isso. Erros do mcp como na agenda, com o nome "PubMed".

### Voz

- `speechSynthesis` com a melhor voz pt-BR (porte `pickVoice` e o placar de vozes do viewer antigo; en-GB quando o idioma for inglês). Velocidade ajustável (0,8–1,3). Botão de voz liga/desliga. "Para", "silêncio", "chega" (`HUSH_RE`) calam na hora sem virar pergunta. Tocar no reator também cala.
- iOS: `speechSynthesis` pode travar após ~15 s; porte o keepAlive (pause/resume) do viewer antigo e corte frases longas em pedaços ≤ 220 caracteres.
- O reator do HUD pulsa a cada palavra (`onboundary`) e de forma suave enquanto pensa; vermelho = falando, âmbar = pensando, ciano = pronto.

## Interface

- Primeira tela (estado inicial completo, sem esperar nada): galáxia girando devagar com as 26 notas; no centro inferior, cartão "JARVIS" com o botão grande **Ativar JARVIS** (destrava áudio, cumprimenta e faz o briefing) e uma linha de status. Depois de ativado, o cartão vira o dock: caixa de texto grande ("Pergunte ou dite…"), 🎙 (dica de ditado), Enviar/Parar, e um menu ⋯ com: Adicionar notas, Ajustes (modo, humor, voz, velocidade, idioma pt-BR/en-GB, esconder notas de exemplo), Diário de hoje, Ajuda (lista de comandos de voz em pt-BR).
- Bolha de resposta acima do dock (últimas trocas roláveis), com chips das fontes (clique → voa até o nó e abre o painel). Painel lateral (ou folha inferior no celular) com título, pasta e trecho renderizado (markdown leve, wikilinks clicáveis), como no viewer antigo.
- Topo: chip de modo (Rápido/Normal/Máximo), humor %, contagem de notas e memórias, estado da agenda (ícone discreto).
- Legenda de pastas como no viewer antigo (some em telas estreitas).
- Copy curta, direta, em pt-BR, voz ativa. Erros dizem o que houve e como resolver.

## Testabilidade (obrigatório)

- Toda a lógica pura fica num `<script id="jarvis-core">` clássico, sem tocar no DOM, que define `globalThis.JarvisCore = { fold, tokens, stem, queryTerms, buildLinks, makeExcerpt, wikilinkTargets, indexNotes, retrieve, mostRelated, makeTitle, parseIntent, journalWindow, stripSources, splitSentences, personaPrompt, ... }`. `parseIntent(text)` devolve `{kind: "hush"|"remember"|"research"|"tier"|"humor"|"journal"|"briefing"|"help"|"ask", ...}`.
- `buildLinks(notas)` sobre `ref/notes.json` tem de devolver exatamente `ref/links.json` (mesmos pares, mesma ordem por índice).
- O restante (DOM, capabilities) em outros scripts. As notas de exemplo embutidas num `<script type="application/json" id="sample-notes">` com o conteúdo exato de `ref/notes.json`.
- Ganchos de teste sem custo em produção: `window.__jarvis = { state, graph }` só leitura.
