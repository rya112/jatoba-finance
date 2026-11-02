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

### Segurança

- Node.js 26 (LTS) na imagem Docker, no CI e como versão mínima (`engines`).
- Dependências atualizadas para fechar alertas do `npm audit`: `zod` 4, `@hono/node-server` 2 e `vitest` 5.
