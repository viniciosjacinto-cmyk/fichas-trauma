#!/bin/bash
# JARVIS · instalar.sh — instala (ou atualiza) o JARVIS no Mac com um comando só.
#
#   curl -fsSL https://raw.githubusercontent.com/viniciosjacinto-cmyk/fichas-trauma/claude/new-session-p67tuw/jarvis/instalar.sh | bash
#
# O que faz: baixa o projeto para ~/JARVIS, mantém seu config.json e suas memórias se já
# existirem, deixa o servidor ligando sozinho junto com o Mac (launchd), espera ele subir e
# abre o Chrome. Com --ipad, liga o Tailscale para abrir no iPad.
#
# Opções:  --ipad   --sem-ipad   --sem-inicio-automatico   --desinstalar
# Variáveis: JARVIS_DIR (padrão ~/JARVIS) · JARVIS_BRANCH (padrão claude/new-session-p67tuw)

set -eo pipefail   # o -u entra depois de ler os argumentos: no bash 3.2 do Mac, "$@" vazio com -u pode dar "unbound variable"

REPO="viniciosjacinto-cmyk/fichas-trauma"
BRANCH="${JARVIS_BRANCH:-claude/new-session-p67tuw}"
DEST="${JARVIS_DIR:-$HOME/JARVIS}"
LABEL="com.jarvis.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
IPAD="auto"; AUTOSTART=1; UNINSTALL=0
for arg in ${1+"$@"}; do
  case "$arg" in
    --ipad) IPAD=1 ;;
    --sem-ipad) IPAD=0 ;;
    --sem-inicio-automatico) AUTOSTART=0 ;;
    --desinstalar) UNINSTALL=1 ;;
    *) echo "Opção desconhecida: $arg"; exit 2 ;;
  esac
done
set -u
[ "${JARVIS_NO_LAUNCHD:-0}" = "1" ] && AUTOSTART=0   # testes fora do Mac
MAC=0; [ "$(uname)" = "Darwin" ] && MAC=1

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; echo "Me mande uma foto desta tela."; exit 1; }

echo "JARVIS · instalador"
if [ $MAC = 1 ] && ! command -v launchctl >/dev/null 2>&1; then   # a-Shell e afins no iPad
  die "Isto roda no Mac, não no iPad. No iPad você só abre o endereço do Tailscale no Safari."
fi

say "Conferindo o Python"
if ! python3 -c 'import sys; assert sys.version_info >= (3, 7)' 2>/dev/null; then
  if [ $MAC = 1 ]; then
    xcode-select --install 2>/dev/null || true
    die "O Mac vai pedir para instalar as 'ferramentas de linha de comando'. Clique em Instalar, espere terminar e rode este comando de novo."
  fi
  die "Preciso do Python 3.7 ou mais novo."
fi

config_port() {   # porta gravada no config.json (4700 se não houver)
  python3 -c 'import json, sys
try: print(int(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("port") or 4700))
except Exception: print(4700)' "$DEST/config.json" 2>/dev/null || echo 4700
}
PORT="${JARVIS_PORT:-$(config_port)}"

