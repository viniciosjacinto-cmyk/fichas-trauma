# JARVIS — segundo cérebro falante

Os 6 prompts do *Build Your Own JARVIS* (Zubair Trabzada · AI Workshop), executados:

1. **Galáxia** — `build.py` lê todas as notas `.md` e o `viewer/` mostra uma galáxia 3D: fundo estrelado, nós brilhando por pasta, deriva lenta quando ninguém mexe, clique voa até a nota, acende os vizinhos e abre o trecho.
2. **Cérebro** — `POST /chat`: pontua as notas por palavra-chave (título pesa mais), manda as 6 melhores ao Claude, que responde **só** com base nelas. Lembra a conversa por sessão.
3. **Voz** — fala as respostas (Web Speech API) e escuta pelo 🎙 (reconhecimento de voz do Chrome, Edge ou Safari).
4. **Fly-to-source** — a câmera voa até a nota-fonte e acende os vizinhos; com 4 ou mais fontes, acende o aglomerado inteiro.
5. **Personalidade** — mordomo britânico, seco e espirituoso; conversa fiada não mexe a câmera; saudação com a contagem real de notas.
6. **Memória por voz** — "lembre que…" vira nota nova em `captures/`. Ela nasce com um pulso de luz ao lado da nota mais parecida (quando existe uma de verdade), e a câmera voa até ela.

Python 3 só com biblioteca padrão (roda no `python3` que vem no Mac) e uma biblioteca 3D via CDN. Sem npm, sem build.

## Rodar

```bash
cd jarvis
python3 server.py
```

Abra **http://localhost:4700 no Chrome** e clique uma vez na página para ligar a voz.

Por padrão abre só no próprio computador: o servidor só aceita `localhost`. Para usar no iPad ou iPhone, veja "No iPad ou iPhone, pelo Tailscale" mais abaixo.

Na primeira vez o servidor cria `config.json` e indexa as notas de exemplo de `notes/`: 26 notas tiradas do próprio app Ficha de Trauma (escores, protocolo, app, rotina).

### Ligar o cérebro — duas opções

**Com API key** (rápido): cole a chave em `config.json`, no campo `api_key`, e recarregue a página. Não precisa reiniciar o servidor. Nunca cole a chave num chat.

**Sem API key**: se o Claude Code estiver instalado, o JARVIS usa `claude -p` e roda na sua assinatura. É mais lento, uns 5–10 s por resposta, mas não cobra API. Basta deixar o `api_key` com o placeholder.

O comando é procurado no PATH e nos lugares onde o instalador costuma pô-lo: `~/.claude/local`, `~/.local/bin` e Homebrew. Se estiver em outro lugar, informe o caminho completo em `claude_command`.

O `claude -p` roda travado: sem ferramentas, sem servidores MCP e sem salvar sessão. Se o seu Claude Code for antigo demais para essas travas, o JARVIS não roda e pede `claude update`.

O terminal do servidor diz qual cérebro ligou.

Custo com API e `claude-opus-5-5`: algo entre US$ 0,01 e 0,05 por pergunta, conforme o tamanho das notas. É estimativa minha; confira o gasto real no console da Anthropic. Com `"model": "claude-haiku-4-5"` sai umas 4× mais barato.

### Usar as suas notas

```bash
python3 build.py ~/caminho/do/seu/vault    # Obsidian, export do Notion, qualquer pasta com .md
python3 server.py
```

O caminho fica gravado em `config.json`. Pode rodar o `build.py` com o servidor ligado: ele percebe a mudança, e basta recarregar a página.

Regras de indexação:

- **Grupo e cor**: cada pasta vira um grupo com cor própria.
- **Ligações por menção**: duas notas se ligam quando uma cita o título da outra no texto. Títulos de 2 letras só contam como sigla escrita em maiúsculas: TC, RX, US.
- **Ligações por wikilink**: `[[Nota]]` liga direto na nota. `[[pasta/Nota]]` respeita a pasta, e um nome repetido em várias pastas fica com a da mesma pasta (senão a de caminho mais curto), como no Obsidian.
- **Alvo sem nota própria** (`[[REDCap]]`): as notas que apontam para ele se ligam entre si. Com mais de 10 notas, ligam-se em estrela, para não embolar.
- **Pastas ignoradas**: `.obsidian`, `.trash` e as ocultas. Pastas-atalho (links simbólicos) são seguidas.
- **Arquivo ilegível** (sem permissão, atalho quebrado): vira aviso no terminal e fica de fora; o resto entra.
- **Codificação**: notas com BOM ou salvas no Windows antigo (cp1252) são lidas certo.

