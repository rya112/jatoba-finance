import { formatMoney, normalizeText, type Category, type ImportOutcome, type ReviewRow, type TransactionRow } from "@jatoba/core";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

type Section = "inicio" | "importar" | "revisar" | "lancamentos";

const NAV: { id: Section; href: string; label: string }[] = [
  { id: "inicio", href: "/", label: "Início" },
  { id: "importar", href: "/importar", label: "Importar" },
  { id: "revisar", href: "/revisar", label: "Revisar" },
  { id: "lancamentos", href: "/lancamentos", label: "Lançamentos" },
];

function layout(title: string, body: string, opts: { section?: Section; wide?: boolean } = {}): string {
  const nav = opts.section
    ? `<header class="topo">
    <a class="marca" href="/"><span class="anel pequeno" aria-hidden="true"></span>Jatobá</a>
    <nav aria-label="Principal">${NAV.map(
      (item) => `<a href="${item.href}"${item.id === opts.section ? ' aria-current="page"' : ""}>${item.label}</a>`,
    ).join("")}</nav>
    <form method="post" action="/sair"><button class="discreto" type="submit">Sair</button></form>
  </header>`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --fundo: #fbfaf8; --texto: #22201d; --suave: #6b655d; --cerne: #8a3b22; --linha: #e6e1d9;
    --campo: #ffffff; --erro: #a12b1b; --entrada: #2f6b3a; --painel: #f3f0eb;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fundo: #171412; --texto: #ece7e1; --suave: #a59d93; --cerne: #d27a5c; --linha: #2e2925;
      --campo: #201c19; --erro: #f08a76; --entrada: #8fcf98; --painel: #1f1b18; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fundo); color: var(--texto);
    font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 18vh 1.5rem 4rem; }
  main.com-topo { padding-top: 2.5rem; }
  main.largo { max-width: 60rem; }
  h1 { font-size: clamp(2rem, 7vw, 3rem); line-height: 1.1; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; }
  a { color: var(--cerne); }
  .anel { width: 3.5rem; height: 3.5rem; border-radius: 50%; margin-bottom: 1.5rem; display: inline-block;
    background: radial-gradient(circle, var(--cerne) 0 18%, transparent 19% 34%, var(--cerne) 35% 42%, transparent 43% 58%, var(--cerne) 59% 64%, transparent 65%); }
  .anel.pequeno { width: 1.4rem; height: 1.4rem; margin: 0 0.5rem 0 0; vertical-align: -0.3rem; }
  .topo { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; padding: 0.75rem 1.5rem;
    border-bottom: 1px solid var(--linha); }
  .topo .marca { font-weight: 650; color: var(--texto); text-decoration: none; }
  .topo nav { display: flex; gap: 1rem; flex: 1; flex-wrap: wrap; }
  .topo nav a { color: var(--suave); text-decoration: none; }
  .topo nav a[aria-current="page"] { color: var(--texto); font-weight: 600; text-decoration: underline; text-underline-offset: 0.3rem; }
  p { margin: 1rem 0 0; }
  .suave { color: var(--suave); font-size: 0.95rem; }
  .rodape { border-top: 1px solid var(--linha); padding-top: 1rem; margin-top: 2rem; }
  form.entrar, form.importar { margin-top: 2rem; display: grid; gap: 1rem; max-width: 26rem; }
  label { display: grid; gap: 0.3rem; font-size: 0.95rem; color: var(--suave); }
  input { font: inherit; color: var(--texto); background: var(--campo); border: 1px solid var(--linha);
    border-radius: 0.5rem; padding: 0.6rem 0.75rem; max-width: 100%; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--cerne); outline-offset: 2px; }
  button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 0.5rem; padding: 0.6rem 1rem;
    border: 1px solid var(--cerne); background: var(--cerne); color: var(--fundo); justify-self: start; }
  button.discreto { background: transparent; color: var(--suave); border-color: var(--linha); font-weight: 500; padding: 0.3rem 0.8rem; }
  .erro { color: var(--erro); margin: 0; }
  .painel { background: var(--painel); border: 1px solid var(--linha); border-radius: 0.75rem; padding: 1rem 1.25rem; margin-top: 1.5rem; }
  .painel p:first-child { margin-top: 0; }
  .tabela { width: 100%; overflow-x: auto; margin-top: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--linha); vertical-align: top; }
  th { color: var(--suave); font-weight: 500; }
  td.valor, th.valor { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.data { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .entrada { color: var(--entrada); }
  .cartoes { list-style: none; padding: 0; margin: 1rem 0 0; display: grid; gap: 0.75rem; }
  .cartao { border: 1px solid var(--linha); border-radius: 0.75rem; padding: 0.9rem 1rem; }
  .cartao .cabeca { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
  .cartao .descricao { font-weight: 600; overflow-wrap: anywhere; }
  .cartao .original { color: var(--suave); font-size: 0.85rem; overflow-wrap: anywhere; }
  .cartao form { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-top: 0.6rem; }
  .cartao select { font: inherit; color: var(--texto); background: var(--campo); border: 1px solid var(--linha); border-radius: 0.5rem; padding: 0.45rem 0.6rem; max-width: 100%; }
  .cartao .regra { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; font-size: 0.9rem; color: var(--suave); width: 100%; }
  .cartao .regra input[type=text] { padding: 0.35rem 0.5rem; font-size: 0.9rem; min-width: 10rem; flex: 1; }
  .sugestao { font-size: 0.85rem; color: var(--suave); }
  .sem-sugestao { border-left: 3px solid var(--cerne); }
  .paginas { display: flex; gap: 0.5rem 1rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; font-size: 0.95rem; }
  .paginas a { text-decoration: none; }
  .paginas a:hover { text-decoration: underline; }
  .paginas .desligado { color: var(--suave); opacity: 0.6; }
  .paginas [aria-current] { font-weight: 600; }
  .etiqueta { display: inline-block; font-size: 0.8rem; color: var(--suave); border: 1px solid var(--linha); border-radius: 1rem; padding: 0 0.5rem; margin-left: 0.4rem; }
</style>
</head>
<body>
${nav}
<main class="${[opts.section ? "com-topo" : "", opts.wide ? "largo" : ""].join(" ").trim()}">
${opts.section ? "" : '  <div class="anel" aria-hidden="true"></div>\n'}${body}
</main>
</body>
</html>`;
}

/** "2026-10-05" → "05/10/2026". */
function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function homePage(version: string, transactionCount: number, pendingReview = 0): string {
  return layout(
    "Jatobá Finance",
    `  <h1>Jatobá Finance</h1>
  <p>Every resource has a purpose.</p>
  ${
    transactionCount === 0
      ? `<p>Nenhum lançamento ainda. Comece <a href="/importar">importando um extrato</a> (OFX da conta ou CSV da fatura do C6).</p>`
      : `<p>${transactionCount.toLocaleString("pt-BR")} lançamento(s) importado(s). <a href="/lancamentos">Ver lançamentos</a> ou <a href="/importar">importar mais</a>.</p>${
          pendingReview > 0 ? `<p><a href="/revisar">${pendingReview.toLocaleString("pt-BR")} lançamento(s) para revisar</a>.</p>` : ""
        }`
  }
  <p class="suave">As telas do mês e das metas chegam nas próximas versões.</p>
  <p class="suave rodape">Versão ${escapeHtml(version)}</p>`,
    { section: "inicio" },
  );
}

export function loginPage(error?: string): string {
  return layout(
    "Entrar · Jatobá Finance",
    `  <h1>Jatobá Finance</h1>
  <form class="entrar" method="post" action="/entrar">
    ${error ? `<p class="erro" role="alert">${escapeHtml(error)}</p>` : ""}
    <label>Usuário
      <input name="usuario" autocomplete="username" required autofocus>
    </label>
    <label>Senha
      <input name="senha" type="password" autocomplete="current-password" required>
    </label>
    <button type="submit">Entrar</button>
  </form>`,
  );
}

function importResult(outcome: ImportOutcome): string {
  const repeated = outcome.previouslyImportedAt
    ? `<p>Este mesmo arquivo já tinha sido importado em ${outcome.previouslyImportedAt.toLocaleDateString("pt-BR")}. Nada foi duplicado.</p>`
    : "";
  const items = outcome.statements
    .map((s) => {
      const period = s.firstDate && s.lastDate ? ` de ${brDate(s.firstDate)} a ${brDate(s.lastDate)}` : "";
      return `<li><strong>${escapeHtml(s.accountName)}</strong>${period}: ${s.inserted} novo(s)${
        s.duplicates ? `, ${s.duplicates} já existia(m) e foi(ram) ignorado(s)` : ""
      }.</li>`;
    })
    .join("");
  const warnings = outcome.warnings.length
    ? `<p class="suave">Avisos:</p><ul class="suave">${outcome.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
    : "";
  return `<div class="painel" role="status">
    <p><strong>${escapeHtml(outcome.fileName)}</strong> importado.</p>
    ${repeated}<ul>${items}</ul>${warnings}
    <p><a href="/lancamentos">Ver lançamentos</a></p>
  </div>`;
}

export function importPage(opts: { outcome?: ImportOutcome; error?: string } = {}): string {
  return layout(
    "Importar · Jatobá Finance",
    `  <h1>Importar extrato</h1>
  <p>Envie o <strong>OFX</strong> da conta ou o <strong>CSV</strong> da fatura do C6. Pode enviar períodos que se sobrepõem: o que já foi importado é ignorado.</p>
  ${opts.error ? `<div class="painel"><p class="erro" role="alert">${escapeHtml(opts.error)}</p></div>` : ""}
  ${opts.outcome ? importResult(opts.outcome) : ""}
  <form class="importar" method="post" action="/importar" enctype="multipart/form-data">
    <label>Arquivo (até 10 MB)
      <input type="file" name="arquivo" accept=".ofx,.csv,.txt" required>
    </label>
    <button type="submit">Importar</button>
  </form>
  <p class="suave">O arquivo é lido e descartado; só os lançamentos ficam guardados no seu banco de dados.</p>`,
    { section: "importar" },
  );
}

/** Navegação entre páginas: primeira, anterior, "página X de Y", próxima, última. */
function pagination(page: number, pages: number): string {
  if (pages <= 1) return "";
  const link = (target: number, label: string, rel?: string) =>
    `<a href="/lancamentos?pagina=${target}"${rel ? ` rel="${rel}"` : ""}>${label}</a>`;
  const off = (label: string) => `<span class="desligado" aria-disabled="true">${label}</span>`;
  return `<nav class="paginas" aria-label="Páginas">
    ${page > 1 ? link(1, "« Primeira") : off("« Primeira")}
    ${page > 1 ? link(page - 1, "‹ Anterior", "prev") : off("‹ Anterior")}
    <span aria-current="page">Página ${page} de ${pages}</span>
    ${page < pages ? link(page + 1, "Próxima ›", "next") : off("Próxima ›")}
    ${page < pages ? link(pages, "Última »") : off("Última »")}
  </nav>`;
}

export function transactionsPage(
  rows: TransactionRow[],
  total: number,
  paging: { page: number; pages: number; pageSize: number } = { page: 1, pages: 1, pageSize: rows.length },
): string {
  if (total === 0) {
    return layout(
      "Lançamentos · Jatobá Finance",
      `  <h1>Lançamentos</h1>
  <p>Nenhum lançamento ainda. <a href="/importar">Importe um extrato</a> para começar.</p>`,
      { section: "lancamentos" },
    );
  }
  const body = rows
    .map((r) => {
      const tags = [r.installment ? `parcela ${r.installment}` : "", r.cardLast4 ? `cartão ${r.cardLast4}` : ""]
        .filter(Boolean)
        .map((t) => `<span class="etiqueta">${escapeHtml(t)}</span>`)
        .join("");
      return `<tr>
        <td class="data">${brDate(r.date)}</td>
        <td>${escapeHtml(r.cleanDescription ?? r.description)}${tags}</td>
        <td class="suave">${r.categoryName ? escapeHtml(r.categoryName) + (r.reviewed ? "" : ' <span class="etiqueta">sugerida</span>') : "—"}</td>
        <td class="suave">${escapeHtml(r.accountName)}</td>
        <td class="valor${r.amount > 0 ? " entrada" : ""}">${escapeHtml(formatMoney(r.amount, "pt-BR", r.currency))}</td>
      </tr>`;
    })
    .join("");
  return layout(
    "Lançamentos · Jatobá Finance",
    `  <h1>Lançamentos</h1>
  <p class="suave">${total.toLocaleString("pt-BR")} lançamento(s)${
      paging.pages > 1
        ? `, mostrando de ${((paging.page - 1) * paging.pageSize + 1).toLocaleString("pt-BR")} a ${((paging.page - 1) * paging.pageSize + rows.length).toLocaleString("pt-BR")}`
        : ""
    }, do mais recente para o mais antigo. Entradas em verde; saídas negativas.</p>
  ${pagination(paging.page, paging.pages)}
  <div class="tabela"><table>
    <thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Categoria</th><th scope="col">Conta</th><th scope="col" class="valor">Valor</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  ${pagination(paging.page, paging.pages)}`,
    { section: "lancamentos", wide: true },
  );
}

const KIND_LABEL: Record<Category["kind"], string> = {
  despesa: "Despesas",
  receita: "Receitas",
  movimentacao: "Movimentações (não contam como gasto)",
};

function categorySelect(categories: Category[], selected: number | null): string {
  const groups = (["despesa", "receita", "movimentacao"] as const)
    .map((kind) => {
      const options = categories
        .filter((c) => c.kind === kind)
        .map((c) => `<option value="${c.id}"${c.id === selected ? " selected" : ""}>${escapeHtml(c.name)}</option>`)
        .join("");
      return `<optgroup label="${KIND_LABEL[kind]}">${options}</optgroup>`;
    })
    .join("");
  const placeholder = selected === null ? '<option value="" selected>Escolha a categoria</option>' : "";
  return `<select name="categoria" required aria-label="Categoria">${placeholder}${groups}</select>`;
}

function suggestionNote(r: ReviewRow, categories: Category[]): string {
  if (r.categoryId === null) return '<span class="sugestao">Sem sugestão.</span>';
  const name = categories.find((c) => c.id === r.categoryId)?.name ?? "";
  if (r.categorySource === "regra") {
    return `<span class="sugestao">Sugerido: ${escapeHtml(name)}, pela regra “${escapeHtml(r.rulePattern ?? "")}”.</span>`;
  }
  return `<span class="sugestao">Sugerido: ${escapeHtml(name)}, pela categoria do banco (${escapeHtml(r.bankCategory ?? "")}).</span>`;
}

export function reviewPage(opts: {
  rows: ReviewRow[];
  total: number;
  withSuggestion: number;
  categories: Category[];
  message?: string;
  error?: string;
}): string {
  const { rows, total, withSuggestion, categories } = opts;
  const flash = [
    opts.message ? `<div class="painel" role="status"><p>${escapeHtml(opts.message)}</p></div>` : "",
    opts.error ? `<div class="painel"><p class="erro" role="alert">${escapeHtml(opts.error)}</p></div>` : "",
  ].join("");

  if (total === 0) {
    return layout(
      "Revisar · Jatobá Finance",
      `  <h1>Revisar</h1>${flash}
  <p>Tudo revisado. Quando importar novos extratos, os lançamentos aparecem aqui.</p>`,
      { section: "revisar" },
    );
  }

  const suggestedHere = rows.filter((r) => r.categoryId !== null).map((r) => r.id);
  const approveAll = suggestedHere.length
    ? `<form method="post" action="/revisar/aprovar">${suggestedHere
        .map((id) => `<input type="hidden" name="id" value="${escapeHtml(id)}">`)
        .join("")}<button type="submit">Aprovar as ${suggestedHere.length} sugestões desta página</button></form>`
    : "";

  const cards = rows
    .map((r) => {
      const showOriginal = normalizeText(r.cleanDescription) !== normalizeText(r.description);
      const tags = r.installment ? `<span class="etiqueta">parcela ${escapeHtml(r.installment)}</span>` : "";
      return `<li class="cartao${r.categoryId === null ? " sem-sugestao" : ""}">
      <div class="cabeca">
        <span class="descricao">${escapeHtml(r.cleanDescription)}${tags}</span>
        <span class="valor${r.amount > 0 ? " entrada" : ""}">${escapeHtml(formatMoney(r.amount, "pt-BR", r.currency))}</span>
      </div>
      <div class="original">${brDate(r.date)} · ${escapeHtml(r.accountName)}${showOriginal ? ` · original: ${escapeHtml(r.description)}` : ""}</div>
      <form method="post" action="/revisar/${escapeHtml(r.id)}">
        ${categorySelect(categories, r.categoryId)}
        <button type="submit">Salvar</button>
        ${suggestionNote(r, categories)}
        <label class="regra"><input type="checkbox" name="criar_regra" value="1"> Usar sempre que a descrição contiver
          <input type="text" name="regra" value="${escapeHtml(normalizeText(r.cleanDescription))}" aria-label="Texto da regra"></label>
      </form>
    </li>`;
    })
    .join("");

  const more = rows.length < total
    ? `<p class="suave">Mostrando ${rows.length} de ${total.toLocaleString("pt-BR")}. Salve ou aprove estes para ver os próximos.</p>`
    : "";
  return layout(
    "Revisar · Jatobá Finance",
    `  <h1>Revisar</h1>${flash}
  <p>${total.toLocaleString("pt-BR")} lançamento(s) para revisar, ${withSuggestion.toLocaleString("pt-BR")} com sugestão. Os sem sugestão aparecem primeiro.</p>
  <p class="suave">Confira a categoria e salve. Marque “usar sempre” para criar uma regra: ela vale para todos os lançamentos parecidos, inclusive os próximos.</p>
  ${approveAll}
  <ul class="cartoes">${cards}</ul>
  ${more}`,
    { section: "revisar", wide: true },
  );
}
