# Levar o Jatobá para um servidor (LXC no Proxmox, com Tailscale)

Este guia leva uma instalação que já está em uso (por exemplo, no seu computador) para um servidor ligado o tempo todo, sem perder nada: os dados vão pelo backup criptografado, e o acesso fica restrito à sua rede Tailscale. A página nunca é exposta na internet.

Leve para o servidor estes três itens (e nada além deles):

| O quê | De onde | Observação |
| --- | --- | --- |
| Um backup recente | pasta `backups/` (`jatoba-...-manual.sql.age`) | Faça um na hora: **Ajustes → Fazer backup agora** |
| A chave privada | gerenciador de senhas / papel | Só durante a restauração; apague em seguida |
| Os valores do `.env` | o `.env` atual | Copie à mão: senha de login, chave **pública** do backup, Telegram, IA |

Nos comandos abaixo, `120` é o número (ID) do LXC e `192.168.0.10` é o endereço do Proxmox: troque pelos seus. Onde está escrito **no Proxmox**, rode no shell do host (pela interface: o nó → **Shell**); onde está **no LXC**, rode dentro do contêiner.

## 1. Criar o LXC

### 1.1. Baixar o modelo do Debian (no Proxmox)

```bash
# Atualiza a lista de modelos de sistema que o Proxmox conhece.
pveam update

# Descobre o nome do modelo mais recente do Debian 12
# (para o Debian 13, troque "debian-12" por "debian-13").
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)
echo "$TEMPLATE"        # algo como debian-12-standard_12.12-1_amd64.tar.zst

# Baixa o modelo para o armazenamento "local" (onde ficam ISOs e modelos).
pveam download local "$TEMPLATE"
```

### 1.2. Criar o contêiner (no Proxmox)

```bash
# Próximo ID livre (opcional: você pode escolher qualquer número que não esteja em uso).
pvesh get /cluster/nextid

pct create 120 "local:vztmpl/$TEMPLATE" \
  --hostname jatoba \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --cores 2 \
  --memory 2048 \
  --swap 512 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --timezone host \
  --onboot 1 \
  --start 1
```

O que cada opção faz:

| Opção | Para quê |
| --- | --- |
| `120` | O ID do contêiner no Proxmox. |
| `"local:vztmpl/$TEMPLATE"` | O modelo do Debian baixado no passo anterior. |
| `--hostname jatoba` | O nome do contêiner na sua rede. |
| `--unprivileged 1` | Contêiner **sem privilégios**: o root de dentro não é o root do Proxmox. Mais seguro. |
| `--features nesting=1,keyctl=1` | Permite rodar o **Docker** dentro do LXC (sem isso, os contêineres do Jatobá não sobem). |
| `--cores 2 --memory 2048 --swap 512` | 2 núcleos, 2 GB de RAM e 512 MB de swap: sobra para o Jatobá e o Postgres. |
| `--rootfs local-lvm:8` | Disco de **8 GB** no armazenamento `local-lvm`. Os backups crescem pouco; se usar outro armazenamento, troque o nome (veja **Datacenter → Storage**). |
| `--net0 name=eth0,bridge=vmbr0,ip=dhcp` | Placa de rede na ponte `vmbr0` (a padrão), com IP automático. Para IP fixo: `ip=192.168.0.50/24,gw=192.168.0.1`. |
| `--timezone host` | Mesmo fuso horário do Proxmox. |
| `--onboot 1` | Liga sozinho quando o Proxmox reiniciar. |
| `--start 1` | Liga assim que for criado. |

Não é preciso liberar `/dev/net/tun`: o Tailscale do Jatobá roda em modo *userspace*, dentro do próprio contêiner.

Se o disco do LXC estiver num armazenamento **ZFS** e o Docker falhar ao subir com erros de `overlay`, use o Proxmox 8 ou mais novo (ZFS 2.2+, que suporta overlay) ou crie o LXC num armazenamento ext4/LVM-thin.

Prefere a interface? **Create CT** com os mesmos valores: modelo Debian 12, **Unprivileged container** marcado, 8 GB de disco, 2 núcleos, 2048 MB de memória, rede DHCP; depois, em **Options → Features**, marque **nesting** e **keyctl**.

### 1.3. Entrar no LXC (no Proxmox)

```bash
# Abre um terminal como root dentro do contêiner 120 (sai com "exit").
pct enter 120
```

## 2. Instalar o Docker e baixar o Jatobá (no LXC)