## Roteiro de teste (voz nos dois sentidos)

1. Abra no Chrome e clique em qualquer lugar. Deve ouvir: *"Bom dia (ou Boa tarde, Boa noite), senhor. 26 notas indexadas, todas presentes e contabilizadas."*
2. Digite **Quais são os critérios do RABT?** e aperte Enter. A resposta deve vir falada, a câmera voar até RABT, os vizinhos acenderem e o painel abrir.
3. Clique no 🎙, permita o microfone e diga **Qual a janela do ácido tranexâmico?** A barra mostra "● ouvindo…", depois "● pensando…", e a resposta é falada.
4. Diga **Como se calcula o TRISS?** e depois **E para menores de 15 anos?** A segunda pergunta deve ser entendida pelo contexto da primeira.
5. Diga **Me conta uma piada**. Ele responde no personagem e a câmera não se move.
6. Diga **Lembre que prompt packs são ótimos presentes**. Nasce uma estrela nova em `captures`, a câmera voa até ela e ele confirma com uma frase. O arquivo aparece em `notes/captures/`.
7. Clique num grupo da legenda, no canto inferior esquerdo: o grupo inteiro acende. Esc limpa o destaque.
8. Clique no 👂. Sem tocar em nada, diga **"Jarvis, qual a janela do ácido tranexâmico?"**. Enquanto ele responde, diga **"Jarvis"**: ele cala no ato.
9. Diga **"Jarvis, pesquisa na internet qual a dose de ácido tranexâmico no trauma"**. A resposta vem falada e as fontes aparecem como links.
10. Diga **"Jarvis, troca para o Haiku"** e depois **"Jarvis, o que eu fiz hoje?"**.

## Os extras — o JARVIS do vídeo

Tudo o que o autor do pack mostrou no vídeo e deixou de fora dos 6 prompts, menos o que precisa de conta paga (ver abaixo).

| Diga (ou digite) | O que acontece |
|---|---|
| **👂 Mãos livres** (botão ao lado do 🎙) | Ele fica ouvindo. Diga **"Jarvis"** e o pedido, sem clicar em nada: *"Jarvis, quais os critérios do RABT?"*. Só "Jarvis" arma (toca uma campainha, status "● às ordens") e ele espera o pedido por 9 s. Conversa de fundo sem o nome é ignorada. A preferência fica salva. |
| **"Jarvis"** no meio da fala dele | Interrompe na hora. *"Jarvis, para"* (ou *chega*, *silêncio*) só cala. |
| **"Pesquisa na internet …"** / *"procura …"* / *"research …"* | Pesquisa na web (busca da própria API da Anthropic, ou a do Claude Code), responde em 2–3 frases faladas e mostra as fontes clicáveis na tela. A câmera não se move. Cada pesquisa custa à parte na API (hoje, US$ 10 por mil buscas, mais os tokens); confira no console. |
| **"Troca para o Haiku"** / *"usa o Opus"* / *"Sonnet"* / *"Fable"* | Troca o modelo na hora e grava em `config.json`. Com `claude -p`, troca o modelo do Claude Code. |
| **"Humor em 30 por cento"** / *"mais humor"* / *"menos sarcasmo"* | Dial de personalidade estilo TARS, de 0 (relógio suíço) a 100. Fica salvo. |
| **"O que eu fiz na terça?"** / *"resumo de ontem"* / *"o que eu perguntei dia 28"* | Máquina do tempo: ele guarda um diário local (`history.jsonl`, fora do git) do que você perguntou, pesquisou e lembrou, e resume o dia. As memórias daquele dia viram fontes na galáxia. |
| Reator no canto superior esquerdo | Pulsa a cada palavra que ele fala; fica vermelho ouvindo, âmbar armado, pontilhado em mãos livres. Com a voz clonada, pulsa com o volume real. |

A linha pequena sob o nome mostra o modelo, o humor e se as mãos livres estão ligadas.

### No iPad ou iPhone, pelo Tailscale

O servidor continua no Mac; o iPad só abre a tela. Para o microfone funcionar no iPad o endereço precisa ser HTTPS, e o Tailscale (grátis para uso pessoal) resolve isso sem abrir nada para a internet: só aparelhos logados na **sua** conta alcançam o endereço.

