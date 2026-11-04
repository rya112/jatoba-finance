# Como contribuir

Obrigado pelo interesse! O projeto ainda está nas primeiras fases, então issues com ideias e relatos são tão bem-vindos quanto código.

## Regra número um: nenhum dado real

Nunca envie extratos, faturas, nomes, números de conta ou valores reais, nem em issues, nem em código, nem em capturas de tela. Para testes, use os extratos fictícios de `packages/core/test/fixtures/` ou crie novos, inventados.

## Preparar o ambiente

```bash
npm install
npm run build
npm test
```

Requer Node.js 26 ou mais novo e, para rodar tudo junto, o Docker.

Os testes de banco rodam quando `TEST_DATABASE_URL` aponta para um Postgres de teste (cada arquivo cria e apaga o próprio banco):

```bash
docker run -d --rm --name jatoba-pg-teste -e POSTGRES_PASSWORD=teste -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:teste@127.0.0.1:55432/postgres npm test
```

Testes de ponta a ponta, com Docker, num ambiente isolado que não toca na sua instalação:

```bash
bash scripts/testar-backup.sh
bash scripts/testar-importacao.sh
```

Capturas de tela do README (dados fictícios, Edge/Chrome sem janela): `bash scripts/gerar-capturas.sh`.

## Antes de abrir um pull request

- `npm run build` e `npm test` passam.
- Mudanças visíveis para quem usa entram no `CHANGELOG.md`, na seção **Não publicado**.
- Mensagens de commit no formato `tipo: descrição` (`feat`, `fix`, `docs`, `chore`, `test`).

## Perfis de banco

A contribuição mais valiosa: ensinar o Jatobá a ler o extrato de um banco. Veja [bank-profiles/README.md](bank-profiles/README.md). O formato será definido na fase 2 do roadmap.
