# Extratos fictícios de teste

Tudo aqui é inventado: bancos, contas, pessoas e valores. **Nunca coloque extratos reais neste repositório.** O `.gitignore` bloqueia arquivos `.ofx` e `.csv` fora desta pasta.

| Arquivo | Caso coberto | Lançamento |
| --- | --- | --- |
| `banco-exemplo-corrente.ofx` | Receita | Salário |
| | Transferência entre contas próprias | Pix enviado e Pix recebido de "TITULAR EXEMPLO" |
| | Pagamento de fatura (não pode contar como gasto) | `PAGAMENTO FATURA CARTAO EXEMPLO` |
| | Aporte em meta | `APLICACAO CDB EXEMPLO` |
| | Débito automático | Conta de luz |
| | Compra no débito com ruído na descrição | `COMPRA CARTAO DEBITO SUPERMERCADO EXEMPLO SAO PAULO` |
| `cartao-exemplo.ofx` | Compra parcelada | `LOJA EXEMPLO PARC 03/10` |
| | Estorno | `ESTORNO LOJA EXEMPLO` |
| | Assinatura em meses seguidos | `STREAMING EXEMPLO` em setembro e outubro |
| | Pagamento recebido na fatura (contraparte do pagamento) | `PAGAMENTO RECEBIDO` |
| | Compras comuns | Restaurante, posto |
| `ofx2-xml-utf8.ofx` | OFX 2.x em XML, UTF-8, com tags de fechamento | Acentos (`PADARIA SÃO JOÃO`) |
| | Nome dentro de `<PAYEE>` e entidade `&amp;` | `LOJA A & B EXEMPLO` |
| | `NAME` e `MEMO` iguais (não pode repetir) | `PIX RECEBIDO` |
| `sgml-1252-conta-e-cartao.ofx` | OFX 1.x em Windows-1252 | Acentos (`AÇOUGUE`, `FARMÁCIA`) |
| | Vírgula como separador decimal | `-45,90` e `-1.234,56` |
| | Data com hora e fuso | `20261003143000.000[-3:BRT]` |
| | `MEMO` vazio | Aluguel |
| | Lançamento sem data (ignorado, com aviso) | FITID `S3` |
| | Conta e cartão no mesmo arquivo | Dois extratos |
| `c6-fatura-exemplo.csv` | Fatura do C6 em CSV: **cabeçalho real**, valores e convenções inventados | UTF-8 com BOM, separador `;` |
| | Compras positivas no arquivo (o leitor inverte pela maioria) | Pagamento e estorno negativos |
| | Parcela em coluna própria | `3/10` e `Única` |
| | Vários cartões na mesma fatura (titular, adicional, virtual) | Finais 1111, 2222 e 3333 |
| | Compra em dólar com cotação | `STREAMING EXEMPLO` |
| | Decimal com ponto e sem milhar, como no C6 real (`1450.00`), e `;` dentro de aspas | `"HOTEL EXEMPLO; CENTRO"` |
| | Parcela com a data da compra original, meses antes da fatura | `LOJA EXEMPLO` 3/10 em 08/07 |
| | Duas compras idênticas no mesmo dia (não são duplicadas) | `CAFE EXEMPLO` duas vezes |
| | Data impossível (ignorada, com aviso) | 31/02 |

Para um novo caso, crie um arquivo novo com um nome que diga o que ele testa e acrescente uma linha nesta tabela.
