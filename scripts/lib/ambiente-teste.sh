# Ambiente de teste isolado, usado pelos scripts testar-*.sh (carregue com "source").
#
# Sobe um Jatobá SEPARADO (projeto Docker "jatoba-teste", banco próprio, porta 18080,
# pasta temporária), com senhas descartáveis. Não lê nem altera o seu .env,
# o seu banco ou a sua pasta backups/. Tudo é apagado no fim.
#
# Para testar outra arquitetura (emulada): DOCKER_DEFAULT_PLATFORM=linux/arm64 bash scripts/testar-....sh
# Sob emulação tudo fica bem mais lento; JATOBA_TESTE_ESPERA é o limite, em segundos, para o app subir.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash no Windows: não converter /backups em C:/...

win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
ROOT="$(win "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)")"
TMP="$(win "$(mktemp -d)")"
PORT=18080
URL="http://localhost:$PORT"
PASS=0

ESPERA="${JATOBA_TESTE_ESPERA:-120}"

# A imagem de teste tem etiqueta própria, para nunca substituir a da sua instalação.
cat > "$TMP/compose.teste.yaml" <<EOF
services:
  app:
    image: jatoba-finance:teste
    env_file: !override
      - $(win "$TMP/teste.env")
    ports: !override
      - "127.0.0.1:$PORT:8080"
    volumes: !override
      - $(win "$TMP/backups"):/backups
EOF
mkdir -p "$TMP/backups"
chmod 777 "$TMP/backups" # no Linux, o contêiner grava como o usuário node (1000)

dc() { docker compose --project-name jatoba-teste --project-directory "$ROOT" -f "$ROOT/compose.yaml" -f "$TMP/compose.teste.yaml" --env-file "$TMP/teste.env" "$@"; }
sql() { dc exec -T postgres psql -U jatoba -d jatoba -tAc "$1"; }
ok() { PASS=$((PASS + 1)); echo "  ok  $1"; }
fail() {
  echo "  FALHOU  $1" >&2
  # No GitHub Actions, vira uma anotação visível na página da execução (e pela API pública).
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=$(basename "$0")::$(echo "$1" | tr '\n' ' ' | cut -c1-500) | app: $(dc logs --no-log-prefix app 2>&1 | tail -3 | tr '\n' ' ' | cut -c1-400)"
  fi
  echo "--- contêineres ---" >&2; dc ps -a --format '{{.Service}} {{.Status}} {{.Ports}}' >&2 2>&1
  echo "--- $URL/health ---" >&2; curl -sS -m 5 "$URL/health" >&2 2>&1; echo >&2
  echo "--- log do app ---" >&2; dc logs --no-log-prefix app 2>&1 | tail -30 >&2
  exit 1
}
check() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (esperado: '$3', veio: '$2')"; fi; }
# Espera o /health responder 200, o que só acontece com o banco ok.
wait_healthy() {
  local until=$((SECONDS + ESPERA))
  while [ "$SECONDS" -lt "$until" ]; do
    curl -sf "$URL/health" > /dev/null && return 0
    sleep 2
  done
  fail "app não respondeu /health em ${ESPERA}s"
}
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== Preparação"
cat > "$TMP/teste.env" <<EOF2
JATOBA_ADMIN_USER=teste
JATOBA_ADMIN_PASSWORD=senha-descartavel-$RANDOM-$RANDOM
POSTGRES_PASSWORD=teste$RANDOM$RANDOM
EOF2
dc build --quiet app
# Em outra arquitetura, a imagem do Postgres desta máquina pode não servir; baixa a certa.
if [ -n "${DOCKER_DEFAULT_PLATFORM:-}" ]; then dc pull --quiet postgres; fi