stop_server() {
  if [ $MAC = 1 ] && [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do   # espera o launchd soltar o serviço
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
      sleep 0.5
    done
  fi
  if [ -f "$DEST/jarvis.pid" ]; then          # servidor ligado por este instalador sem launchd
    pid="$(cat "$DEST/jarvis.pid" 2>/dev/null || true)"
    [ -n "$pid" ] && ps -o command= -p "$pid" 2>/dev/null | grep -q "server.py" && kill "$pid" 2>/dev/null || true
    rm -f "$DEST/jarvis.pid"
  fi
  if command -v lsof >/dev/null 2>&1; then   # servidor aberto à mão num Terminal antigo
    for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do
      ps -o command= -p "$pid" 2>/dev/null | grep -q "server.py" && kill "$pid" 2>/dev/null || true
    done
  fi
}

if [ $UNINSTALL = 1 ]; then
  say "Desligando o JARVIS"
  stop_server
  rm -f "$PLIST"
  echo "Servidor parado e início automático removido. Seus arquivos continuam em $DEST (apague a pasta se quiser)."
  exit 0
fi

say "Baixando o JARVIS ($BRANCH)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
download() { curl -fsL -o "$TMP/jarvis.zip" "https://github.com/$REPO/archive/refs/heads/$1.zip" 2>/dev/null; }
if ! download "$BRANCH"; then
  if [ "$BRANCH" != "main" ] && download main; then   # branch apagado depois do merge
    echo "O branch $BRANCH não existe mais; usando a main."; BRANCH=main
  else
    die "Não consegui baixar de github.com. Está com internet?"
  fi
fi
python3 - "$TMP" <<'EOF'
import sys, zipfile, pathlib
tmp = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(tmp / "jarvis.zip") as z:
    z.extractall(tmp)
src = [p / "jarvis" for p in tmp.iterdir() if p.is_dir() and (p / "jarvis" / "server.py").exists()]
if not src:
    sys.exit("✗ O ZIP baixado não tem a pasta jarvis/ (branch errado?). Rode com JARVIS_BRANCH=<branch>.")
(tmp / "SRC").write_text(str(src[0]))
EOF
SRC="$(cat "$TMP/SRC")"

say "Instalando em $DEST"
stop_server
mkdir -p "$DEST"
# copia o programa por cima; config.json, history.jsonl e notes/captures não vêm no ZIP, então ficam como estão
cp -R "$SRC/." "$DEST/"
chmod +x "$DEST/instalar.sh" 2>/dev/null || true

say "Ajustando o config.json"
python3 - "$DEST" "$IPAD" "$PORT" <<'EOF'
import json, os, shutil, sys, pathlib
dest, ipad, port = pathlib.Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
sys.path.insert(0, str(dest))
import build
cfg = dict(build.DEFAULT_CONFIG)
if build.CONFIG.exists():
    try:
        cfg.update(json.loads(build.CONFIG.read_text(encoding="utf-8-sig")))
    except ValueError:
        shutil.copy(build.CONFIG, build.CONFIG.with_suffix(".json.quebrado"))
        print("config.json estava inválido; guardei uma cópia como config.json.quebrado e recomecei dos padrões")
has_ts = os.path.exists("/Applications/Tailscale.app") or shutil.which("tailscale") is not None
if ipad == "1" or (ipad == "auto" and has_ts):
    cfg["tailscale"] = True
elif ipad == "0":
    cfg.pop("tailscale", None)
cfg["port"] = port
build.save_config(cfg)
print("iPad pelo Tailscale:", "ligado" if cfg.get("tailscale") else "desligado (rode de novo com --ipad depois de instalar o Tailscale)")
if cfg.get("api_key") not in (None, "", build.PLACEHOLDER_KEY):
    print("Cérebro: API key colada")
elif shutil.which("claude") or any(os.path.exists(os.path.expanduser(p)) for p in build.CLAUDE_PLACES):
    print("Cérebro: Claude Code (claude -p)")
else:
    print("Cérebro: NENHUM ainda. Instale o Claude Code com  curl -fsSL https://claude.ai/install.sh | bash  e rode `claude` para entrar; ou cole a API key em config.json.")
EOF

PY="$(command -v python3)"
EXTRA_PATH=""
for tool in claude node; do   # onde o Terminal acha `claude` e `node` (nvm, Volta…): o launchd não herda esse PATH
  d="$(dirname "$(command -v "$tool" 2>/dev/null || echo /x/x)")"
  case ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.claude/local$EXTRA_PATH:" in
    *":$d:"*|*":/x:"*) ;;
    *) EXTRA_PATH="$EXTRA_PATH:$d" ;;
  esac
done
if [ $AUTOSTART = 1 ] && [ $MAC = 1 ]; then
  say "Deixando o JARVIS ligar sozinho junto com o Mac"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DEST/server.py</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/jarvis.log</string>
  <key>StandardErrorPath</key><string>$DEST/jarvis.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.claude/local$EXTRA_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>PYTHONIOENCODING</key><string>utf-8</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
  </dict>
</dict></plist>
EOF
  : > "$DEST/jarvis.log"
  launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null \
    || die "O launchd não aceitou o registro. Rode de novo com --sem-inicio-automatico (o JARVIS liga, só não volta sozinho depois de reiniciar)."
else
  [ $MAC = 1 ] && rm -f "$PLIST"   # pediu sem início automático: não voltar no próximo boot
  say "Ligando o servidor"
  # solto de verdade: sem herdar a saída deste script (senão um `| tee` ficaria preso ao servidor)
  nohup bash -c "cd '$DEST' && exec '$PY' server.py" > "$DEST/jarvis.log" 2>&1 < /dev/null &
  echo $! > "$DEST/jarvis.pid"
  disown 2>/dev/null || true
fi

say "Esperando o JARVIS subir"
STATUS=""
for _ in $(seq 1 40); do
  STATUS="$(curl -s --noproxy '*' "http://localhost:$PORT/api/status" 2>/dev/null || true)"
  [ -n "$STATUS" ] && break
  sleep 0.5
done
[ -n "$STATUS" ] || { echo; cat "$DEST/jarvis.log" 2>/dev/null | tail -20; die "O servidor não respondeu. O que apareceu acima é o motivo; me mande esse texto."; }

printf '%s' "$STATUS" | python3 -c '
import json, sys
s = json.load(sys.stdin)
brains = {"api": "API da Anthropic", "cli": "Claude Code (claude -p)", "none": "NENHUM — cole a API key em config.json ou instale o Claude Code"}
brain, notes, remote = brains.get(s.get("brain"), s.get("brain")), s.get("notes"), s.get("remote_url")
print("\n✓ JARVIS no ar: %s notas · cérebro: %s" % (notes, brain))
if remote: print("✓ No iPad/iPhone (Safari, com o Tailscale ligado): %s" % remote)
'
grep -h "Tailscale:" "$DEST/jarvis.log" 2>/dev/null | tail -1 | sed 's/^/! /' || true

echo
echo "Abra no Chrome: http://localhost:$PORT"
echo "Pasta: $DEST · registro: $DEST/jarvis.log · desligar: bash $DEST/instalar.sh --desinstalar"
if [ $MAC = 1 ] && command -v open >/dev/null 2>&1; then
  open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT" || true
fi