```bash
# Atualiza o sistema e instala o básico para baixar o Docker e o código.
apt update && apt upgrade -y
apt install -y ca-certificates curl git

# Instala o Docker e o Docker Compose pelo script oficial do Docker.
curl -fsSL https://get.docker.com | sh

# Confere: deve mostrar as versões, sem erro.
docker --version && docker compose version

# Baixa o Jatobá para /opt/jatoba.
git clone https://github.com/rya112/jatoba-finance.git /opt/jatoba
cd /opt/jatoba

# Pasta dos backups: o Jatobá grava os arquivos como o usuário 1000, então ela precisa ser dele.
mkdir -p backups && chown 1000:1000 backups
```

## 3. Configurar o `.env` (no LXC)

```bash
cd /opt/jatoba

# Cria o .env a partir do exemplo e abre para editar (Ctrl+O salva, Ctrl+X sai).
cp .env.example .env
nano .env

# Gera uma senha nova para o Postgres, se quiser (copie o resultado para POSTGRES_PASSWORD).
openssl rand -hex 24

# O .env tem senhas: só o root lê.
chmod 600 .env
```

Preencha com os valores da instalação atual:

- `JATOBA_ADMIN_USER` e `JATOBA_ADMIN_PASSWORD`: o mesmo login (ou um novo, se preferir);
- `POSTGRES_PASSWORD`: pode ser **uma nova**; o backup não depende dela;
- `JATOBA_BACKUP_RECIPIENT`: **a mesma chave pública**, para os backups antigos e novos abrirem com a mesma chave privada;
- Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`) e IA (`AI_PROVIDER`, `ANTHROPIC_API_KEY`): os mesmos;
- `JATOBA_PUBLIC_URL=https://jatoba.<sua-tailnet>.ts.net` (o endereço que o Tailscale vai dar; veja o passo 6; o nome da sua tailnet aparece no painel do Tailscale, em **DNS**).

> **Antes de subir o servidor, desligue o bot na instalação antiga** (passo 7). Dois Jatobás com o mesmo bot disputam as mensagens: o Telegram entrega cada uma para só um deles.

## 4. Subir e restaurar o backup

### 4.1. Subir o Jatobá (no LXC)

```bash
cd /opt/jatoba

# Constrói a imagem a partir do código e sobe app e banco em segundo plano.
# A primeira vez demora alguns minutos.
docker compose up -d --build

# Confere: app e postgres devem aparecer como "healthy".
docker compose ps

# Se algo não subir, as últimas linhas do log mostram o motivo.
docker compose logs app --tail 30
```

### 4.2. Levar o backup do seu computador até o LXC

Em dois saltos: do seu computador para o Proxmox, e do Proxmox para dentro do LXC (assim o LXC nem precisa de SSH).

No **PowerShell do seu computador** (na pasta do Jatobá antigo):

```powershell
# Copia o backup para a pasta /tmp do Proxmox (pede a senha do root do Proxmox).
scp backups\jatoba-AAAAMMDD-HHMMSS-manual.sql.age root@192.168.0.10:/tmp/
```

**No Proxmox**:

```bash
# Coloca o arquivo dentro do LXC 120, na pasta de backups, legível pelo Jatobá.
pct push 120 /tmp/jatoba-AAAAMMDD-HHMMSS-manual.sql.age \
  /opt/jatoba/backups/jatoba-AAAAMMDD-HHMMSS-manual.sql.age --perms 0644

# Apaga a cópia temporária do Proxmox.
rm /tmp/jatoba-AAAAMMDD-HHMMSS-manual.sql.age
```

### 4.3. Restaurar (no LXC)

```bash
cd /opt/jatoba

# Cria o arquivo temporário da chave privada: cole a linha AGE-SECRET-KEY-... e salve.
nano backups/chave-backup.txt

# Lista os backups: o que você trouxe deve aparecer aqui.
docker compose exec app jatoba list

# Restaura (troque pelo nome do seu backup). Antes, o Jatobá faz um backup de segurança do
# banco atual (ainda vazio). Com chave errada ou arquivo corrompido, nada muda.
docker compose exec app jatoba restore jatoba-AAAAMMDD-HHMMSS-manual.sql.age --chave chave-backup.txt --confirmar

# Reinicia o app para ele conferir o banco restaurado.
docker compose restart app

# Apaga a chave privada: ela não deve ficar no servidor.
rm backups/chave-backup.txt

# Confere: deve responder "status":"ok".
curl -s localhost:8080/health
```

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
3. **Settings → Keys → Generate auth key…**: gere a chave que o contêiner usa para entrar na tailnet:

   | Opção | Valor | Por quê |
   | --- | --- | --- |
   | Description | `jatoba` | Para reconhecer depois |
   | Reusable | desligado | Uso único: serve só para esta máquina |
   | Expiration | 1 dia | Ela é usada logo em seguida |
   | Ephemeral | **desligado** | Ligado, a máquina some da tailnet quando o contêiner reinicia |
   | Pre-approved | ligado | Dispensa aprovar o aparelho à mão, se a tailnet exigir aprovação |
   | Tags | ligado, `tag:jatoba` | A máquina entra com a tag que a política de acesso usa (a tag só aparece aqui depois de estar em `tagOwners`, item 2) |

   Copie a chave inteira (`tskey-auth-...`): ela só aparece uma vez. Cada chave serve para **uma tentativa**: se der erro antes do login, gere outra.
