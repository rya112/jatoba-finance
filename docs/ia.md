# IA para sugerir categorias (opcional)

Quando nenhuma regra, categoria do banco ou estorno classifica um lançamento, a IA pode sugerir uma categoria. A sugestão aparece na **Revisar** como “sugerido pela IA” e, como toda sugestão, só vale depois que você salva ou aprova. Vem desligada.

## O que é enviado

Para a API da Anthropic vão só: a **descrição limpa** do lançamento (por exemplo, `PADARIA EXEMPLO`), se é **entrada ou saída**, se é **conta ou cartão**, e a **sua lista de categorias**. **Não** vão valores, datas, nomes de conta, números de cartão nem arquivos de extrato.

Cada estabelecimento é perguntado **uma vez**: a resposta fica guardada no seu banco e serve para os próximos lançamentos iguais. Quando a descrição não dá pista (um Pix para uma pessoa, por exemplo), a IA responde que não sabe em vez de chutar.

## Custo

Usa o **Claude Haiku 5.5** (`claude-haiku-5-5`), o modelo mais barato, com raciocínio curto. Cada lote de até 60 estabelecimentos custa uma fração de centavo de dólar; o log mostra o custo aproximado de cada execução (`docker compose logs app | grep IA`). O uso é cobrado na sua conta da Anthropic.

## Ligar

1. Crie uma chave de API em **console.anthropic.com → API Keys** (precisa de créditos na conta). A chave começa com `sk-ant-`; copie-a inteira, sem aspas nem espaços.
2. No `.env`:

   ```
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. `docker compose up -d`. Uns segundos depois de subir, a IA sugere para o que estiver sem sugestão; depois, roda sozinha a cada importação. Na **Revisar** há também o botão **Sugerir com IA**.

Opcional: `ANTHROPIC_MODEL` troca o modelo (padrão `claude-haiku-5-5`).

A chave é uma senha: fica só no `.env`, que não vai para o Git. Se ela for recusada, a IA se desliga e a Revisar mostra o motivo.

## Desligar

`AI_PROVIDER=none` (ou apague a linha) e `docker compose up -d`. As sugestões já feitas continuam até você revisá-las.
