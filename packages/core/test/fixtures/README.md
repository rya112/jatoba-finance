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

Para um novo caso, crie um arquivo novo com um nome que diga o que ele testa e acrescente uma linha nesta tabela.