4. **Não ative o Funnel** para o Jatobá: ele publica o serviço na internet aberta.

## 6. Ligar o Tailscale (no LXC)

```bash
cd /opt/jatoba

# Acrescente no .env a chave do passo anterior: TS_AUTHKEY=tskey-auth-...
nano .env

# Sobe também o contêiner do Tailscale (o "perfil" tailscale do compose).
docker compose --profile tailscale up -d

# Confere: o log deve mostrar a entrada na tailnet, sem erros de autenticação.
docker compose logs tailscale --tail 20
```

O contêiner entra na tailnet como `jatoba` e serve a página em `https://jatoba.<sua-tailnet>.ts.net`. Abra esse endereço no celular (com o app do Tailscale ligado) e entre com o login.

Conferir e resolver problemas:

```bash
# Está logado? Deve mostrar um IP 100.x.y.z com o nome "jatoba".
docker compose exec tailscale tailscale --socket=/tmp/tailscaled.sock status

# As linhas que importam do log.
docker compose logs tailscale --tail 80 | grep -iE "authenticate|login|tag|cert|https|error|fail|Startup complete"

# Depois de trocar TS_AUTHKEY no .env, recrie o contêiner (um "up" simples não relê a variável).
docker compose --profile tailscale up -d --force-recreate tailscale
```

| No log | Causa | O que fazer |
| --- | --- | --- |
| `invalid key` | Chave já usada, expirada ou copiada pela metade | Gere outra (passo 5.3), troque no `.env` e recrie o contêiner |
| `requested tags ... not permitted` | `tag:jatoba` não está em `tagOwners` | Ajuste a política (passo 5.2) e gere outra chave |
| algo com `cert` ou `https` | HTTPS desligado na tailnet | Ligue **MagicDNS** e **HTTPS Certificates** (passo 5.1) |
| `To authenticate, visit: ...` | A chave não chegou ao contêiner (`TS_AUTHKEY` vazia) | Confira a linha no `.env` e recrie o contêiner |
| `failed to symlink socket: file exists` e `profile not found` | Avisos normais (reinício do contêiner; primeiro login) | Nada; procure outra linha com o erro de verdade |

Depois:

- no painel, abra a máquina `jatoba` e **desative Key expiry**, para o acesso não cair depois de alguns meses;
- apague `TS_AUTHKEY` do `.env`: o estado fica salvo no volume `tailscale-state`;
- daqui em diante, use sempre `--profile tailscale` nos comandos `docker compose up` (senão o Tailscale não sobe junto);
- a página continua aberta também em `http://localhost:8080` **dentro do LXC** (útil para `curl`), mas não na rede local nem na internet.

## 7. Desligar a instalação antiga

No **PowerShell do seu computador**, depois de conferir que o servidor está certo:

```powershell
# Para app e banco. Os dados continuam no volume do Docker, como reserva.
docker compose down
```

Se for manter a antiga por um tempo como reserva, comente `TELEGRAM_BOT_TOKEN` no `.env` dela, para o bot responder só pelo servidor, e não importe mais nada nela: os dados das duas não se juntam.

## Rotina no servidor

```bash
cd /opt/jatoba

# Atualizar o Jatobá: baixa o código novo e reconstrói (o backup automático roda antes de qualquer migração).
git pull && docker compose --profile tailscale up -d --build

# Ver o estado e os últimos logs.
docker compose --profile tailscale ps
docker compose logs app --tail 30

# Fazer um backup na hora e listar os existentes.
docker compose exec app jatoba backup
docker compose exec app jatoba list
```

- **Backups**: diários, automáticos, em `/opt/jatoba/backups/`. Copie alguns para fora do servidor de vez em quando (outro disco, nuvem); estão criptografados. Para trazer um para o seu computador, o caminho inverso: `pct pull 120 /opt/jatoba/backups/<arquivo> /tmp/<arquivo>` no Proxmox e `scp root@192.168.0.10:/tmp/<arquivo> .` no seu computador. No Proxmox, o backup do próprio LXC (vzdump) é uma camada extra.
- **Importar extratos**: pela página, do celular ou do computador, pelo endereço do Tailscale.
- Mais detalhes sobre atualizações: `docs/atualizar.md`.
