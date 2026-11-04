# Roadmap

Cada fase termina com algo que já funciona. Nenhuma tem prazo fixo: ela termina quando o critério de pronto é cumprido.

| Fase | Entregas | Pronto quando |
| --- | --- | --- |
| **0 · Preparação** | Extratos fictícios para testes; metas e categorias do autor; licença | Os extratos fictícios cobrem cartão, parcelas, Pix entre contas, estorno e pagamento de fatura |
| **1 · Fundação** | Monorepo, CI, Dockerfile multi-arquitetura, `compose.yaml` com Postgres, migrações, login pelo `.env`, saúde, backup e restauração | `docker compose up -d` sobe do zero em Linux, Windows e Mac, e o login funciona |
| **2 · Importação** | Leitores de OFX e CSV, perfis de banco, limpeza, duplicados, regras, tela de revisão | Três meses importam sem duplicados e sem gasto contado duas vezes |
| **3 · Telas** | Mês, Metas, Lançamentos, Assinaturas, Ajustes | Fechar um mês leva menos de 20 minutos |
| **4 · Automação** | Bot opcional, agendamentos, IA opcional (Anthropic e Ollama) | Tudo funciona com o bot e a IA desligados |
| **5 · Uso real** | Um mês de uso; perfil Tailscale; proteções da página; testes de restauração e de atualização | Restaurar e atualizar funcionam seguindo só a documentação |
| **6 · Versão 1.0** | Documentação completa, release automática, Renovate | Alguém de fora instala seguindo só o README |
| **7 · V2 e V3** | Viagens, notas fiscais, lançamentos avulsos, 2FA; depois investimentos, observações mensais e simulações | Cada item entra depois de o anterior ser usado por um mês |

As fases 1 a 5 publicam versões `0.x` (a `0.1` ao fim da fase 2). A `1.0` marca a fase 6.

## Estado atual

- [x] Estrutura inicial do repositório
- [x] Extratos fictícios de teste
- [ ] Metas e categorias do autor (fora do repositório)
- [x] Licença escolhida (AGPL-3.0)
- [x] Fase 1: migrações do banco e login pelo `.env`
- [x] Fase 1: backup e restauração criptografados
- [x] Fase 1: imagem multi-arquitetura (amd64 e arm64)
- [x] Fase 2: leitor de OFX (1.x e 2.x, conta e cartão)
- [x] Fase 2: leitor de CSV e fatura do C6
- [x] Fase 2: importação pela página, sem duplicados, e lista de lançamentos
- [x] Fase 2: limpeza das descrições, regras de categoria e tela de revisão
- [ ] Fase 2: CSV da Wise e perfil do Banco do Brasil (em espera)
- [x] Fase 2: três meses importados sem duplicados e sem gasto contado duas vezes (critério de pronto; agosto a outubro, conta e cartão)
- [x] Fase 3: compras do cartão entram no mês de vencimento da fatura (decisão do autor)
- [x] Fase 3: tela do Mês e filtros em Lançamentos
- [x] Fase 3: Ajustes (categorias, regras e contas)
- [x] Fase 3: Metas
- [x] Fase 3: Assinaturas
- [ ] Fase 3: critério de pronto — fechar um mês em menos de 20 minutos (com uso real)
