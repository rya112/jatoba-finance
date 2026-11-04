#!/usr/bin/env bash
# Gera as capturas de tela do README (docs/img/tela-*.png) com DADOS FICTÍCIOS.
#
# Sobe um Jatobá isolado (scripts/lib/ambiente-teste.sh), importa os extratos de exemplo de
# packages/core/test/fixtures, cria regras e metas de exemplo, salva cada página e fotografa com
# um navegador sem janela (Edge ou Chrome/Chromium). Nunca usa a sua instalação nem os seus dados.
#
# Uso, na raiz do repositório: bash scripts/gerar-capturas.sh
# Navegador: detectado sozinho; para escolher, NAVEGADOR=/caminho/do/chrome bash scripts/gerar-capturas.sh
source "$(dirname "$0")/lib/ambiente-teste.sh"

# ---------- navegador ----------
NAV="${NAVEGADOR:-}"
for candidate in \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "$(command -v chromium 2>/dev/null)" "$(command -v chromium-browser 2>/dev/null)" "$(command -v google-chrome 2>/dev/null)"; do
  [ -z "$NAV" ] && [ -n "$candidate" ] && [ -x "$candidate" ] && NAV="$candidate"
done
[ -n "$NAV" ] || fail "nenhum navegador encontrado (Edge, Chrome ou Chromium); use NAVEGADOR=/caminho"
ok "navegador: $(basename "$NAV")"

OUT="$ROOT/docs/img"
FIX="$ROOT/packages/core/test/fixtures"
JAR="$TMP/cookies.txt"
PAGES="$TMP/paginas"
mkdir -p "$PAGES"

# ---------- Jatobá de demonstração ----------
KEYS="$(dc run --rm --no-deps -T app jatoba keygen)"
echo "JATOBA_BACKUP_RECIPIENT=$(echo "$KEYS" | grep -o 'age1[0-9a-z]*' | head -1)" >> "$TMP/teste.env"
dc up -d >/dev/null 2>&1
wait_healthy
dc exec -T app jatoba backup >/dev/null
ok "Jatobá de demonstração no ar"

USER_="$(grep '^JATOBA_ADMIN_USER=' "$TMP/teste.env" | cut -d= -f2)"
PASS_="$(grep '^JATOBA_ADMIN_PASSWORD=' "$TMP/teste.env" | cut -d= -f2)"
curl -s -c "$JAR" -o "$TMP/descarte" -H "Origin: $URL" --data-urlencode "usuario=$USER_" --data-urlencode "senha=$PASS_" "$URL/entrar"
form() { curl -s -b "$JAR" -H "Origin: $URL" -o "$TMP/descarte" --data "$2" "$URL$1"; }
# Campos com acento: cada valor vai por arquivo (no Windows, texto com acento na linha de comando
# chega ao curl com a codificação errada; lido de arquivo, os bytes UTF-8 chegam intactos).
formu() {
  local path="$1"; shift
  local args=() n=0
  for field in "$@"; do
    n=$((n + 1))
    printf '%s' "${field#*=}" > "$TMP/campo-$n"
    args+=(--data-urlencode "${field%%=*}@$(win "$TMP/campo-$n")")
  done
  curl -s -b "$JAR" -H "Origin: $URL" -o "$TMP/descarte" "${args[@]}" "$URL$path"
}
send() { curl -s -b "$JAR" -H "Origin: $URL" -o "$1" -F "arquivo=@$2" "$URL/importar"; }
cat_id() { sql "select id from categories where name = '$1'"; }

for f in banco-exemplo-corrente.ofx cartao-exemplo.ofx sgml-1252-conta-e-cartao.ofx; do send "$TMP/descarte" "$FIX/$f"; done
send "$PAGES/importar.html" "$FIX/c6-fatura-exemplo.csv"   # a página de Importar mostra o resumo desta
ok "extratos fictícios importados"

