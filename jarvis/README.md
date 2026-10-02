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

Abre só no próprio computador. iPad e iPhone na mesma rede não acessam: o servidor só aceita `localhost`, e o microfone do navegador só funciona em `localhost` ou HTTPS.

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

## Segurança e privacidade

- A chave fica só no servidor. Não aparece no navegador, no HTML nem em nenhum arquivo servido. O servidor entrega **apenas** a pasta `viewer/`.
- O servidor escuta só em `127.0.0.1` e recusa pedidos vindos de outros sites (checa `Host`, `Origin` e `Sec-Fetch-Site`). Outra página aberta no navegador não consegue embutir `graph-data.js` para ler os trechos das notas (`Cross-Origin-Resource-Policy: same-origin`).
- `config.json`, `viewer/graph-data.js` e `notes/captures/` estão no `.gitignore`. A chave e as suas notas não vão parar no GitHub por engano.
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

São 24 testes, só biblioteca padrão; passam no Python 3.9 do Mac e no 3.11. Usam uma API falsa da Anthropic e um `claude` falso, então não gastam token. Cobrem:

- o formato da galáxia e pastas de notas problemáticas (BOM, cp1252, atalho quebrado, cabeçalho vazio, wikilink com pasta, siglas);
- o servidor entregando só `viewer/`, com as travas contra outros sites;
- a chave nunca saindo do servidor;
- o formato do pedido à API, resposta cortada, resposta quebrada e conexão interrompida;
- histórico, recusa e parâmetros que o modelo não aceita (e que voltam depois de corrigidos);
- `/remember`, títulos, ligações removidas e o `build.py` rodando com o servidor no ar;
- o caminho `claude -p`, inclusive com Claude Code antigo.

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
