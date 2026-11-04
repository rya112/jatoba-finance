# Levar o Jatobá para um servidor (LXC no Proxmox, com Tailscale)

Este guia leva uma instalação que já está em uso (por exemplo, no seu computador) para um servidor ligado o tempo todo, sem perder nada: os dados vão pelo backup criptografado, e o acesso fica restrito à sua rede Tailscale. A página nunca é exposta na internet.

Leve para o servidor estes três itens (e nada além deles):

| O quê | De onde | Observação |
| --- | --- | --- |
| Um backup recente | pasta `backups/` (`jatoba-...-manual.sql.age`) | Faça um na hora: **Ajustes → Fazer backup agora** |
| A chave privada | gerenciador de senhas / papel | Só durante a restauração; apague em seguida |
| Os valores do `.env` | o `.env` atual | Copie à mão: senha de login, chave **pública** do backup, Telegram, IA |

## 1. Criar o LXC

No Proxmox, crie um contêiner **Debian 12 ou 13**, sem privilégios (*unprivileged*), com:

- **2 GB de RAM** e **8 GB de disco** já sobram para anos de uso (os backups crescem pouco);
- em **Options → Features**, marque **nesting** e **keyctl** (necessários para o Docker dentro do LXC);
- rede com acesso à internet (para baixar imagens, Tailscale, Telegram e IA).

Não é preciso liberar `/dev/net/tun`: o Tailscale do Jatobá roda em modo *userspace*, dentro do próprio contêiner.

Se o disco do LXC estiver num armazenamento **ZFS** e o Docker falhar ao subir com erros de `overlay`, use o Proxmox 8 ou mais novo (ZFS 2.2+, que suporta overlay) ou crie o LXC num armazenamento ext4/LVM-thin.

## 2. Instalar o Docker e baixar o Jatobá

No console do LXC:

```bash
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh
git clone https://github.com/rya112/jatoba-finance.git /opt/jatoba
cd /opt/jatoba
mkdir -p backups && chown 1000:1000 backups   # o Jatobá grava os backups como o usuário 1000
```

## 3. Configurar o `.env`

```bash
cp .env.example .env
nano .env
```

Preencha com os valores da instalação atual:

- `JATOBA_ADMIN_USER` e `JATOBA_ADMIN_PASSWORD`: o mesmo login (ou um novo, se preferir);
- `POSTGRES_PASSWORD`: pode ser **uma nova** (`openssl rand -hex 24`); o backup não depende dela;
- `JATOBA_BACKUP_RECIPIENT`: **a mesma chave pública**, para os backups antigos e novos abrirem com a mesma chave privada;
- Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`) e IA (`AI_PROVIDER`, `ANTHROPIC_API_KEY`): os mesmos;
- `JATOBA_PUBLIC_URL=https://jatoba.<sua-tailnet>.ts.net` (o endereço que o Tailscale vai dar; veja o passo 6).

> **Antes de subir o servidor, desligue o bot na instalação antiga** (passo 7). Dois Jatobás com o mesmo bot disputam as mensagens: o Telegram entrega cada uma para só um deles.

## 4. Subir e restaurar o backup

```bash
docker compose up -d --build
docker compose ps            # app e postgres "healthy"
```

Copie o backup para `/opt/jatoba/backups/` (por exemplo, com `scp` a partir do seu computador ou pelo navegador de arquivos do Proxmox) e crie a chave temporária:

```bash
nano backups/chave-backup.txt          # cole a linha AGE-SECRET-KEY-...
docker compose exec app jatoba list
docker compose exec app jatoba restore jatoba-AAAAMMDD-HHMMSS-manual.sql.age --chave chave-backup.txt --confirmar
docker compose restart app
rm backups/chave-backup.txt            # não deixe a chave privada no servidor
```

Confira: `curl -s localhost:8080/health` deve responder `"status":"ok"`.

## 5. Tailscale: permissões antes de ligar

No painel do Tailscale (`login.tailscale.com`):

1. **DNS**: ligue **MagicDNS** e **HTTPS Certificates**.
2. **Access controls**: deixe só você chegar ao Jatobá. Exemplo (troque o e-mail):

   ```json
   "tagOwners": { "tag:jatoba": ["autogroup:admin"] },
   "acls": [
     { "action": "accept", "src": ["seu-email@exemplo.com"], "dst": ["tag:jatoba:443"] }
   ]
   ```

   Se a sua política ainda for a padrão (que libera tudo para todos os aparelhos da tailnet), qualquer aparelho seu, ou de alguém que você convidou, alcança a página. O login do Jatobá continua obrigatório, mas o ideal é limitar aqui também.
3. **Settings → Keys**: gere uma chave de autenticação **de uso único**, com a tag `tag:jatoba`.
4. **Não ative o Funnel** para o Jatobá: ele publica o serviço na internet aberta.

## 6. Ligar o Tailscale

No `.env`, acrescente a chave do passo anterior:

```
TS_AUTHKEY=tskey-auth-...
```

E suba com o perfil:

```bash
docker compose --profile tailscale up -d
docker compose logs tailscale | tail -20
```

O contêiner entra na tailnet como `jatoba` e serve a página em `https://jatoba.<sua-tailnet>.ts.net`. Abra esse endereço no celular (com o app do Tailscale ligado) e entre com o login.

Depois:

- no painel, abra a máquina `jatoba` e **desative Key expiry**, para o acesso não cair depois de alguns meses;
- apague `TS_AUTHKEY` do `.env`: o estado fica salvo no volume `tailscale-state`;
- a página continua aberta também em `http://localhost:8080` **dentro do LXC** (útil para `curl`), mas não na rede local nem na internet.

## 7. Desligar a instalação antiga

Na máquina antiga, depois de conferir que o servidor está certo:

```bash
docker compose down        # para app e banco; os dados continuam no volume, como reserva
```

Se for manter a antiga por um tempo como reserva, comente `TELEGRAM_BOT_TOKEN` no `.env` dela, para o bot responder só pelo servidor, e não importe mais nada nela: os dados das duas não se juntam.

## Rotina no servidor

- **Backups**: diários, automáticos, em `/opt/jatoba/backups/`. Copie alguns para fora do servidor de vez em quando (outro disco, nuvem); estão criptografados. No Proxmox, o backup do próprio LXC (vzdump) é uma camada extra.
- **Atualizar o Jatobá**: `cd /opt/jatoba && git pull && docker compose --profile tailscale up -d --build` (o backup automático roda antes de qualquer migração). Veja `docs/atualizar.md`.
- **Importar extratos**: pela página, do celular ou do computador, pelo endereço do Tailscale.
