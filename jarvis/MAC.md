# JARVIS no Mac: roteiro para o Claude Code local

Este arquivo é para uma sessão do Claude Code rodando **no Mac do Marcos** (app Claude Desktop, aba Code, ou `claude` no Terminal). A sessão na nuvem que construiu o JARVIS não alcança o Mac: você é as mãos dela. O Marcos é médico, não programador: fale em português simples, uma coisa por vez, e não peça para ele colar comandos nem chaves no chat. Faça você.

## O que é

JARVIS é a galáxia 3D das notas dele, com voz e um cérebro Claude. O código está em `jarvis/` no repositório `viniciosjacinto-cmyk/fichas-trauma`, branch `claude/new-session-p67tuw` (PR #1). Instalado, fica em `~/JARVIS`. O servidor roda em http://localhost:4700 e escuta só em `127.0.0.1`. O README completo fica em `~/JARVIS/README.md`.

## Passo 1: instalar ou atualizar

```bash
curl -fsSL https://raw.githubusercontent.com/viniciosjacinto-cmyk/fichas-trauma/claude/new-session-p67tuw/jarvis/instalar.sh | bash
```

Sucesso é a linha `✓ JARVIS no ar: N notas · cérebro: …` e o Chrome abrindo. Se o branch já não existir, troque `claude/new-session-p67tuw` por `main` no endereço. Se falhar, leia a saída inteira e o fim de `~/JARVIS/jarvis.log` antes de agir.

| Sintoma | Conserto |
|---|---|
| "xcode-select", "ferramentas de linha de comando" ou `python3` não encontrado | O Mac abriu um diálogo pedindo para instalar as Command Line Tools. Peça para ele clicar em Instalar e espere `xcode-select -p` responder. Rode o instalador de novo. Com Homebrew, `brew install python` também serve. |
| "O servidor não respondeu" | Leia o fim de `~/JARVIS/jarvis.log`. `Address already in use`: veja quem escuta com `lsof -nP -iTCP:4700 -sTCP:LISTEN`; se for outro `server.py`, encerre; senão troque `port` em `~/JARVIS/config.json` e rode o instalador de novo. Traceback de Python: conserte só se for ambiente (permissão, caminho, Python antigo). Se for bug do código, não edite `~/JARVIS`: copie o traceback inteiro para o Marcos mandar à sessão na nuvem. |
| "O launchd não aceitou o registro" | `launchctl print gui/$(id -u)/com.jarvis.server` mostra o estado. `launchctl bootout gui/$(id -u)/com.jarvis.server` e rode o instalador de novo. Se insistir, use `… \| bash -s -- --sem-inicio-automatico`: liga agora, só não volta sozinho depois de reiniciar. |
| `cérebro: NENHUM` ou "model not configured" na página | Nem `claude` nem API key. Se o Claude Code não está instalado, instale com `curl -fsSL https://claude.ai/install.sh \| bash`, rode `claude` uma vez para entrar com a conta dele e rode o instalador do JARVIS de novo. Se está instalado mas fora do PATH, `which claude` e grave o caminho em `claude_command` no `config.json`. Se o Marcos tiver uma API key, abra o arquivo para ele com `open -e ~/JARVIS/config.json` e peça para colar a chave ali, no lugar de `PUT-YOUR-KEY-HERE`. Nunca no chat. Depois reinicie: `launchctl kickstart -k gui/$(id -u)/com.jarvis.server`. |
| "`claude -p` falhou … login" | Rode `claude` no Terminal e faça o login. |
| "Seu Claude Code não reconhece --tools" | `claude update`. |
| Microfone não faz nada no Chrome | Cadeado na barra de endereço, Microfone, Permitir. O reconhecimento de voz precisa de internet. |
| Sem som | Clicar uma vez na página libera o áudio. |
| "sem acesso à pasta de notas" | Ajustes do Sistema, Privacidade e Segurança, Arquivos e Pastas: libere o Terminal (ou python3) para a pasta. Ou mantenha as notas em `~/JARVIS/notes`. |

## Passo 2: conferir

```bash
curl -s http://localhost:4700/api/status
```

Deve voltar um JSON com `notes` e `brain` (`api` ou `cli`; `none` significa sem cérebro). Abra http://localhost:4700 no Chrome, clique uma vez na página e peça para ele digitar ou falar: "Jarvis, quantas notas eu tenho?".

## Passo 3: as notas dele

Por padrão o JARVIS lê `~/JARVIS/notes`, 26 notas de exemplo tiradas do app Ficha de Trauma. Para apontar para as notas reais (uma pasta de arquivos `.md`, Obsidian por exemplo):

```bash
cd ~/JARVIS && python3 build.py "/caminho/completo/da/pasta"
```

Isso grava `notes_dir` no `config.json` e reconstrói a galáxia. Recarregue a página. Nada com dado identificável de paciente.

## Passo 4: iPad, pelo Tailscale

1. App Tailscale no Mac (App Store ou tailscale.com/download) e no iPad, com a mesma conta nos dois. Confira: `/Applications/Tailscale.app/Contents/MacOS/Tailscale status`.
2. Em https://login.tailscale.com/admin/dns ligar **MagicDNS** e **HTTPS Certificates**. Só o Marcos consegue: abra o link para ele.
3. Rode o instalador com `--ipad`:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/viniciosjacinto-cmyk/fichas-trauma/claude/new-session-p67tuw/jarvis/instalar.sh | bash -s -- --ipad
   ```

   Ele imprime `✓ No iPad/iPhone: https://<mac>.<tailnet>.ts.net`. Confira com `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status`.
4. No iPad, com o Tailscale ligado, abra esse endereço no Safari e permita o microfone na primeira vez.

Erros: "HTTPS is not enabled" é o passo 2; "Logged out" é abrir o app e entrar; endereço que não abre no iPad é Tailscale desligado ou conta diferente no iPad. Nunca use `tailscale funnel`: ele expõe o JARVIS à internet. O servidor deve continuar só em `127.0.0.1`.

## Regras

- Não edite o código em `~/JARVIS` (`server.py`, `build.py`, `viewer/`). Bug de código se relata; só `config.json` e ambiente se mexem.
- Nunca peça chave de API no chat e nunca grave chave em arquivo que vá para o git.
- Nenhuma nota com dado identificável de paciente.
- Ao terminar, diga ao Marcos em uma linha o que funciona e o que falta.
