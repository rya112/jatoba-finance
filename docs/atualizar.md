# Atualizar para uma nova versão

## Antes de atualizar

1. Leia as notas da versão na página de **Releases** do GitHub ou no `CHANGELOG.md`. Se houver **Mudanças incompatíveis**, siga o passo a passo indicado lá.
2. Faça um backup extra (veja [backup.md](backup.md)):

```bash
docker compose exec app jatoba backup
```

## Atualizar

```bash
docker compose pull
docker compose up -d
docker compose ps   # o app deve aparecer como "healthy"
```

Na partida, se houver migrações a aplicar, a aplicação faz um backup automático (quando `JATOBA_BACKUP_RECIPIENT` está no `.env`), aplica as migrações do banco e só passa a responder quando a verificação de saúde estiver verde. Se uma migração falhar, ela não sobe e informa qual backup usar.

## Qual versão o compose usa

As imagens são publicadas com as tags `1.4.2`, `1.4`, `1` e `latest`. O `compose.yaml` oficial usa a versão maior (por exemplo `:1`): você recebe correções e novidades compatíveis, e uma versão maior nova só chega quando você trocar a tag, depois de ler as mudanças incompatíveis.

## Voltar para a versão anterior

Migrações de banco não se desfazem sozinhas. Para voltar:

1. Fixe a tag anterior no `compose.yaml` (por exemplo `:1.4.1`).
2. Restaure o backup `...-antes-migracao.sql.age` feito na atualização, com a sua chave privada (veja [backup.md](backup.md#restaurar)):

```bash
docker compose exec -T app jatoba restore <arquivo-do-backup> --confirmar < chave-backup.txt
```

3. `docker compose up -d`.
