# Acesso remoto com Tailscale

Por padrão, o Jatobá abre só no próprio computador (`http://localhost:8080`). Para usar no celular ou em outro computador, use uma rede privada. **Nunca abra uma porta no roteador para o Jatobá.**

Mesmo pela rede privada, o usuário e a senha do `.env` continuam obrigatórios: o Tailscale decide quem chega até a página, e o login decide quem entra.

## Antes de tudo, no painel do Tailscale

1. Em **DNS**, ligue **MagicDNS** e **HTTPS Certificates**.
2. Em **Access controls**, garanta que só você acessa o Jatobá. Se a política ainda for a padrão, que libera tudo, qualquer aparelho da sua rede alcança a página. Exemplo:

```json
"tagOwners": { "tag:jatoba": ["autogroup:admin"] },
"acls": [
  { "action": "accept", "src": ["seu-email@exemplo.com"], "dst": ["tag:jatoba:443"] }
]
```

3. **Não ative o Funnel** para o Jatobá. O Funnel publica o serviço na internet aberta.

## Opção A: Tailscale já instalado no computador

Funciona em Linux, Windows e Mac:

```bash
tailscale serve --bg 8080
tailscale serve status
```

O endereço aparece no `status`, no formato `https://<nome-do-computador>.<sua-tailnet>.ts.net`.

## Opção B: Tailscale em contêiner (perfil do compose)

Não precisa instalar nada no sistema.

1. No painel do Tailscale, em **Settings → Keys**, gere uma chave de autenticação de uso único, com a tag `tag:jatoba`.
2. No `.env`:

```
TS_AUTHKEY=tskey-auth-...
JATOBA_PUBLIC_URL=https://jatoba.<sua-tailnet>.ts.net
```

3. Suba com o perfil:

```bash
docker compose --profile tailscale up -d
```

O contêiner entra na sua rede como `jatoba` e serve a página em `https://jatoba.<sua-tailnet>.ts.net`. Depois do primeiro acesso, a chave pode ser apagada do `.env`: o estado fica salvo no volume `tailscale-state`.

## Para servidores

No painel, abra a máquina `jatoba` e desative **Key expiry**, ou programe a renovação, para o acesso não cair sem aviso.
