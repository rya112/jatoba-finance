# Perfis de banco

Cada banco ou cartão ganha um arquivo que ensina o Jatobá a ler o extrato dele e a limpar as descrições.

O formato ainda é um rascunho e será definido na fase 2. Veja `exemplo.yaml`.

**Nunca use dados reais** para criar ou testar um perfil: recrie os casos com valores inventados em `packages/core/test/fixtures/`.

## O que já sabemos de cada banco

Informações confirmadas com arquivos reais pelo comando `jatoba check`, que não mostra dados.

### C6 Bank

- **Conta corrente:** OFX, lido sem avisos. **Os FITIDs mudam a cada exportação** (são gerados de novo para os mesmos lançamentos), por isso o Jatobá reconhece duplicados pelo conteúdo, não pelo FITID. O período declarado no arquivo (`DTSTART`/`DTEND`) é a data da exportação, não o mês do extrato; o Jatobá usa as datas dos lançamentos. O arquivo não traz saldo.
- **Fatura do cartão:** só CSV, XLSX ou PDF. O Jatobá lê o CSV: separador `;`, colunas `Data de Compra;Nome no Cartão;Final do Cartão;Categoria;Descrição;Parcela;Valor (em US$);Cotação (em R$);Valor (em R$)`.

### Banco do Brasil

- Formatos de exportação ainda não verificados.

### Wise

- Ainda não verificado. Tem várias moedas.
