# Fase 0 · Preparação

Esta fase não depende de código. Parte dela acontece **fora do repositório**, porque envolve dados reais.

## No repositório

- [x] Extratos fictícios em `packages/core/test/fixtures/`, cobrindo os casos difíceis da importação.
- [x] Licença escolhida: AGPL-3.0, no arquivo `LICENSE`.
- [x] Conta pessoal no GitHub: `rya112/jatoba-finance`.

## Fora do repositório (na sua máquina, nunca no Git)

Crie uma pasta fora do projeto, por exemplo `~/Financas/extratos/`.

- [ ] Baixar 3 meses de extrato de cada conta e cartão, de preferência em OFX, com nomes como `banco-conta-AAAA-MM.ofx`.
- [ ] Anotar quais bancos exportam OFX, quais só CSV e quais só PDF. Isso define os primeiros perfis de banco.
- [ ] Preencher as metas: valor alvo, prazo e quanto já está guardado.
- [ ] Ajustar a lista de categorias (umas 15 de despesa, mais receitas, transferências e aportes).

## Quando um caso real não estiver coberto

Se um extrato real tiver uma situação que os fictícios não cobrem, **recrie o caso com dados inventados** num arquivo novo em `fixtures/` e descreva-o no README da pasta.
