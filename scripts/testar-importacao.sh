#!/usr/bin/env bash
# Teste de ponta a ponta da importação pela página: login, envio de arquivos,
# duplicados, períodos sobrepostos, erros e listagem.
#
# Ambiente isolado: veja scripts/lib/ambiente-teste.sh. Não toca na sua instalação
# (os extratos fictícios nunca entram no seu banco).
#
# Uso, na raiz do repositório: bash scripts/testar-importacao.sh
source "$(dirname "$0")/lib/ambiente-teste.sh"

FIX="$ROOT/packages/core/test/fixtures"
JAR="$TMP/cookies.txt"
USER_="$(grep '^JATOBA_ADMIN_USER=' "$TMP/teste.env" | cut -d= -f2)"
PASS_="$(grep '^JATOBA_ADMIN_PASSWORD=' "$TMP/teste.env" | cut -d= -f2)"

# Envia um arquivo pelo formulário; imprime o código HTTP e guarda a página em $TMP/resposta.html.
send() { curl -s -b "$JAR" -H "Origin: $URL" -o "$TMP/resposta.html" -w '%{http_code}' -F "arquivo=@$1;filename=${2:-$(basename "$1")}" "$URL/importar"; }
page() { grep -c "$1" "$TMP/resposta.html" || true; }

dc up -d >/dev/null 2>&1
wait_healthy
ok "Jatobá de teste no ar"
check "migração da importação aplicada" "$(sql "select count(*) from schema_migrations where id = '0002_import'")" "1"

echo "== Login"
check "importar sem login é recusado" "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $URL" -F "arquivo=@$FIX/cartao-exemplo.ofx" "$URL/importar")" "401"
check "login" "$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -H "Origin: $URL" --data-urlencode "usuario=$USER_" --data-urlencode "senha=$PASS_" "$URL/entrar")" "303"
check "página Importar abre" "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$URL/importar")" "200"

echo "== OFX"
check "envio do OFX do cartão" "$(send "$FIX/cartao-exemplo.ofx")" "200"
[ "$(page '8 novo(s)')" -ge 1 ] && ok "resumo mostra 8 novos" || fail "resumo do OFX: $(grep -o '<li>.*</li>' "$TMP/resposta.html" | head -3)"
check "8 lançamentos no banco" "$(sql "select count(*) from transactions")" "8"

check "mesmo arquivo de novo" "$(send "$FIX/cartao-exemplo.ofx" "copia.ofx")" "200"
[ "$(page 'já tinha sido importado')" -ge 1 ] && ok "avisa que o arquivo já foi importado" || fail "sem aviso de arquivo repetido"
check "nada duplicado" "$(sql "select count(*) from transactions")" "8"

sed 's#</BANKTRANLIST>#<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105<TRNAMT>-12.00<FITID>CT20261105001<MEMO>PADARIA EXEMPLO</STMTTRN>\r\n</BANKTRANLIST>#' "$FIX/cartao-exemplo.ofx" > "$TMP/sobreposto.ofx"
check "período sobreposto" "$(send "$TMP/sobreposto.ofx")" "200"
[ "$(page '1 novo(s), 8 já existia')" -ge 1 ] && ok "só o lançamento novo entra" || fail "sobreposição: $(grep -o '<li>.*</li>' "$TMP/resposta.html" | head -3)"
check "9 lançamentos no banco" "$(sql "select count(*) from transactions")" "9"

echo "== CSV da fatura do C6"
check "envio do CSV" "$(send "$FIX/c6-fatura-exemplo.csv")" "200"
[ "$(page 'Cartão C6')" -ge 1 ] && ok "reconhece a fatura do C6" || fail "CSV não reconhecido"
[ "$(page 'data inválida')" -ge 1 ] && ok "mostra o aviso da linha com data impossível" || fail "sem aviso"
check "9 lançamentos da fatura" "$(sql "select count(*) from transactions t join accounts a on a.id = t.account_id where a.source = 'c6-fatura'")" "9"
check "compra virou saída" "$(sql "select amount from transactions where description = 'MERCADO EXEMPLO'")" "-31245"
check "parcela guardada" "$(sql "select installment_current || '/' || installment_total from transactions where description = 'LOJA EXEMPLO'")" "3/10"
check "dois cafés iguais continuam dois" "$(sql "select count(*) from transactions where description = 'CAFE EXEMPLO'")" "2"
send "$FIX/c6-fatura-exemplo.csv" "fatura-de-novo.csv" > /dev/null
check "fatura de novo não duplica" "$(sql "select count(*) from transactions")" "18"

echo "== Erros"
printf 'Data,Valor\n01/10/2026,1\n' > "$TMP/planilha.csv"
check "formato desconhecido é recusado" "$(send "$TMP/planilha.csv")" "422"
[ "$(page 'Formato não reconhecido')" -ge 1 ] && ok "explica o erro na página" || fail "sem mensagem de erro"
check "envio de outro site é bloqueado" "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -H 'Origin: https://malicioso.example' -F "arquivo=@$FIX/cartao-exemplo.ofx" "$URL/importar")" "403"
head -c 11000000 /dev/zero > "$TMP/grande.ofx"
check "arquivo acima de 10 MB é recusado" "$(send "$TMP/grande.ofx")" "413"
check "nada entrou com os erros" "$(sql "select count(*) from transactions")" "18"

echo "== Lançamentos"
curl -s -b "$JAR" "$URL/lancamentos" > "$TMP/lancamentos.html"
grep -q "PADARIA EXEMPLO" "$TMP/lancamentos.html" && ok "lista mostra os lançamentos" || fail "lista sem lançamentos"
grep -q "parcela 3/10" "$TMP/lancamentos.html" && ok "lista mostra a parcela" || fail "lista sem parcela"
grep -q "18 lançamento" "$TMP/lancamentos.html" && ok "lista mostra o total" || fail "lista sem total"
check "contas sem número completo" "$(sql "select count(*) from accounts where last4 is not null and length(last4) > 4")" "0"

echo
echo "Todos os $PASS testes de importação passaram."
