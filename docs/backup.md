# Backup e restauração

Os backups saem **criptografados** com o [age](https://age-encryption.org) e ficam na pasta `backups/`, ao lado do `compose.yaml`.

O Jatobá usa um **par de chaves**:

| Chave | Onde fica | Para que serve |
| --- | --- | --- |
| Pública (`age1...`) | No `.env`, em `JATOBA_BACKUP_RECIPIENT` | Criar backups |
| Privada (`AGE-SECRET-KEY-...`) | **Fora deste computador**: gerenciador de senhas, papel impresso ou pendrive guardado | Restaurar backups |

Assim, o computador consegue criar backups, mas não consegue abri-los. Quem roubar o computador ou um backup, mesmo junto com o `.env`, não lê seus dados.

> **Sem a chave privada, nenhum backup pode ser restaurado.** Guarde-a em pelo menos dois lugares.

## Configurar (uma vez)

1. Gere o par de chaves:

   ```bash
   docker compose run --rm --no-deps app jatoba keygen
   ```

2. Copie a linha `JATOBA_BACKUP_RECIPIENT=age1...` para o `.env`.
3. Guarde a chave privada, a linha `AGE-SECRET-KEY-...`, fora do computador.
4. Aplique: `docker compose up -d`.

## Fazer um backup

```bash
docker compose exec app jatoba backup
docker compose exec app jatoba list
```

O arquivo aparece em `backups/`, com nome do tipo `jatoba-20261103-091530-manual.sql.age` (data e hora em UTC). Copie-o para fora do computador de vez em quando: nuvem, HD externo ou pendrive. Como está criptografado, pode ir para qualquer lugar.

Backups automáticos:

- **antes de cada migração do banco**, na partida de uma versão nova (`...-antes-migracao.sql.age`);
- **antes de cada restauração**, com o estado que vai ser substituído (`...-antes-restauracao.sql.age`).

## Restaurar

1. Salve a chave privada num arquivo, por exemplo `chave-backup.txt`, na pasta do Jatobá, só durante a restauração.
2. Rode, trocando pelo nome do backup:

   ```bash
   docker compose exec -T app jatoba restore jatoba-20261103-091530-manual.sql.age --confirmar < chave-backup.txt
   docker compose restart app
   ```

3. **Apague o `chave-backup.txt`** em seguida.

O que a restauração garante:

- Substitui **todos** os dados atuais pelos do backup. Antes, cria um backup de segurança do estado atual.
- Acontece numa única transação. Com chave errada, arquivo corrompido ou qualquer outro erro, **nada muda** no banco.
- Sem `--confirmar`, ela só explica o que faria.

## Problemas comuns

| Mensagem | O que fazer |
| --- | --- |
| `JATOBA_BACKUP_RECIPIENT não está no .env` | Siga **Configurar** acima. |
| `Não consegui abrir o backup ... chave privada` | A chave não é a do par que criou esse backup, ou o arquivo foi alterado. |
| `A pasta de backups ... não aceita gravação` (Linux) | Na pasta do Jatobá: `mkdir -p backups && sudo chown 1000:1000 backups` |

## Testar o backup

Quem desenvolve pode rodar o teste de ponta a ponta. Ele sobe um Jatobá separado, com dados e chaves descartáveis, e não toca na sua instalação:

```bash
bash scripts/testar-backup.sh
```
