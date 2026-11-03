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
check "importar sem login é recusado" "$(curl -s -o "$TMP/descarte" -w '%{http_code}' -H "Origin: $URL" -F "arquivo=@$FIX/cartao-exemplo.ofx" "$URL/importar")" "401"
check "login" "$(curl -s -c "$JAR" -o "$TMP/descarte" -w '%{http_code}' -H "Origin: $URL" --data-urlencode "usuario=$USER_" --data-urlencode "senha=$PASS_" "$URL/entrar")" "303"
check "página Importar abre" "$(curl -s -b "$JAR" -o "$TMP/descarte" -w '%{http_code}' "$URL/importar")" "200"

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
check "envio de outro site é bloqueado" "$(curl -s -b "$JAR" -o "$TMP/descarte" -w '%{http_code}' -H 'Origin: https://malicioso.example' -F "arquivo=@$FIX/cartao-exemplo.ofx" "$URL/importar")" "403"
head -c 11000000 /dev/zero > "$TMP/grande.ofx"
check "arquivo acima de 10 MB é recusado" "$(send "$TMP/grande.ofx")" "413"
check "nada entrou com os erros" "$(sql "select count(*) from transactions")" "18"

echo "== Lançamentos"
curl -s -b "$JAR" "$URL/lancamentos" > "$TMP/lancamentos.html"
grep -q "PADARIA EXEMPLO" "$TMP/lancamentos.html" && ok "lista mostra os lançamentos" || fail "lista sem lançamentos"
grep -q "parcela 3/10" "$TMP/lancamentos.html" && ok "lista mostra a parcela" || fail "lista sem parcela"
grep -q "18 lançamento" "$TMP/lancamentos.html" && ok "lista mostra o total" || fail "lista sem total"
check "contas sem número completo" "$(sql "select count(*) from accounts where last4 is not null and length(last4) > 4")" "0"

echo "== Categorias e revisão"
send "$FIX/banco-exemplo-corrente.ofx" > /dev/null
check "regra do sistema: pagamento de fatura" "$(sql "select c.name from transactions t join categories c on c.id = t.category_id where t.description = 'PAGAMENTO FATURA CARTAO EXEMPLO'")" "Pagamento de fatura"
check "regra do sistema: salário" "$(sql "select c.name from transactions t join categories c on c.id = t.category_id where t.description like 'CREDITO SALARIO%'")" "Salário"
check "categoria do C6: mercado" "$(sql "select c.name from transactions t join categories c on c.id = t.category_id where t.description = 'MERCADO EXEMPLO'")" "Mercado"
check "descrição limpa guardada" "$(sql "select clean_description from transactions where description like 'COMPRA CARTAO DEBITO SUPERMERCADO%'")" "SUPERMERCADO EXEMPLO SAO PAULO"
curl -s -b "$JAR" "$URL/lancamentos" | grep -q "SUPERMERCADO EXEMPLO SAO PAULO" && ok "lista mostra a descrição limpa" || fail "lista sem descrição limpa"

curl -s -b "$JAR" "$URL/revisar" > "$TMP/revisar.html"
grep -q "para revisar" "$TMP/revisar.html" && ok "página Revisar abre" || fail "Revisar não abriu"
grep -q "pela regra “FATURA”" "$TMP/revisar.html" && ok "mostra a origem da sugestão" || fail "sem origem da sugestão"

POSTO_IDS="$(sql "select string_agg(id::text, ',' order by id) from transactions where description = 'POSTO EXEMPLO'")"
FIRST="${POSTO_IDS%%,*}"
TRANSPORTE="$(sql "select id from categories where name = 'Transporte'")"
CODE="$(curl -s -b "$JAR" -H "Origin: $URL" -o "$TMP/descarte" -w '%{http_code}' --data "categoria=$TRANSPORTE&criar_regra=1&regra=POSTO+EXEMPLO" "$URL/revisar/$FIRST")"
check "salvar categoria com regra" "$CODE" "303"
check "lançamento ficou manual e revisado" "$(sql "select category_source || ' ' || reviewed from transactions where id = $FIRST")" "manual true"
check "regra do usuário criada" "$(sql "select count(*) from rules where origin = 'usuario' and pattern = 'POSTO EXEMPLO'")" "1"
check "nenhum POSTO ficou sem categoria" "$(sql "select count(*) from transactions where description = 'POSTO EXEMPLO' and category_id is distinct from $TRANSPORTE")" "0"

PENDING_BEFORE="$(sql "select count(*) from transactions where not reviewed")"
SUGGESTED="$(sql "select count(*) from transactions where not reviewed and category_id is not null")"
IDS="$(sql "select string_agg('id=' || id, '&') from transactions where not reviewed and category_id is not null")"
check "aprovar em lote" "$(curl -s -b "$JAR" -H "Origin: $URL" -o "$TMP/descarte" -w '%{http_code}' --data "$IDS" "$URL/revisar/aprovar")" "303"
check "aprovou só os com sugestão" "$(sql "select count(*) from transactions where not reviewed")" "$((PENDING_BEFORE - SUGGESTED))"
check "aprovação de outro site bloqueada" "$(curl -s -b "$JAR" -H 'Origin: https://malicioso.example' -o "$TMP/descarte" -w '%{http_code}' --data "id=1" "$URL/revisar/aprovar")" "403"