1. Instale o Tailscale no Mac (App Store ou tailscale.com/download) e no iPad (App Store). Entre com a mesma conta nos dois e deixe ligado.
2. Uma vez só, em **login.tailscale.com/admin/dns**: ative **MagicDNS** e **HTTPS Certificates**.
3. No `config.json` do JARVIS acrescente a linha `"tailscale": true` e rode `python3 server.py`. O Terminal mostra algo como `No iPad/iPhone: https://meu-mac.tail1a2b.ts.net`. O JARVIS liga o `tailscale serve` sozinho; se não conseguir, diz o motivo.
4. No iPad, com o Tailscale ligado, abra esse endereço no **Safari**. Toque uma vez na tela e permita o microfone.

Vale fora de casa também (4G), desde que o Mac esteja ligado, online e com o `server.py` rodando. Não use o "Funnel" do Tailscale: ele abriria o JARVIS para a internet inteira. O 👂 (mãos livres) no Safari do iPad pode parar de ouvir sozinho mais cedo; o botão 🎙 funciona normalmente.

Sem Tailscale, dá para liberar outros nomes com `"allowed_hosts": ["meu-mac.local"]`, mas aí o endereço é `http://` e o microfone fica bloqueado no iPad.

### Precisam de conta: deixei preparado, você decide

**Voz clonada (ElevenLabs).** Em `config.json`, acrescente `elevenlabs_api_key` e `elevenlabs_voice_id` (o ID de uma voz da sua conta). O servidor passa a gerar o áudio e o navegador só toca: a chave não sai do servidor. Sem isso, vale a voz do sistema. *Não testei com uma chave real*, só contra um simulador: se o ElevenLabs mudar a API, o JARVIS cai de volta para a voz do sistema e avisa no console do navegador.

**Briefing da agenda ao abrir.** Em `config.json`, `briefing_command` com um comando do seu Mac que imprima o dia. Para o Calendário do macOS, sem login em nada: `brew install ical-buddy` e `"briefing_command": "icalBuddy -n -nc -ea -b '' eventsToday"`. O JARVIS lê a saída depois da saudação ("Na agenda de hoje: …"). Gmail precisaria de OAuth; não fiz.

**O que não fiz, de propósito:** controle do Mac por voz, leitura da tela e "mãos de agente" (mandar e-mail etc.). Dão para fazer, mas um agente com acesso ao seu Mac lendo notas arbitrárias precisa de uma conversa sobre o que ele pode e não pode tocar.

## config.json

| Campo | Padrão | Para quê |
|---|---|---|
| `api_key` | `PUT-YOUR-KEY-HERE` | Chave da API. Placeholder = tenta `claude -p`. Também lê `ANTHROPIC_API_KEY`. |
| `model` | `claude-opus-5-5` | Modelo da API. |
| `notes_dir` | `notes` | Pasta das notas (relativa a `jarvis/` ou absoluta). |
| `language` | `pt-BR` | `pt-BR` ou `en-GB`: idioma das respostas, da voz, do microfone e da saudação. `en-GB` é o mordomo original, que chama você de *sir*. |
| `backend` | `auto` | `auto`, `api` ou `cli`. |
| `effort` | `low` | Profundidade de raciocínio do modelo; `low` deixa a resposta falada rápida. |
| `port` | `4700` | Porta local. |
| `cli_model` | — | Modelo do `claude -p` (`sonnet`, `opus`…). Vazio = o padrão do seu Claude Code. |
| `claude_command` | — | Caminho completo do `claude`, se ele não for achado sozinho (aceita `~`). |
| `humor` | `70` | Dial de personalidade, 0–100. Também por voz: "humor em 30". |
| `elevenlabs_api_key`, `elevenlabs_voice_id` | — | Voz clonada. Opcional: `elevenlabs_model` (padrão `eleven_multilingual_v2`). |
| `briefing_command` | — | Comando local cuja saída vira o briefing falado ao abrir (ex.: `icalBuddy … eventsToday`). |
| `tailscale` | `false` | `true` aceita o nome `*.ts.net` deste Mac e liga o `tailscale serve` sozinho: JARVIS no iPad, com microfone. |
| `allowed_hosts` | — | Outros nomes aceitos no endereço (ex.: `["meu-mac.local"]`). Sem HTTPS, o iPad não libera o microfone. |

## Segurança e privacidade

- A chave fica só no servidor. Não aparece no navegador, no HTML nem em nenhum arquivo servido. O servidor entrega **apenas** a pasta `viewer/`.
- O servidor escuta só em `127.0.0.1` e recusa pedidos vindos de outros sites (checa `Host`, `Origin` e `Sec-Fetch-Site`). Com `"tailscale": true`, aceita também o nome `*.ts.net` do Mac, que só os aparelhos da sua conta Tailscale alcançam. Outra página aberta no navegador não consegue embutir `graph-data.js` para ler os trechos das notas (`Cross-Origin-Resource-Policy: same-origin`).
- `config.json`, `viewer/graph-data.js`, `notes/captures/` e `history.jsonl` estão no `.gitignore`. A chave, as suas notas e o diário não vão parar no GitHub por engano.
- Em mãos livres, o Chrome manda o áudio do microfone para o reconhecimento de voz do Google o tempo todo (é assim que o `webkitSpeechRecognition` funciona). Desligue o 👂 na sala de trauma.
- **A cada pergunta, as 6 notas mais relevantes são enviadas à API da Anthropic** (ou ao Claude Code). Não indexe notas com identificação de paciente.

