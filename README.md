# Jatobá Finance

**Every resource has a purpose.**

Finanças pessoais no seu próprio computador ou servidor. O Jatobá importa os extratos do banco (OFX) uma vez por mês, organiza os gastos por categoria e acompanha suas metas, como a reserva de emergência, a entrada de um imóvel ou uma viagem. Seus dados ficam com você: nada de senha de banco, nada de nuvem de terceiros.

> **Em desenvolvimento.** Antes da versão 1.0 pode haver mudanças incompatíveis. Veja o [roadmap](docs/roadmap.md).

## O que ele faz (e o que não faz)

- Importa extratos OFX e CSV, descarta duplicados e categoriza por regras que você aprova.
- Mostra para onde foi o dinheiro no mês e como as metas estão andando.
- Encontra assinaturas e gastos recorrentes.
- IA e bot do Telegram são opcionais e vêm desligados.
- **Não** se conecta ao seu banco, **não** faz pagamentos e **não** recomenda investimentos.

## Instalação

Você precisa do Docker: [Docker Desktop](https://docs.docker.com/desktop/) no Windows e no Mac, ou o Docker Engine no Linux. Roda em computadores Intel/AMD (amd64) e ARM (arm64), como Mac com chip Apple e Raspberry Pi 4 ou mais novo com sistema de 64 bits.

```bash
mkdir jatoba && cd jatoba
# baixe compose.yaml, .env.example e a pasta tailscale/ deste repositório
cp .env.example .env
```

Edite o `.env` e preencha `JATOBA_ADMIN_USER`, `JATOBA_ADMIN_PASSWORD` (14 caracteres ou mais) e `POSTGRES_PASSWORD` (só letras e números; gere com `openssl rand -hex 24`). Depois:

```bash
docker compose up -d --build
```

Para importar extratos, entre e use **Importar**: o OFX da conta ou o CSV da fatura do C6. Pode enviar períodos que se sobrepõem, porque o que já foi importado é ignorado.

Configure também os backups criptografados: são três passos, descritos em [docs/backup.md](docs/backup.md).

Abra http://localhost:8080 e entre com o usuário e a senha do `.env`. A página abre **só no próprio computador**. Depois de 5 senhas erradas seguidas, o login fica bloqueado por 15 minutos; para trocar a senha, edite o `.env` e rode `docker compose up -d` de novo. Para usar no celular, siga o guia de [acesso remoto com Tailscale](docs/acesso-remoto.md).

> Enquanto não houver uma versão publicada, o `--build` constrói a imagem a partir do código. Depois da primeira release, `docker compose up -d` baixa a imagem pronta.

## Documentação

| Assunto | Página |
| --- | --- |
| Backup e restauração | [docs/backup.md](docs/backup.md) |
| Acesso remoto seguro (Tailscale) | [docs/acesso-remoto.md](docs/acesso-remoto.md) |
| Atualizar para uma nova versão | [docs/atualizar.md](docs/atualizar.md) |
| Atualizar Docker, sistema e Postgres | [docs/ambiente.md](docs/ambiente.md) |
| Manutenção do projeto (dependências e releases) | [docs/manutencao.md](docs/manutencao.md) |
| Roadmap | [docs/roadmap.md](docs/roadmap.md) |
| Preparação (fase 0) | [docs/fase-0.md](docs/fase-0.md) |
| Segurança e como reportar falhas | [SECURITY.md](SECURITY.md) |
| Como contribuir | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Desenvolvimento

```bash
npm install
npm run build
npm test
```

Requer Node.js 26 ou mais novo.

## Licença

[AGPL-3.0](LICENSE). Você pode usar, estudar, modificar e redistribuir o Jatobá. Se oferecer uma versão modificada para outras pessoas usarem pela rede, precisa disponibilizar o código-fonte dessa versão.
