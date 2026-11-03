#!/usr/bin/env bash
# Teste de ponta a ponta do backup e da restauração.
#
# Sobe um Jatobá SEPARADO (projeto Docker "jatoba-teste", banco próprio, porta 18080,
# pasta temporária), com chave e senhas descartáveis. Não lê nem altera o seu .env,
# o seu banco ou a sua pasta backups/. Tudo é apagado no fim.
#
# Uso, na raiz do repositório: bash scripts/testar-backup.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash no Windows: não converter /backups em C:/...

win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
ROOT="$(win "$(cd "$(dirname "$0")/.." && pwd)")"
TMP="$(win "$(mktemp -d)")"
PORT=18080
URL="http://localhost:$PORT"
PASS=0

cat > "$TMP/compose.teste.yaml" <<EOF
services:
  app:
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
fail() { echo "  FALHOU  $1" >&2; echo "--- log do app ---" >&2; dc logs --no-log-prefix app 2>&1 | tail -30 >&2; exit 1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (esperado: '$3', veio: '$2')"; fi; }
wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' jatoba-teste-app-1 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  fail "app não ficou saudável"
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
KEYS="$(dc run --rm --no-deps -T app jatoba keygen)"
PUBLIC="$(echo "$KEYS" | grep -o 'age1[0-9a-z]*' | head -1)"
echo "$KEYS" | grep -o 'AGE-SECRET-KEY-[0-9A-Z]*' > "$TMP/chave.txt"
[ -n "$PUBLIC" ] && [ -s "$TMP/chave.txt" ] && ok "keygen gera chave pública e privada" || fail "keygen"
dc run --rm --no-deps -T app jatoba keygen | grep -o 'AGE-SECRET-KEY-[0-9A-Z]*' > "$TMP/chave-errada.txt"

echo "JATOBA_BACKUP_RECIPIENT=$PUBLIC" >> "$TMP/teste.env"

dc up -d >/dev/null 2>&1
wait_healthy
ok "Jatobá de teste no ar"

echo "== Backup"
sql "create table marcador (valor text); insert into marcador values ('original');" >/dev/null
# Volume suficiente para o age gravar vários blocos de 64 KB (testa corrupção no meio do arquivo).
sql "create table volume as select g as id, md5(g::text) as texto from generate_series(1, 40000) g;" >/dev/null
OUT="$(dc exec -T app jatoba backup)"
FILE="$(echo "$OUT" | grep -o 'jatoba-[0-9-]*-manual\.sql\.age')"
[ -f "$TMP/backups/$FILE" ] && ok "backup criado: $FILE" || fail "backup não apareceu na pasta"
check "arquivo está criptografado (cabeçalho do age)" "$(head -c 21 "$TMP/backups/$FILE")" "age-encryption.org/v1"
if grep -q "original" "$TMP/backups/$FILE"; then fail "dados legíveis dentro do backup"; else ok "dados não aparecem em texto no arquivo"; fi
dc exec -T app jatoba list | grep -q "$FILE" && ok "list mostra o backup" || fail "list"

echo "== Mudanças depois do backup"
sql "update marcador set valor = 'alterado'; create table criada_depois (id int);" >/dev/null
check "dado alterado" "$(sql "select valor from marcador")" "alterado"

echo "== Restauração recusada"
set +e
dc exec -T app jatoba restore "$FILE" < "$TMP/chave.txt" >/dev/null 2>&1; CODE=$?
set -e
check "sem --confirmar, não restaura (código 2)" "$CODE" "2"
check "dados intactos" "$(sql "select valor from marcador")" "alterado"

set +e
dc exec -T app jatoba restore "$FILE" --confirmar < "$TMP/chave-errada.txt" > "$TMP/saida.txt" 2>&1; CODE=$?
set -e
check "chave errada falha (código 1)" "$CODE" "1"
grep -q "chave privada" "$TMP/saida.txt" && ok "mensagem explica a chave errada" || fail "mensagem da chave errada: $(cat "$TMP/saida.txt")"
check "dados intactos depois da chave errada" "$(sql "select valor from marcador")" "alterado"

cp "$TMP/backups/$FILE" "$TMP/backups/jatoba-20000101-000000-corrompido.sql.age"
SIZE=$(wc -c < "$TMP/backups/$FILE")
[ "$SIZE" -gt 500000 ] && ok "backup grande o bastante para vários blocos ($SIZE bytes)" || fail "backup pequeno demais: $SIZE"
printf 'X' | dd of="$TMP/backups/jatoba-20000101-000000-corrompido.sql.age" bs=1 seek=$((SIZE - 200)) conv=notrunc 2>/dev/null
set +e
dc exec -T app jatoba restore jatoba-20000101-000000-corrompido.sql.age --confirmar < "$TMP/chave.txt" >/dev/null 2>&1; CODE=$?
set -e
check "arquivo corrompido falha" "$CODE" "1"
check "dados intactos depois do arquivo corrompido" "$(sql "select valor from marcador")" "alterado"
check "tabela criada depois do backup continua lá" "$(sql "select to_regclass('public.criada_depois') is not null")" "t"
rm "$TMP/backups/jatoba-20000101-000000-corrompido.sql.age"

echo "== Restauração"
OUT="$(dc exec -T app jatoba restore "$FILE" --confirmar < "$TMP/chave.txt")"
check "dado voltou ao do backup" "$(sql "select valor from marcador")" "original"
check "tabela grande restaurada inteira" "$(sql "select count(*) from volume")" "40000"
check "tabela criada depois do backup sumiu" "$(sql "select to_regclass('public.criada_depois') is null")" "t"
echo "$OUT" | grep -q "antes-restauracao" && ok "backup de segurança feito antes de restaurar" || fail "sem backup de segurança"

dc restart app >/dev/null 2>&1
wait_healthy
ok "app reinicia saudável depois da restauração"
check "/health com o banco" "$(curl -s "$URL/health" | grep -o '"database":"ok"')" '"database":"ok"'

echo "== Backup de segurança restaurável"
SAFETY="$(ls "$TMP/backups" | grep antes-restauracao | head -1)"
dc exec -T app jatoba restore "$SAFETY" --confirmar < "$TMP/chave.txt" >/dev/null
check "backup de segurança tem o estado de antes" "$(sql "select valor from marcador")" "alterado"

echo "== Backup automático antes de migração"
sql "drop table sessions; delete from schema_migrations where id = '0001_sessions';" >/dev/null
dc restart app >/dev/null 2>&1
wait_healthy
dc logs --no-log-prefix app | grep -q "Backup antes das migrações" && ok "backup automático feito na partida" || fail "sem backup automático"
check "migração reaplicada" "$(sql "select count(*) from schema_migrations where id = '0001_sessions'")" "1"
ls "$TMP/backups" | grep -q antes-migracao && ok "arquivo antes-migracao na pasta" || fail "arquivo antes-migracao"

echo
echo "Todos os $PASS testes de backup passaram."