## Problemas comuns

| Sintoma | Conserto |
|---|---|
| 🎙 não faz nada | Chrome ou Edge: cadeado na barra de endereço → Microfone → Permitir. Safari: ative o Ditado (Ajustes do Sistema → Teclado → Ditado). O reconhecimento de voz do Chrome precisa de internet. |
| Sem som | Clique uma vez na página: o navegador bloqueia áudio até o primeiro clique. Tecla Esc ou Shift não contam. |
| Página com cara de versão antiga | Recarga forçada: Cmd+Shift+R (Mac) ou Ctrl+Shift+R. |
| "model not configured" | Cole a chave em `config.json` (sem deixar o placeholder) ou instale o Claude Code. Se acabou de instalar, informe o caminho em `claude_command`. |
| Respostas genéricas ou "não está nas notas" | O caminho das notas está errado. Rode `python3 build.py /caminho/completo` e recarregue a página. |
| "sem acesso à pasta de notas" (Mac) | Ajustes do Sistema → Privacidade e Segurança → Arquivos e Pastas → libere o Terminal para Documentos, iCloud Drive etc. |
| `CERTIFICATE_VERIFY_FAILED` (Mac) | Python do python.org: rode *Install Certificates.command* na pasta do Python em Aplicativos. |
| "`claude -p` falhou … login" | Rode `claude` uma vez no terminal e faça login. |
| "Seu Claude Code não reconhece --tools" | Claude Code antigo: rode `claude update`. |
| "A galáxia mudou no servidor" | A lista de notas mudou (outro `build.py` ou servidor reiniciado). Recarregue a página. |
| "estourou o limite de tamanho (max_tokens)" | Tente de novo. Se repetir, baixe o `effort` em `config.json`. |
| Porta ocupada | Já tem um `server.py` rodando. Feche o outro ou troque `port` em `config.json`. |
| Qualquer outra coisa | Cole o erro exato no Claude Code e diga "conserta". |

## Testes

```bash
python3 -m unittest discover tests -v
```

São 32 testes, só biblioteca padrão; passam no Python 3.9 do Mac e no 3.11. Usam uma API falsa da Anthropic e um `claude` falso, então não gastam token. Cobrem:

- o formato da galáxia e pastas de notas problemáticas (BOM, cp1252, atalho quebrado, cabeçalho vazio, wikilink com pasta, siglas);
- o servidor entregando só `viewer/`, com as travas contra outros sites;
- a chave nunca saindo do servidor;
- o formato do pedido à API, resposta cortada, resposta quebrada e conexão interrompida;
- histórico, recusa e parâmetros que o modelo não aceita (e que voltam depois de corrigidos);
- `/remember`, títulos, ligações removidas e o `build.py` rodando com o servidor no ar;
- o caminho `claude -p`, inclusive com Claude Code antigo;
- pesquisa na web (API com `pause_turn` e busca básica; CLI com `--tools WebSearch`), troca de modelo, humor, diário, voz clonada e briefing.

## Arquivos

```
jarvis/
├── build.py          notas -> viewer/graph-data.js
├── server.py         servidor local: viewer/, /chat, /remember, /api/status
├── viewer/index.html galáxia, voz, painel, barra de pergunta
├── notes/            notas de exemplo (troque pelas suas com build.py)
└── tests/            bateria automatizada
```

## O que mudou em relação ao prompt pack

- **Modelo padrão** `claude-opus-5-5` em vez de `claude-opus-4-8`: mais novo e mais barato por token. O 4.8 continua funcionando se você trocar em `config.json`.
- **pt-BR por padrão**, porque o microfone precisa reconhecer a língua em que você fala. O mordomo britânico original está a um `"language": "en-GB"` de distância.
- **`config.json`** nasce na primeira execução e fica fora do git; o servidor relê a cada pergunta.
- **Fallback de recusa**: a API ativa sozinha um modelo alternativo se um filtro de segurança recusar a pergunta (parâmetro `fallbacks`).
- **`claude -p`** entra automaticamente quando não há chave.
