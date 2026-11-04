# Bot do Telegram (opcional)

O bot responde a consultas rápidas e manda avisos. Ele **só lê**: não recebe extratos, não muda categorias e não move dinheiro. Vem desligado.

| Comando | O que mostra |
| --- | --- |
| `/mes` | Entradas, saídas, saldo e os maiores gastos do mês mais recente. Também `/mes 10/2026` ou `/mes outubro` |
| `/metas` | Quanto já foi guardado em cada meta e se está no ritmo |
| `/revisar` | Quantos lançamentos faltam revisar e possíveis duplicados |
| `/assinaturas` | Assinaturas ativas, total por mês, reajustes e próxima cobrança |
| `/backup` | Quando foi o último backup |

Avisos automáticos: quando uma importação termina e quando o backup diário falha.

## Privacidade

Para chegar ao seu celular, as respostas passam pelos servidores do Telegram: totais, nomes de categorias, metas e assinaturas. Descrições completas de lançamentos, números de conta e arquivos de extrato nunca são enviados. O Jatobá busca as mensagens no Telegram (*long polling*); não é preciso abrir porta nem expor a página na internet.

O bot só responde aos chats listados em `TELEGRAM_ALLOWED_CHAT_IDS`. Mensagens de outras pessoas são ignoradas.

## Ligar

1. No Telegram, abra o **@BotFather**, envie `/newbot` e escolha um nome e um usuário (terminado em `bot`). Ele responde com o **token**, algo como `123456789:AAH...`.
2. Coloque no `.env`:

   ```
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_ALLOWED_CHAT_IDS=
   ```

3. Descubra o seu chat ID: mande qualquer mensagem para o **@userinfobot** e copie o número que ele responder (por exemplo, `123456789`). Outra forma: deixe `TELEGRAM_ALLOWED_CHAT_IDS` com qualquer número, suba o Jatobá, mande `/mes` para o seu bot e rode `docker compose logs app`: aparece "mensagem de um chat não autorizado (id ...)".
4. Ponha o número em `TELEGRAM_ALLOWED_CHAT_IDS` (vários separados por vírgula) e rode `docker compose up -d`.
5. Mande `/ajuda` para o seu bot.

O token é uma senha: não compartilhe e não coloque no Git (o `.env` já fica fora). Se vazar, use `/revoke` no @BotFather e ponha o novo no `.env`.

## Desligar

Comente ou apague `TELEGRAM_BOT_TOKEN` no `.env` e rode `docker compose up -d`.
