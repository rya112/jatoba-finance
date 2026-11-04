# Perfis de banco

Cada banco ou cartão ganha um arquivo que ensina o Jatobá a ler o extrato dele e a limpar as descrições.

**Como está hoje:** cada banco é definido em código, que se mostrou mais simples e mais fácil de testar:

- formato do CSV (colunas, data, sinal): `CSV_LAYOUTS` em `packages/core/src/import/csv.ts`;
- regras de categoria do sistema: migração `0004_categories`; categorias do banco mapeadas: `BANK_CATEGORY_MAP` em `packages/core/src/categories.ts`;
- limpeza de descrições: `cleanDescription` no mesmo arquivo.

Para ensinar um banco novo, siga o C6 como modelo: um layout em `CSV_LAYOUTS` (ou nada, se o banco exporta OFX), extratos fictícios em `packages/core/test/fixtures/` e testes.

**Nunca use dados reais** para criar ou testar um perfil: recrie os casos com valores inventados em `packages/core/test/fixtures/`.

## O que já sabemos de cada banco

Informações confirmadas com arquivos reais pelo comando `jatoba check`, que não mostra dados.

### C6 Bank

- **Conta corrente:** OFX, lido sem avisos. **Os FITIDs mudam a cada exportação** e, às vezes, **o texto de um lançamento muda** entre uma exportação e outra (por exemplo, nome de quem enviou no lugar da descrição) (são gerados de novo para os mesmos lançamentos), por isso o Jatobá reconhece duplicados pelo conteúdo, não pelo FITID, e marca como **possível duplicado** o que tem mesma data e valor com texto diferente, para você decidir em Revisar. O período declarado no arquivo (`DTSTART`/`DTEND`) é a data da exportação, não o mês do extrato; o Jatobá usa as datas dos lançamentos. O arquivo não traz saldo.
- **Fatura do cartão:** só CSV, XLSX ou PDF. Valores com ponto decimal e compras positivas. Em parcelas, a coluna de data às vezes avança a cada fatura e às vezes repete a data da compra original; por isso o mês de cada lançamento é o do vencimento da fatura (último dia de compra + 10 dias, que bate com o nome do arquivo `c6-AAAAMM-fatura.csv`). A anuidade vem parcelada e é estornada no mesmo dia. O Jatobá lê o CSV: separador `;`, colunas `Data de Compra;Nome no Cartão;Final do Cartão;Categoria;Descrição;Parcela;Valor (em US$);Cotação (em R$);Valor (em R$)`.

### Banco do Brasil

- Formatos de exportação ainda não verificados.

### Wise

- Ainda não verificado. Tem várias moedas.