for regra in "ENERGIA EXEMPLO|Contas da casa" "SUPERMERCADO EXEMPLO|Mercado" "RESTAURANTE EXEMPLO|Restaurantes e delivery" \
             "POSTO EXEMPLO|Transporte" "STREAMING EXEMPLO|Assinaturas" "TITULAR EXEMPLO|Transferência entre contas" \
             "ALUGUEL OUTUBRO|Moradia" "FARMACIA EXEMPLO|Saúde"; do
  form /ajustes/regras "texto=${regra%%|*}&direcao=&conta=&categoria=$(cat_id "${regra##*|}")"
done
for conta in "Conta final 0000|Conta corrente (exemplo)" "Cartão final 0000|Cartão de crédito (exemplo)" "Conta final 9999|Conta antiga (exemplo)"; do
  id="$(sql "select id from accounts where name = '${conta%%|*}' limit 1")"
  [ -n "$id" ] && formu "/ajustes/contas/$id" "nome=${conta##*|}"
done
# Aprova a maior parte, deixando alguns para a Revisar ter o que mostrar.
IDS="$(sql "select string_agg('id=' || id || '&sugestao_' || id || '=' || category_id || '&categoria_' || id || '=' || category_id, '&') from (select id, category_id from transactions where category_id is not null and not reviewed order by id offset 4) x")"
[ -n "$IDS" ] && form /revisar/lote "$IDS&acao=todos"
ok "regras, contas e revisão de exemplo"

formu /metas "nome=Viagem ao Chile" "alvo=10000" "prazo=2027-12" "guardado=3000"
formu /metas "nome=Reserva de emergência" "alvo=30000" "prazo=" "guardado=12000"
VIAGEM="$(sql "select id from goals where name = 'Viagem ao Chile'")"
RESERVA="$(sql "select id from goals where name like 'Reserva%'")"
TODAY="$(date +%Y-%m-%d)"
for d in "$(date -d '-60 days' +%Y-%m-%d 2>/dev/null || echo "$TODAY")" "$(date -d '-30 days' +%Y-%m-%d 2>/dev/null || echo "$TODAY")" "$TODAY"; do
  form "/metas/$VIAGEM/registros" "tipo=guardar&valor=650&data=$d&nota=CDB"
  form "/metas/$RESERVA/registros" "tipo=guardar&valor=1000&data=$d&nota=Tesouro+Selic"
done
APORTE="$(sql "select t.id from transactions t join categories c on c.id = t.category_id where c.name = 'Aporte em investimento' limit 1")"
[ -n "$APORTE" ] && form "/metas/ligar/$APORTE" "meta=$RESERVA"
ok "metas de exemplo"

# ---------- páginas ----------
save() { curl -s -b "$JAR" "$URL$2" > "$PAGES/$1.html"; }
save inicio "/"
save mes "/mes?m=2026-10"
save revisar "/revisar"
save lancamentos "/lancamentos"
save metas "/metas"
save assinaturas "/assinaturas"
save ajustes "/ajustes"
TX="$(sql "select id from transactions where description = 'STREAMING EXEMPLO' order by id desc limit 1")"
save lancamento "/lancamentos/$TX"
ok "páginas salvas"

# ---------- fotos ----------
win_path() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
ICON_URL="file:///$(win "$ROOT/docs/img/icone.svg" | sed 's|^/||')"
shoot() { # nome largura altura [escuro]
  local html="$PAGES/$1.html" variant="$TMP/$1-${4:-claro}.html" png="$OUT/tela-$1${4:+-$4}.png"
  # O ícone vem do próprio servidor; no arquivo salvo, aponta para docs/img/icone.svg.
  sed "s|/icone.svg|$ICON_URL|g" "$html" > "$variant"
  if [ "${4:-}" = "escuro" ]; then
    sed -i 's|@media (prefers-color-scheme: dark)|@media all|' "$variant"
  else
    sed -i 's|@media (prefers-color-scheme: dark)|@media (prefers-color-scheme: nenhum)|' "$variant"
  fi
  rm -f "$png"
  MSYS_NO_PATHCONV=1 "$NAV" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --window-size="$2,$3" --screenshot="$(win_path "$png")" "file:///$(win "$variant" | sed 's|^/||')" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$png" ] && break; sleep 1; done
  [ -s "$png" ] && ok "tela-$1${4:+-$4}.png" || fail "não consegui gerar tela-$1"
}
shoot mes 1280 1500
shoot mes 1280 1500 escuro
shoot revisar 1280 1300
shoot lancamentos 1280 1100
shoot lancamento 1280 900
shoot metas 1280 1250
shoot assinaturas 1280 760
shoot importar 1280 900
shoot ajustes 1280 1200

echo
echo "Capturas geradas em docs/img/ com dados fictícios."
