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

- **todo dia**, a partir das 3h (ou assim que o computador ligar depois disso), guardando os 14 mais recentes (`...-diario.sql.age`). Ajuste no `.env` com `JATOBA_BACKUP_HOUR`, `JATOBA_BACKUP_KEEP` ou desligue com `JATOBA_BACKUP_DAILY=false`. A situação aparece em **Ajustes → Backups**, que também tem o botão **Fazer backup agora**;
- **antes de cada migração do banco**, na partida de uma versão nova (`...-antes-migracao.sql.age`);
- **antes de cada restauração**, com o estado que vai ser substituído (`...-antes-restauracao.sql.age`).

## Restaurar

1. Veja os backups disponíveis: `docker compose exec app jatoba list`.
2. Salve a chave privada (a linha `AGE-SECRET-KEY-...`) num arquivo **dentro da pasta `backups/`**, por exemplo `backups/chave-backup.txt`. Pode ser pelo Bloco de Notas; o Jatobá ignora fins de linha do Windows e comentários.
3. Rode, trocando pelo nome do backup (funciona igual no PowerShell, no Linux e no Mac):

   ```bash
   docker compose exec app jatoba restore jatoba-20261103-091530-manual.sql.age --chave chave-backup.txt --confirmar
   docker compose restart app
   ```

4. **Apague o `backups/chave-backup.txt`** em seguida. A chave privada não deve ficar no computador.

Também dá para passar a chave pela entrada padrão, no Linux e no Mac: `docker compose exec -T app jatoba restore <arquivo> --confirmar < chave-backup.txt`. No PowerShell isso não funciona (o `<` não é aceito); use o `--chave`.

### Ensaio de restauração

Vale ensaiar uma vez, para ter certeza de que a chave guardada funciona. Ao restaurar, os dados atuais são substituídos pelos do backup: o que você fez **depois** do backup escolhido (revisões, regras, importações) volta para trás. Por isso, faça o ensaio logo depois de um backup (**Ajustes → Fazer backup agora**) e restaure **esse** backup: nada se perde. Se algo der errado, o backup de segurança `...-antes-restauracao.sql.age`, criado automaticamente, guarda o estado de antes.

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
