# Atualizar o ambiente

O Jatobá roda dentro do Docker, então a maior parte do ambiente se atualiza sem cuidados especiais.

| Componente | O que fazer |
| --- | --- |
| Docker | Atualize normalmente. Depois, confira com `docker compose ps`. |
| Sistema operacional | Mantenha as atualizações de segurança automáticas. Depois de reiniciar, os contêineres sobem sozinhos (`restart: unless-stopped`). |
| Node.js | Nada a fazer: ele vem dentro da imagem e é atualizado pelo projeto. |
| Postgres, versão menor | Vem junto com `docker compose pull`. |
| Postgres, versão maior (por exemplo, de 16 para 17) | Exige exportar e importar os dados. O projeto vai anunciar quando mudar, com um comando dedicado e o passo a passo. Não troque a tag do Postgres por conta própria. |
| Tailscale no computador | Atualização automática pelo próprio Tailscale. |
| Tailscale em contêiner | Vem junto com `docker compose pull`. |

## Depois de qualquer atualização

```bash
docker compose ps
docker compose logs --tail=50 app
```

O app deve aparecer como `healthy`, e o log não deve ter erros.