echo "== Ajustes"
form() { curl -s -b "$JAR" -H "Origin: $URL" -o "$TMP/descarte" -w '%{http_code}' --data "$2" "$URL$1"; }
curl -s -b "$JAR" "$URL/ajustes" | grep -q "<h1>Ajustes</h1>" && ok "página Ajustes abre" || fail "Ajustes não abriu"
CASA="$(sql "select id from categories where name = 'Contas da casa'")"
check "criar regra pela página" "$(form /ajustes/regras "texto=energia+exemplo&direcao=saida&conta=conta&categoria=$CASA")" "303"
check "regra aplicada ao lançamento" "$(sql "select c.name from transactions t join categories c on c.id = t.category_id where t.description = 'DEB AUTOMATICO ENERGIA EXEMPLO'")" "Contas da casa"
MERCADO="$(sql "select id from categories where name = 'Mercado'")"
check "renomear categoria" "$(form "/ajustes/categorias/$MERCADO" "nome=Supermercado&tipo=despesa")" "303"
dc restart app >/dev/null 2>&1
wait_healthy
check "sugestão do C6 continua após renomear e reiniciar" "$(sql "select c.name from transactions t join categories c on c.id = t.category_id where t.description = 'MERCADO EXEMPLO'")" "Supermercado"
CONTA="$(sql "select id from accounts where kind = 'conta' order by id limit 1")"
check "renomear conta" "$(form "/ajustes/contas/$CONTA" "nome=Conta+de+teste")" "303"
check "conta renomeada" "$(sql "select name from accounts where id = $CONTA")" "Conta de teste"
OUTROS="$(sql "select id from categories where name = 'Outros'")"
check "apagar sem confirmação é recusado" "$(form "/ajustes/categorias/$OUTROS/apagar" "mover_para=")" "400"
check "categoria continua lá" "$(sql "select count(*) from categories where id = $OUTROS")" "1"

echo "== Metas"
curl -s -b "$JAR" "$URL/metas" | grep -q "<h1>Metas</h1>" && ok "página Metas abre" || fail "Metas não abriu"
check "criar meta Viagem de R\$ 10.000" "$(form /metas "nome=Viagem&alvo=10000&prazo=&guardado=")" "303"
META="$(sql "select id from goals where name = 'Viagem'")"
APORTE="$(sql "select t.id from transactions t join categories c on c.id = t.category_id where c.name = 'Aporte em investimento' limit 1")"
curl -s -b "$JAR" "$URL/metas" | grep -q "/metas/ligar/$APORTE" && ok "aporte do extrato aparece para ligar" || fail "aporte não listado"
check "ligar aporte à meta" "$(form "/metas/ligar/$APORTE" "meta=$META")" "303"
check "registrar R\$ 500 guardados" "$(form "/metas/$META/registros" "tipo=guardar&valor=500&data=2026-11-03&nota=CDB")" "303"
check "progresso: R\$ 1.500 do aporte + R\$ 500" "$(sql "select sum(amount) from goal_entries where goal_id = $META")" "200000"
curl -s -b "$JAR" "$URL/metas" > "$TMP/metas.html"
grep -qF "20% · faltam" "$TMP/metas.html" && ok "página mostra 20% e quanto falta" || fail "progresso não aparece: $(grep -o '[0-9]*% · faltam[^<]*' "$TMP/metas.html" | head -2)"

echo "== Mês"
curl -s -b "$JAR" "$URL/mes" > "$TMP/mes.html"
grep -q "Para onde foi o dinheiro" "$TMP/mes.html" && ok "página do Mês abre" || fail "Mês não abriu"
grep -q "Novembro de 2026" "$TMP/mes.html" && ok "mostra o mês mais recente (fatura de nov/2026)" || fail "mês errado: $(grep -o '<h1>[^<]*' "$TMP/mes.html")"
grep -q 'categoria=sem' "$TMP/mes.html" && ok "liga os sem categoria à lista filtrada" || fail "sem link de sem categoria"
curl -s -b "$JAR" "$URL/lancamentos?mes=2026-10&categoria=sem" | grep -q "Filtrando:" && ok "Lançamentos filtra por mês e categoria" || fail "filtro não aplicado"

dc restart app >/dev/null 2>&1
wait_healthy
check "reinício não muda categorias revisadas" "$(sql "select count(*) from transactions where description = 'POSTO EXEMPLO' and category_id = $TRANSPORTE")" "$(echo "$POSTO_IDS" | tr ',' '\n' | wc -l | tr -d ' ')"

echo
echo "Todos os $PASS testes de importação passaram."
