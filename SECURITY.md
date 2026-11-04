# Segurança

O Jatobá guarda dados financeiros pessoais. Levamos falhas de segurança a sério.

## Como reportar uma falha

**Não abra uma issue pública.** Use o botão **Report a vulnerability** na aba **Security** deste repositório (GitHub Security Advisories). Descreva:

- o que acontece e como reproduzir;
- a versão do Jatobá e o sistema onde você roda;
- o impacto que você imagina.

Respondemos assim que possível e combinamos com você quando publicar a correção.

## Versões com correções de segurança

Antes da 1.0, só a versão mais recente recebe correções. Depois da 1.0, a versão maior atual recebe correções de segurança.

## Princípios de segurança do projeto

- O Jatobá nunca pede senha de banco e nunca move dinheiro.
- Por padrão, a página só abre no próprio computador (`127.0.0.1`).
- Acesso remoto só por rede privada (Tailscale ou WireGuard). Não exponha o Jatobá na internet.
- Usuário e senha obrigatórios; a senha é guardada como hash.
- IA e bot do Telegram vêm desligados. O bot só lê, só responde aos chats autorizados e não envia descrições completas, números de conta nem extratos. A IA, quando ligada, envia só a descrição limpa, a direção e o tipo de conta dos lançamentos sem sugestão; valores, datas e contas não.
- Backups saem criptografados.
