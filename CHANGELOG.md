# Changelog

Todas as mudanças relevantes ficam registradas aqui. O projeto segue o [versionamento semântico](https://semver.org/lang/pt-BR/).

Cada versão tem as seções **Novidades**, **Correções**, **Segurança** e, quando houver, **Mudanças incompatíveis**, sempre com o passo a passo para atualizar.

## [Não publicado]

### Novidades

- Estrutura inicial do repositório: monorepo com `packages/core` e `packages/web`.
- `compose.yaml` com a aplicação, o Postgres e o perfil opcional do Tailscale.
- Validação da configuração na partida: usuário e senha obrigatórios no `.env`, senha com 14 caracteres ou mais e diferente da senha de exemplo.
- Página provisória e verificação de saúde em `/health`.
- Extratos OFX fictícios para testes.
- Licença AGPL-3.0.
- Login com o usuário e a senha do `.env`. A sessão dura 30 dias, e o botão **Sair** a encerra.
- Migrações do banco na partida, numa única transação: se uma falhar, nada muda e a aplicação não sobe.
- `/health` também verifica o banco de dados.
- Backups criptografados com `age`: `jatoba backup`, `jatoba list`, `jatoba restore` e `jatoba keygen`. Há backup automático antes de migrações e de restaurações. Veja `docs/backup.md`.
- Imagem Docker para amd64 e arm64 (Mac com chip Apple, Raspberry Pi 4 ou mais novo).

### Segurança

- Node.js 26 (LTS) na imagem Docker, no CI e como versão mínima (`engines`).
- Dependências atualizadas para fechar alertas do `npm audit`: `zod` 4, `@hono/node-server` 2 e `vitest` 5.
- Senha guardada só como hash (scrypt), sessões guardadas só como hash do token, proteção contra CSRF e bloqueio depois de 5 senhas erradas.
- Backups criptografados com chave pública: o servidor cria backups, mas só a chave privada, guardada fora dele, consegue abri-los. A restauração é atômica: com chave errada ou arquivo corrompido, nada muda.
