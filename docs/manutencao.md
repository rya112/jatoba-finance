# Manutenção do projeto

Para quem mantém o repositório.

## Dependências

- O **Renovate** abre pedidos de atualização agrupados, uma vez por semana (`renovate.json`). Para ativá-lo, instale o app Renovate no repositório pelo GitHub Marketplace.
- A integração contínua (`.github/workflows/ci.yml`) roda build, testes, `npm audit` e o build da imagem Docker em cada pedido.
- A imagem base (`node:26-alpine`) e o Postgres seguem o mesmo processo.
- Correções de segurança viram uma versão de correção (por exemplo, `1.4.3`) assim que estiverem testadas, com destaque nas notas.

## Versões e releases

- Versionamento semântico: `MAIOR.MENOR.CORREÇÃO`.
- Toda mudança visível entra no `CHANGELOG.md` antes da release.
- A release automática, com imagens multi-arquitetura no GitHub Container Registry, chega na fase 6.

## Checklist de release (a partir da fase 6)

- [ ] `CHANGELOG.md` atualizado, com o passo a passo de mudanças incompatíveis, se houver
- [ ] Testes passando no CI
- [ ] Atualização testada a partir da versão anterior, com dados
- [ ] Tag `vX.Y.Z` criada
