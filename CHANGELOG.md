# Changelog

Todas as mudanças relevantes ficam registradas aqui. O projeto segue o [versionamento semântico](https://semver.org/lang/pt-BR/).

Cada versão tem as seções **Novidades**, **Correções**, **Segurança** e, quando houver, **Mudanças incompatíveis**, sempre com o passo a passo para atualizar.

## [Não publicado]

### Novidades

- Estrutura inicial do repositório: monorepo com `packages/core` e `packages/web`.
- `compose.yaml` com a aplicação, o Postgres e o perfil opcional do Tailscale.
- Validação da configuração na partida: usuário e senha obrigatórios no `.env`, senha com 14 caracteres ou mais e diferente da senha de exemplo.
- Página provisória e verificação de saúde em `/health`.
- Extratos OFX fictícios para testes.
- Licença AGPL-3.0.
- Login com o usuário e a senha do `.env`. A sessão dura 30 dias, e o botão **Sair** a encerra.
- Migrações do banco na partida, numa única transação: se uma falhar, nada muda e a aplicação não sobe.
- `/health` também verifica o banco de dados.
- Backups criptografados com `age`: `jatoba backup`, `jatoba list`, `jatoba restore` e `jatoba keygen`. Há backup automático antes de migrações e de restaurações. Veja `docs/backup.md`.
- Leitor de OFX 1.x e 2.x (conta e cartão, Windows-1252 e UTF-8). `jatoba check <arquivo>` confere um extrato mostrando só um resumo, sem descrições nem valores.
- Leitor da fatura do cartão C6 em CSV: parcelas, vários cartões, compras em dólar com cotação. `jatoba check` também confere CSV, mostrando só os formatos encontrados.
- Página **Importar**: envie o OFX da conta ou o CSV da fatura do C6. Duplicados são ignorados, inclusive em períodos que se sobrepõem e em reenvios do mesmo arquivo.
- Página **Lançamentos** com tudo o que foi importado, e menu de navegação.
- Categorias (despesas, receitas e movimentações, que não contam como gasto) e página **Revisar**: cada lançamento chega com uma sugestão, vinda das suas regras, das regras do sistema (fatura, investimentos, salário, tarifas) ou da categoria do C6. Você confirma ou corrige; com “usar sempre”, a correção vira regra para os parecidos. Categoria escolhida à mão nunca é sobrescrita.
- Página de cada **lançamento** (clique na descrição em Lançamentos): todos os detalhes, trocar a categoria a qualquer momento (também depois de revisado, com opção de criar regra) e “voltar para revisão”.
- Página **Assinaturas**: encontra sozinha os gastos que se repetem por volta de uma vez por mês (mesmo estabelecimento e conta, valor parecido), com total por mês e por ano, aviso de reajuste, próxima cobrança prevista e as que pararam. Parcelas e estornos ficam de fora; “não é assinatura” tira da lista.
- O leitor de OFX reconhece parcelas escritas no texto (“PARC 03/10”).
- Página **Metas**: valor alvo, prazo opcional e quanto já está guardado. O progresso soma o que você registra (guardei/retirei) e os aportes e resgates do extrato ligados a cada meta. Com prazo, mostra quanto guardar por mês e se você está no ritmo (média dos últimos 3 meses); sem prazo, em quantos meses chega. Metas podem ser arquivadas.
- Página **Ajustes**: criar, renomear, mudar o tipo e apagar categorias (movendo lançamentos e regras para outra, ou devolvendo-os à revisão); ver, criar, editar e apagar regras, com quantos lançamentos cada uma classifica; renomear contas. Mudanças refazem as sugestões na hora, sem tocar no que foi escolhido à mão ou revisado.
- Tela do **Mês**: entradas, saídas e saldo; para onde foi o dinheiro por categoria, com fatia, barra e comparação com a média dos 3 meses anteriores; movimentações à parte (não contam como gasto); aviso de mês incompleto quando falta o extrato de uma conta. Cada categoria leva aos seus lançamentos.
- **Lançamentos** filtra por mês e por categoria (inclusive “sem categoria”).
- **Mês de competência**: compras do cartão do C6 entram no mês de vencimento da fatura (o mesmo do nome do arquivo, como `c6-202611-fatura.csv`), e lançamentos da conta no mês da data. Resolve parcelas que o C6 mostra com a mesma data em faturas diferentes. Em **Lançamentos**, cada compra do cartão mostra a fatura.
- **Estornos** herdam a categoria da compra devolvida (mesmo valor, mesma conta, até 60 dias antes). Exemplo: a devolução mensal da anuidade do C6 anula a cobrança em “Impostos e taxas”.
- **Possíveis duplicados**: lançamento novo com mesma conta, data e valor de um já existente, mas texto diferente, aparece em Revisar para você decidir (“é o mesmo” ou “são diferentes”). A cópia descartada fica guardada e não volta em novas importações.
- Paginação em **Lançamentos**, com 50 por página.
- Descrições limpas para exibir, sem prefixos como “PIX ENVIADO” e “COMPRA CARTAO DEBITO”; a original continua guardada.
- Imagem Docker para amd64 e arm64 (Mac com chip Apple, Raspberry Pi 4 ou mais novo).

### Correções

- Sinal dos valores da fatura do C6 fixo (compras positivas, confirmado com faturas reais), em vez de decidido pela maioria das linhas, que erraria numa fatura curta com mais estornos que compras.
- Duplicados em importações com períodos sobrepostos no C6, que gera FITIDs novos a cada exportação. Agora os duplicados são reconhecidos pelo conteúdo (data, valor, descrição e ocorrência), e a migração 0003 remove as cópias que já tinham entrado, mantendo sempre a primeira.

### Segurança

- Node.js 26 (LTS) na imagem Docker, no CI e como versão mínima (`engines`).
- Dependências atualizadas para fechar alertas do `npm audit`: `zod` 4, `@hono/node-server` 2 e `vitest` 5.
- Senha guardada só como hash (scrypt), sessões guardadas só como hash do token, proteção contra CSRF e bloqueio depois de 5 senhas erradas.
- Do número da conta, o banco guarda só os 4 últimos dígitos e um hash.
- Backups criptografados com chave pública: o servidor cria backups, mas só a chave privada, guardada fora dele, consegue abri-los. A restauração é atômica: com chave errada ou arquivo corrompido, nada muda.
