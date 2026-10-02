# JARVIS — segundo cérebro falante

Os 6 prompts do *Build Your Own JARVIS* (Zubair Trabzada · AI Workshop), executados:

1. **Galáxia** — `build.py` lê todas as notas `.md` e o `viewer/` mostra uma galáxia 3D: fundo estrelado, nós brilhando por pasta, deriva lenta quando ninguém mexe, clique voa até a nota, acende os vizinhos e abre o trecho.
2. **Cérebro** — `POST /chat`: pontua as notas por palavra-chave (título pesa mais), manda as 6 melhores ao Claude, que responde **só** com base nelas. Lembra a conversa por sessão.
3. **Voz** — fala as respostas (Web Speech API) e escuta pelo 🎙 (reconhecimento do Chrome).
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

Na primeira vez o servidor cria `config.json` e indexa as notas de exemplo de `notes/`: 26 notas tiradas do próprio app Ficha de Trauma (escores, protocolo, app, rotina).

### Ligar o cérebro — duas opções

**Com API key** (rápido): cole a chave em `config.json`, no campo `api_key`, e recarregue a página. Não precisa reiniciar o servidor. Nunca cole a chave num chat.

**Sem API key**: se o comando `claude` (Claude Code) existir no terminal, o JARVIS usa `claude -p` e roda na sua assinatura. É mais lento, uns 5–10 s por resposta, mas não cobra API. Basta deixar o `api_key` com o placeholder.

O terminal do servidor diz qual cérebro ligou.

Custo com API e `claude-opus-5-5`: algo entre US$ 0,01 e 0,05 por pergunta, conforme o tamanho das notas. É estimativa minha; confira o gasto real no console da Anthropic. Com `"model": "claude-haiku-4-5"` sai umas 4× mais barato.

### Usar as suas notas

```bash
python3 build.py ~/caminho/do/seu/vault    # Obsidian, export do Notion, qualquer pasta com .md
python3 server.py
```

O caminho fica gravado em `config.json`. O servidor reconstrói a galáxia toda vez que sobe.

Regras de indexação:

- **Grupo e cor**: cada pasta vira um grupo com cor própria.
- **Ligações**: duas notas se ligam quando uma cita o título da outra no texto, ou quando as duas apontam para o mesmo `[[alvo]]` que não tem nota própria.
- **Pastas ignoradas**: `.obsidian`, `.trash` e as ocultas.

## Roteiro de teste (voz nos dois sentidos)

1. Abra no Chrome e clique em qualquer lugar. Deve ouvir: *"Boa noite, senhor. 26 notas indexadas, todas presentes e contabilizadas."*
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

## Segurança e privacidade

- A chave fica só no servidor. Não aparece no navegador, no HTML nem em nenhum arquivo servido. O servidor entrega **apenas** a pasta `viewer/`.
- O servidor escuta só em `127.0.0.1` e recusa pedidos vindos de outros sites (checa `Host` e `Origin`).
- `config.json`, `viewer/graph-data.js` e `notes/captures/` estão no `.gitignore`. A chave e as suas notas não vão parar no GitHub por engano.
- **A cada pergunta, as 6 notas mais relevantes são enviadas à API da Anthropic** (ou ao Claude Code). Não indexe notas com identificação de paciente.

## Problemas comuns

| Sintoma | Conserto |
|---|---|
| 🎙 não faz nada | Chrome → cadeado na barra de endereço → Microfone → Permitir. Tem que ser Chrome ou Edge, e o reconhecimento precisa de internet. |
| Sem som | Clique uma vez na página: o navegador bloqueia áudio até o primeiro clique. |
| Página com cara de versão antiga | Recarga forçada: Cmd+Shift+R (Mac) ou Ctrl+Shift+R. |
| "model not configured" | Cole a chave em `config.json` (sem deixar o placeholder) ou instale o Claude Code. |
| Respostas genéricas ou "não está nas notas" | O caminho das notas está errado. Rode `python3 build.py /caminho/completo` de novo. |
| `CERTIFICATE_VERIFY_FAILED` (Mac) | Python do python.org: rode *Install Certificates.command* na pasta do Python em Aplicativos. |
| "`claude -p` falhou … login" | Rode `claude` uma vez no terminal e faça login. |
| "A galáxia mudou no servidor" | O servidor reiniciou com outra lista de notas. Recarregue a página. |
| Porta ocupada | Já tem um `server.py` rodando. Feche o outro ou troque `port` em `config.json`. |
| Qualquer outra coisa | Cole o erro exato no Claude Code e diga "conserta". |

## Testes

```bash
python3 -m unittest discover tests -v
```

São 15 testes, só biblioteca padrão. Usam uma API falsa da Anthropic e um `claude` falso, então não gastam token. Cobrem:

- o formato da galáxia;
- o servidor entregando só `viewer/`;
- a chave nunca saindo do servidor;
- o formato do pedido à API;
- histórico, recusa e parâmetros que o modelo não aceita;
- `/remember` e o caminho `claude -p` (versões nova e antiga).

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
