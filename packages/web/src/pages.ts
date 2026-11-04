import type { BackupStatus } from "./scheduler.js";
import { formatMoney, normalizeText, type AccountInfo, type GoalEntry, type GoalProgress, type InvestmentTransaction, type Subscription, type SubscriptionList, type TransactionDetail, type Category, type CategoryUsage, type RuleDetail, type CategoryTotal, type MonthSummary, type ImportOutcome, type ReviewRow, type SuspectPair, type TransactionRow } from "@jatoba/core";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

type Section = "inicio" | "mes" | "metas" | "assinaturas" | "importar" | "revisar" | "lancamentos" | "ajustes";

const NAV: { id: Section; href: string; label: string }[] = [
  { id: "inicio", href: "/", label: "Início" },
  { id: "mes", href: "/mes", label: "Mês" },
  { id: "metas", href: "/metas", label: "Metas" },
  { id: "assinaturas", href: "/assinaturas", label: "Assinaturas" },
  { id: "importar", href: "/importar", label: "Importar" },
  { id: "revisar", href: "/revisar", label: "Revisar" },
  { id: "lancamentos", href: "/lancamentos", label: "Lançamentos" },
  { id: "ajustes", href: "/ajustes", label: "Ajustes" },
];

function layout(title: string, body: string, opts: { section?: Section; wide?: boolean } = {}): string {
  const nav = opts.section
    ? `<header class="topo">
    <a class="marca" href="/"><img class="anel pequeno" src="/icone.svg" alt="" width="22" height="22">Jatobá</a>
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
<link rel="icon" href="/icone.svg" type="image/svg+xml">
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
  .anel { width: 3.5rem; height: 3.5rem; margin-bottom: 1.5rem; display: block; }
  .anel.pequeno { width: 1.4rem; height: 1.4rem; margin: 0 0.5rem 0 0; display: inline-block; vertical-align: -0.3rem; }
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
  .duplicado { border-color: var(--cerne); }
  .duplicado .lados { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
  .duplicado .lado { background: var(--painel); border-radius: 0.5rem; padding: 0.5rem 0.75rem; overflow-wrap: anywhere; }
  .duplicado .lado small { display: block; color: var(--suave); }
  .duplicado form { display: inline-flex; margin: 0.6rem 0.6rem 0 0; }
  .resumo { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem; margin-top: 1.25rem; }
  .caixa { border: 1px solid var(--linha); border-radius: 0.75rem; padding: 0.8rem 1rem; display: grid; gap: 0.2rem; }
  .caixa strong { font-size: 1.35rem; font-variant-numeric: tabular-nums; }
  table.categorias td:first-child { min-width: 12rem; }
  .barra-celula { width: 30%; min-width: 4rem; }
  .barra { display: block; height: 0.55rem; border-radius: 1rem; background: var(--cerne); opacity: 0.75; }
  .atencao td { background: var(--painel); }
  .melhor { color: var(--entrada); }
  .pior { color: var(--erro); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .filtro { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  h3 { font-size: 1rem; margin: 1.25rem 0 0.25rem; color: var(--suave); font-weight: 600; }
  .lista-ajustes { list-style: none; padding: 0; margin: 0.5rem 0 0; border-top: 1px solid var(--linha); }
  .lista-ajustes > li { border-bottom: 1px solid var(--linha); padding: 0.5rem 0; }
  .lista-ajustes summary { cursor: pointer; overflow-wrap: anywhere; }
  .linha-form { display: flex; gap: 0.5rem 0.75rem; flex-wrap: wrap; align-items: end; margin: 0.6rem 0; }
  .linha-form label { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .linha-form select, .linha-form input[type=text] { font: inherit; color: var(--texto); background: var(--campo); border: 1px solid var(--linha); border-radius: 0.5rem; padding: 0.4rem 0.6rem; max-width: 100%; }
  .meta .progresso { height: 0.7rem; border-radius: 1rem; background: var(--painel); border: 1px solid var(--linha); overflow: hidden; margin-top: 0.6rem; }
  .meta .progresso span { display: block; height: 100%; background: var(--entrada); }
  .meta p { margin: 0.5rem 0 0; }
  .historico { list-style: none; padding: 0; margin: 0.5rem 0; display: grid; gap: 0.25rem; font-size: 0.95rem; }
  .historico li { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .historico form { display: inline; }
  a.discreta { color: inherit; text-decoration: none; }
  a.discreta:hover, a.discreta:focus-visible { text-decoration: underline; }
  table.detalhes th { width: 12rem; font-weight: 500; }
  .salvar-todos { margin: 1rem 0; }
  .chips { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 1rem 0 0.5rem; }
  .chip { border: 1px solid var(--linha); border-radius: 1rem; padding: 0.2rem 0.75rem; text-decoration: none; color: var(--suave); font-size: 0.95rem; }
  .chip:hover { border-color: var(--cerne); color: var(--texto); }
  .chip[aria-current] { background: var(--cerne); border-color: var(--cerne); color: var(--fundo); font-weight: 600; }
  .linha-cartao { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-top: 0.6rem; }
  .linha-cartao select { font: inherit; color: var(--texto); background: var(--campo); border: 1px solid var(--linha); border-radius: 0.5rem; padding: 0.45rem 0.6rem; max-width: 100%; }
  .etiqueta { display: inline-block; font-size: 0.8rem; color: var(--suave); border: 1px solid var(--linha); border-radius: 1rem; padding: 0 0.5rem; margin-left: 0.4rem; }
</style>
</head>
<body>
${nav}
<main class="${[opts.section ? "com-topo" : "", opts.wide ? "largo" : ""].join(" ").trim()}">
${opts.section ? "" : '  <img class="anel" src="/icone.svg" alt="" width="56" height="56">\n'}${body}
</main>
</body>
</html>`;
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "2026-11-01" → "nov/2026". */
function monthLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`;
}

/** "2026-10-05" → "05/10/2026". */
function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function homePage(version: string, transactionCount: number, pendingReview = 0, backup?: { configured: boolean; lastDays?: number }): string {
  const backupWarning = !backup
    ? ""
    : !backup.configured
      ? '<div class="painel"><p class="erro"><strong>Backup não configurado.</strong> Veja <a href="/ajustes">Ajustes → Backups</a>.</p></div>'
      : backup.lastDays === undefined || backup.lastDays >= 7
        ? `<div class="painel"><p class="erro"><strong>${backup.lastDays === undefined ? "Nenhum backup ainda" : `Último backup há ${backup.lastDays} dias`}.</strong> <a href="/ajustes">Fazer agora</a>.</p></div>`
        : "";
  return layout(
    "Jatobá Finance",
    `  <h1>Jatobá Finance</h1>
  <p>Every resource has a purpose.</p>
  ${backupWarning}
  ${
    transactionCount === 0
      ? `<p>Nenhum lançamento ainda. Comece <a href="/importar">importando um extrato</a> (OFX da conta ou CSV da fatura do C6).</p>`
      : `<p>${transactionCount.toLocaleString("pt-BR")} lançamento(s) importado(s). <a href="/lancamentos">Ver lançamentos</a> ou <a href="/importar">importar mais</a>.</p>${
          pendingReview > 0 ? `<p><a href="/revisar">${pendingReview.toLocaleString("pt-BR")} lançamento(s) para revisar</a>.</p>` : ""
        }`
  }
  ${transactionCount > 0 ? '<p><a href="/mes">Ver o resumo do mês</a>.</p>' : ""}

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
      }.${s.suspects ? ` <strong>${s.suspects} possível(is) duplicado(s)</strong> com texto diferente: confira em <a href="/revisar">Revisar</a>.` : ""}</li>`;
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
function pagination(page: number, pages: number, query = ""): string {
  if (pages <= 1) return "";
  const link = (target: number, label: string, rel?: string) =>
    `<a href="/lancamentos?${query}pagina=${target}"${rel ? ` rel="${rel}"` : ""}>${label}</a>`;
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
  filter: { month?: string; categoryName?: string; query?: string; months?: string[]; categoryParam?: string } = {},
): string {
  // Faixa de meses: "Todos" e cada mês com dados; mantém o filtro de categoria ao trocar de mês.
  const cat = filter.categoryParam ? `categoria=${encodeURIComponent(filter.categoryParam)}` : "";
  const chip = (label: string, month: string | undefined) => {
    const href = `/lancamentos${[month ? `mes=${month.slice(0, 7)}` : "", cat].filter(Boolean).length ? "?" : ""}${[month ? `mes=${month.slice(0, 7)}` : "", cat].filter(Boolean).join("&amp;")}`;
    const current = (month ?? "") === (filter.month ?? "");
    return `<a class="chip" href="${href}"${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
  };
  const monthChips = filter.months && filter.months.length > 1
    ? `<nav class="chips" aria-label="Filtrar por mês">${chip("Todos", undefined)}${filter.months.map((m) => chip(monthLabel(m), m)).join("")}</nav>`
    : "";
  const filterNote = filter.month || filter.categoryName
    ? `<p class="filtro"><span>Filtrando: ${[filter.month ? `<strong>${escapeHtml(monthTitle(filter.month))}</strong>` : "", filter.categoryName ? `<strong>${escapeHtml(filter.categoryName)}</strong>` : ""].filter(Boolean).join(" · ")}</span>
      <a href="/lancamentos">limpar filtro</a>${filter.month ? ` · <a href="/mes?m=${filter.month.slice(0, 7)}">voltar ao mês</a>` : ""}</p>`
    : "";
  if (total === 0 && filterNote) {
    return layout("Lançamentos · Jatobá Finance", `  <h1>Lançamentos</h1>${monthChips}${filterNote}<p>Nenhum lançamento com este filtro.</p>`, { section: "lancamentos" });
  }
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
      const tags = [
        r.installment ? `parcela ${r.installment}` : "",
        r.cardLast4 ? `cartão ${r.cardLast4}` : "",
        r.billing && r.month ? `fatura ${monthLabel(r.month)}` : "",
      ]
        .filter(Boolean)
        .map((t) => `<span class="etiqueta">${escapeHtml(t)}</span>`)
        .join("");
      return `<tr>
        <td class="data">${brDate(r.date)}</td>
        <td><a class="discreta" href="/lancamentos/${escapeHtml(r.id)}">${escapeHtml(r.cleanDescription ?? r.description)}</a>${tags}</td>
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
  ${monthChips}
  ${filterNote}
  ${pagination(paging.page, paging.pages, filter.query)}
  <div class="tabela"><table>
    <thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Categoria</th><th scope="col">Conta</th><th scope="col" class="valor">Valor</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  ${pagination(paging.page, paging.pages, filter.query)}`,
    { section: "lancamentos", wide: true },
  );
}

const KIND_LABEL: Record<Category["kind"], string> = {
  despesa: "Despesas",
  receita: "Receitas",
  movimentacao: "Movimentações (não contam como gasto)",
};

function categorySelect(categories: Category[], selected: number | null, name = "categoria", required = true): string {
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
  return `<select name="${escapeHtml(name)}"${required ? " required" : ""} aria-label="Categoria">${placeholder}${groups}</select>`;
}

function suggestionNote(r: ReviewRow, categories: Category[]): string {
  if (r.categoryId === null) return '<span class="sugestao">Sem sugestão.</span>';
  const name = categories.find((c) => c.id === r.categoryId)?.name ?? "";
  if (r.categorySource === "ia") {
    return `<span class="sugestao">Sugerido pela IA: ${escapeHtml(name)}. Confira antes de salvar.</span>`;
  }
  if (r.categorySource === "estorno") {
    return `<span class="sugestao">Sugerido: ${escapeHtml(name)}, igual à compra estornada${r.refundOfDate ? ` de ${brDate(r.refundOfDate)}` : ""}.</span>`;
  }
  if (r.categorySource === "regra") {
    return `<span class="sugestao">Sugerido: ${escapeHtml(name)}, pela regra “${escapeHtml(r.rulePattern ?? "")}”.</span>`;
  }
  return `<span class="sugestao">Sugerido: ${escapeHtml(name)}, pela categoria do banco (${escapeHtml(r.bankCategory ?? "")}).</span>`;
}

function suspectsSection(suspects: SuspectPair[]): string {
  if (suspects.length === 0) return "";
  const cards = suspects
    .map(
      (d) => `<li class="cartao duplicado">
      <div class="cabeca">
        <span class="descricao">Possível duplicado · ${brDate(d.date)} · ${escapeHtml(d.accountName)}</span>
        <span class="valor${d.amount > 0 ? " entrada" : ""}">${escapeHtml(formatMoney(d.amount, "pt-BR", d.currency))}</span>
      </div>
      <div class="lados">
        <div class="lado"><small>Já existia (de ${escapeHtml(d.original.fileName)})${d.original.categoryName ? ` · ${escapeHtml(d.original.categoryName)}` : ""}</small>${escapeHtml(d.original.description)}</div>
        <div class="lado"><small>Chegou agora (de ${escapeHtml(d.fileName)})</small>${escapeHtml(d.description)}</div>
      </div>
      <form method="post" action="/duplicados/${escapeHtml(d.id)}"><input type="hidden" name="decisao" value="duplicado"><button type="submit">É o mesmo: descartar o que chegou agora</button></form>
      <form method="post" action="/duplicados/${escapeHtml(d.id)}"><input type="hidden" name="decisao" value="distinto"><button class="discreto" type="submit">São diferentes: manter os dois</button></form>
    </li>`,
    )
    .join("");
  return `<h2>Possíveis duplicados</h2>
  <p class="suave">Mesma conta, data e valor, com texto diferente. Às vezes o banco muda o texto entre uma exportação e outra. Confira no app do banco se houve um lançamento ou dois.</p>
  <ul class="cartoes">${cards}</ul>
  <h2>Categorias</h2>`;
}

export function reviewPage(opts: {
  rows: ReviewRow[];
  total: number;
  withSuggestion: number;
  categories: Category[];
  suspects?: SuspectPair[];
  message?: string;
  error?: string;
  /** IA ligada? (e, se desligada por erro, o motivo) */
  ai?: { enabled: boolean; reason?: string };
}): string {
  const { rows, total, withSuggestion, categories } = opts;
  const withoutSuggestion = total - withSuggestion;
  const aiBox = opts.ai?.enabled && withoutSuggestion > 0
    ? `<form class="linha-form" method="post" action="/revisar/ia"><button class="discreto" type="submit">Sugerir com IA</button>
      <span class="suave">Pede à IA uma sugestão para os ${withoutSuggestion} sem sugestão. Vai só a descrição de cada um; valores, datas e contas não.</span></form>`
    : opts.ai?.reason
      ? `<p class="suave">IA desligada: ${escapeHtml(opts.ai.reason)}</p>`
      : "";
  const suspects = suspectsSection(opts.suspects ?? []);
  const flash = [
    opts.message ? `<div class="painel" role="status"><p>${escapeHtml(opts.message)}</p></div>` : "",
    opts.error ? `<div class="painel"><p class="erro" role="alert">${escapeHtml(opts.error)}</p></div>` : "",
  ].join("");

  if (total === 0) {
    return layout(
      "Revisar · Jatobá Finance",
      `  <h1>Revisar</h1>${flash}${suspects}
  <p>${suspects ? "Categorias: tudo revisado." : "Tudo revisado."} Quando importar novos extratos, os lançamentos aparecem aqui.</p>`,
      { section: "revisar" },
    );
  }

  // Um formulário só para a página: "Salvar todos os escolhidos" grava todos os que têm categoria
  // selecionada; o "Salvar" de cada cartão (name="so") grava só aquele.
  const selected = rows.filter((r) => r.categoryId !== null).length;
  const saveAll = `<div class="linha-form salvar-todos">
    <button type="submit" name="acao" value="todos">Salvar todos os escolhidos</button>
    <span class="suave">Grava cada lançamento desta página que estiver com categoria selecionada${selected ? ` (${selected} já vêm com sugestão)` : ""}.</span>
  </div>`;

  const cards = rows
    .map((r) => {
      const id = escapeHtml(r.id);
      const showOriginal = normalizeText(r.cleanDescription) !== normalizeText(r.description);
      const tags = r.installment ? `<span class="etiqueta">parcela ${escapeHtml(r.installment)}</span>` : "";
      return `<li class="cartao${r.categoryId === null ? " sem-sugestao" : ""}">
      <div class="cabeca">
        <span class="descricao">${escapeHtml(r.cleanDescription)}${tags}</span>
        <span class="valor${r.amount > 0 ? " entrada" : ""}">${escapeHtml(formatMoney(r.amount, "pt-BR", r.currency))}</span>
      </div>
      <div class="original">${brDate(r.date)} · ${escapeHtml(r.accountName)}${showOriginal ? ` · original: ${escapeHtml(r.description)}` : ""}</div>
      <div class="linha-cartao">
        <input type="hidden" name="id" value="${id}">
        <input type="hidden" name="sugestao_${id}" value="${r.categoryId ?? ""}">
        ${categorySelect(categories, r.categoryId, `categoria_${id}`, false)}
        <button type="submit" name="so" value="${id}">Salvar</button>
        ${suggestionNote(r, categories)}
        <label class="regra"><input type="checkbox" name="criar_regra_${id}" value="1"> Usar sempre que a descrição contiver
          <input type="text" name="regra_${id}" value="${escapeHtml(normalizeText(r.cleanDescription))}" aria-label="Texto da regra"></label>
      </div>
    </li>`;
    })
    .join("");

  const more = rows.length < total
    ? `<p class="suave">Mostrando ${rows.length} de ${total.toLocaleString("pt-BR")}. Salve ou aprove estes para ver os próximos.</p>`
    : "";
  return layout(
    "Revisar · Jatobá Finance",
    `  <h1>Revisar</h1>${flash}${suspects}
  <p>${total.toLocaleString("pt-BR")} lançamento(s) para revisar, ${withSuggestion.toLocaleString("pt-BR")} com sugestão. Os sem sugestão aparecem primeiro.</p>
  <p class="suave">Confira a categoria e salve. Marque “usar sempre” para criar uma regra: ela vale para todos os lançamentos parecidos, inclusive os próximos.</p>
  ${aiBox}
  <form method="post" action="/revisar/lote">
  ${saveAll}
  <ul class="cartoes">${cards}</ul>
  ${rows.length > 5 ? saveAll : ""}
  </form>
  ${more}`,
    { section: "revisar", wide: true },
  );
}

const MONTH_NAMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "2026-11-01" → "novembro de 2026". */
function monthTitle(iso: string): string {
  return `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} de ${iso.slice(0, 4)}`;
}

function money(cents: number, currency: string): string {
  return escapeHtml(formatMoney(cents, "pt-BR", currency));
}

/** Variação em relação à média: "+12%" / "−8%" / "novo". */
function comparison(total: number, average: number | undefined, kind: "despesa" | "receita"): string {
  if (average === undefined) return '<span class="suave">—</span>';
  if (average <= 0) return total > 0 ? '<span class="suave">novo</span>' : '<span class="suave">—</span>';
  const pct = Math.round(((total - average) / average) * 100);
  if (pct === 0) return '<span class="suave">igual</span>';
  // Para despesa, subir é ruim; para receita, subir é bom.
  const good = kind === "despesa" ? pct < 0 : pct > 0;
  return `<span class="${good ? "melhor" : "pior"}">${pct > 0 ? "+" : "−"}${Math.abs(pct)}%</span>`;
}

function categoryTable(rows: CategoryTotal[], total: number, currency: string, month: string, kind: "despesa" | "receita", extra?: { label: string; value: number; count: number }): string {
  const max = Math.max(1, ...rows.map((r) => r.total), extra?.value ?? 0);
  const link = (id: number | "sem") => `/lancamentos?mes=${month.slice(0, 7)}&amp;categoria=${id}`;
  const line = (name: string, href: string, value: number, count: number, cmp: string, highlight = false) => `<tr${highlight ? ' class="atencao"' : ""}>
      <td><a href="${href}">${escapeHtml(name)}</a> <span class="suave">· ${count}</span></td>
      <td class="barra-celula"><span class="barra" style="width:${Math.max(0, Math.round((value / max) * 100))}%"></span></td>
      <td class="valor">${money(value, currency)}</td>
      <td class="valor suave">${total > 0 ? Math.round((value / total) * 100) : 0}%</td>
      <td class="valor">${cmp}</td>
    </tr>`;
  const body = [
    ...rows.map((r) => line(r.name, link(r.categoryId), r.total, r.count, comparison(r.total, r.previousAverage, kind))),
    extra && extra.count > 0 ? line(extra.label, link("sem"), extra.value, extra.count, '<a href="/revisar">revisar</a>', true) : "",
  ].join("");
  if (!body) return '<p class="suave">Nada neste mês.</p>';
  return `<div class="tabela"><table class="categorias">
    <thead><tr><th scope="col">Categoria</th><th scope="col"><span class="sr">Proporção</span></th><th scope="col" class="valor">Valor</th><th scope="col" class="valor">Fatia</th><th scope="col" class="valor" title="Em relação à média dos meses anteriores">vs. média</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

export function monthPage(summary: MonthSummary | undefined, months: string[]): string {
  if (!summary) {
    return layout(
      "Mês · Jatobá Finance",
      `  <h1>Mês</h1>
  <p>Nenhum lançamento ainda. <a href="/importar">Importe um extrato</a> para ver o resumo do mês.</p>`,
      { section: "mes" },
    );
  }
  const s = summary;
  const index = months.indexOf(s.month);
  const newer = index > 0 ? months[index - 1] : undefined;
  const older = index >= 0 && index < months.length - 1 ? months[index + 1] : undefined;
  const nav = `<nav class="paginas" aria-label="Meses">
    ${older ? `<a href="/mes?m=${older.slice(0, 7)}" rel="prev">‹ ${escapeHtml(monthTitle(older))}</a>` : '<span class="desligado">‹</span>'}
    <span aria-current="page">${escapeHtml(monthTitle(s.month))}</span>
    ${newer ? `<a href="/mes?m=${newer.slice(0, 7)}" rel="next">${escapeHtml(monthTitle(newer))} ›</a>` : '<span class="desligado">›</span>'}
  </nav>`;

  const missing = s.coverage.filter((c) => c.count === 0);
  const coverage = missing.length
    ? `<div class="painel"><p><strong>Mês incompleto:</strong> ${missing
        .map((c) => `${escapeHtml(c.name)} não tem lançamentos neste mês${c.kind === "cartao" ? " (falta importar a fatura?)" : ""}`)
        .join("; ")}. <a href="/importar">Importar</a></p></div>`
    : "";
  const uncategorizedCount = s.uncategorized.outflowCount + s.uncategorized.inflowCount;
  const uncategorized = uncategorizedCount
    ? `<p class="suave">${uncategorizedCount} lançamento(s) sem categoria estão contados nos totais. <a href="/revisar">Revisar</a> deixa o resumo mais certo.</p>`
    : "";

  const movements = s.movements.length
    ? `<div class="tabela"><table>
    <thead><tr><th scope="col">Movimentação</th><th scope="col" class="valor">Saiu</th><th scope="col" class="valor">Entrou</th></tr></thead>
    <tbody>${s.movements
      .map(
        (m) => `<tr><td><a href="/lancamentos?mes=${s.month.slice(0, 7)}&amp;categoria=${m.categoryId}">${escapeHtml(m.name)}</a> <span class="suave">· ${m.count}</span></td>
        <td class="valor">${m.outflow ? money(m.outflow, s.currency) : "—"}</td><td class="valor">${m.inflow ? money(m.inflow, s.currency) : "—"}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>`
    : '<p class="suave">Nenhuma neste mês.</p>';

  const previous = s.previousMonths.length
    ? `“vs. média” compara com a média de ${s.previousMonths.map(monthTitle).join(", ")}.`
    : "Ainda não há meses anteriores para comparar.";

  return layout(
    `${monthTitle(s.month)} · Jatobá Finance`,
    `  ${nav}
  <h1>${escapeHtml(monthTitle(s.month).replace(/^./, (c) => c.toUpperCase()))}</h1>
  ${coverage}
  <div class="resumo">
    <div class="caixa"><span class="suave">Entradas</span><strong class="entrada">${money(s.income, s.currency)}</strong></div>
    <div class="caixa"><span class="suave">Saídas</span><strong>${money(s.expenses, s.currency)}</strong></div>
    <div class="caixa"><span class="suave">Saldo do mês</span><strong class="${s.net >= 0 ? "entrada" : "pior"}">${money(s.net, s.currency)}</strong></div>
  </div>
  ${uncategorized}
  <h2>Para onde foi o dinheiro</h2>
  ${categoryTable(s.expenseCategories, s.expenses, s.currency, s.month, "despesa", { label: "Sem categoria", value: s.uncategorized.outflow, count: s.uncategorized.outflowCount })}
  <h2>De onde veio</h2>
  ${categoryTable(s.incomeCategories, s.income, s.currency, s.month, "receita", { label: "Sem categoria", value: s.uncategorized.inflow, count: s.uncategorized.inflowCount })}
  <h2>Movimentações</h2>
  <p class="suave">Pagamento de fatura, transferências entre contas, aportes e resgates. Não contam como gasto nem como receita.</p>
  ${movements}
  <p class="suave rodape">Compras do cartão entram no mês de vencimento da fatura; lançamentos da conta, no mês da data. Estornos descontam da categoria da compra. ${previous}</p>`,
    { section: "mes", wide: true },
  );
}

const DIRECTION_LABEL: Record<string, string> = { "": "saídas e entradas", saida: "só saídas", entrada: "só entradas" };
const ACCOUNT_LABEL: Record<string, string> = { "": "conta e cartão", conta: "só conta", cartao: "só cartão" };

function options(map: Record<string, string>, selected: string): string {
  return Object.entries(map)
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function kindSelect(selected: string): string {
  return `<select name="tipo" aria-label="Tipo">${options({ despesa: "Despesa", receita: "Receita", movimentacao: "Movimentação (não conta como gasto)" }, selected)}</select>`;
}

function ruleForm(action: string, categories: Category[], r?: RuleDetail): string {
  return `<form class="linha-form" method="post" action="${action}">
      <label>Se a descrição contém <input type="text" name="texto" value="${escapeHtml(r?.pattern ?? "")}" required minlength="3" maxlength="80"></label>
      <label>em <select name="direcao">${options(DIRECTION_LABEL, r?.direction ?? "")}</select></label>
      <label>de <select name="conta">${options(ACCOUNT_LABEL, r?.accountKind ?? "")}</select></label>
      <label>usar ${categorySelect(categories, r?.categoryId ?? null)}</label>
      <button type="submit">${r ? "Salvar regra" : "Criar regra"}</button>
    </form>`;
}

export function settingsPage(opts: {
  categories: CategoryUsage[];
  rules: RuleDetail[];
  accounts: AccountInfo[];
  backup?: BackupStatus;
  now?: Date;
  message?: string;
  error?: string;
}): string {
  const plain: Category[] = opts.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  const flash = [
    opts.message ? `<div class="painel" role="status"><p>${escapeHtml(opts.message)}</p></div>` : "",
    opts.error ? `<div class="painel"><p class="erro" role="alert">${escapeHtml(opts.error)}</p></div>` : "",
  ].join("");

  const categoryGroups = (["despesa", "receita", "movimentacao"] as const)
    .map((kind) => {
      const items = opts.categories
        .filter((c) => c.kind === kind)
        .map((c) => {
          const others = plain.filter((o) => o.id !== c.id);
          return `<li><details>
        <summary><strong>${escapeHtml(c.name)}</strong> <span class="suave">· ${c.transactions} lançamento(s) · ${c.rules} regra(s)</span></summary>
        <form class="linha-form" method="post" action="/ajustes/categorias/${c.id}">
          <label>Nome <input type="text" name="nome" value="${escapeHtml(c.name)}" required minlength="2" maxlength="40"></label>
          ${kindSelect(c.kind)}
          <button type="submit">Salvar</button>
        </form>
        <form class="linha-form" method="post" action="/ajustes/categorias/${c.id}/apagar">
          <label>Apagar e mover lançamentos e regras para
            <select name="mover_para"><option value="">(nenhuma: voltam para Revisar)</option>${others
              .map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`)
              .join("")}</select></label>
          <label class="regra"><input type="checkbox" name="confirmar" value="1" required> Confirmo apagar “${escapeHtml(c.name)}”</label>
          <button class="discreto" type="submit">Apagar</button>
        </form>
      </details></li>`;
        })
        .join("");
      return `<h3>${KIND_LABEL[kind]}</h3><ul class="lista-ajustes">${items}</ul>`;
    })
    .join("");

  const ruleItems = opts.rules
    .map(
      (r) => `<li><details>
      <summary><strong>“${escapeHtml(r.pattern)}”</strong> → ${escapeHtml(r.categoryName)}
        <span class="suave">· ${DIRECTION_LABEL[r.direction ?? ""]} · ${ACCOUNT_LABEL[r.accountKind ?? ""]} · ${r.matches} lançamento(s)</span>
        ${r.origin === "sistema" ? '<span class="etiqueta">do sistema</span>' : ""}</summary>
      ${ruleForm(`/ajustes/regras/${r.id}`, plain, r)}
      <form class="linha-form" method="post" action="/ajustes/regras/${r.id}/apagar"><button class="discreto" type="submit">Apagar regra</button></form>
    </details></li>`,
    )
    .join("");

  const accountItems = opts.accounts
    .map(
      (a) => `<li><details>
      <summary><strong>${escapeHtml(a.name)}</strong> <span class="suave">· ${a.kind === "conta" ? "conta" : "cartão"} · ${escapeHtml(a.currency)}${a.last4 ? ` · final ${escapeHtml(a.last4)}` : ""} · ${a.transactions} lançamento(s)</span></summary>
      <form class="linha-form" method="post" action="/ajustes/contas/${a.id}">
        <label>Nome <input type="text" name="nome" value="${escapeHtml(a.name)}" required minlength="2" maxlength="40"></label>
        <button type="submit">Salvar</button>
      </form>
    </details></li>`,
    )
    .join("");

  return layout(
    "Ajustes · Jatobá Finance",
    `  <h1>Ajustes</h1>${flash}
  <p class="suave">Mudanças em categorias e regras refazem as sugestões na hora. O que você escolheu à mão ou já revisou nunca muda.</p>

  <h2>Categorias</h2>
  <form class="linha-form" method="post" action="/ajustes/categorias">
    <label>Nova categoria <input type="text" name="nome" required minlength="2" maxlength="40"></label>
    ${kindSelect("despesa")}
    <button type="submit">Criar</button>
  </form>
  ${categoryGroups}

  <h2>Regras</h2>
  <p class="suave">“Se a descrição contém…”: o texto é comparado sem acentos e sem diferença de maiúsculas. As suas regras vêm antes das do sistema; entre elas, a de texto mais longo vence.</p>
  ${ruleForm("/ajustes/regras", plain)}
  <ul class="lista-ajustes">${ruleItems}</ul>

  <h2>Contas</h2>
  <ul class="lista-ajustes">${accountItems || '<li class="suave">Nenhuma conta ainda. Elas aparecem ao importar extratos.</li>'}</ul>
  ${backupSection(opts.backup, opts.now ?? new Date())}`,
    { section: "ajustes", wide: true },
  );
}

const BRL = (cents: number) => escapeHtml(formatMoney(cents, "pt-BR", "BRL"));

function goalStatus(g: GoalProgress): string {
  switch (g.status) {
    case "atingida":
      return '<span class="melhor"><strong>Meta atingida.</strong></span>';
    case "no-ritmo":
      return `<span class="melhor">No ritmo:</span> guardar ${BRL(g.monthlyNeeded!)} por mês até ${escapeHtml(monthTitle(g.deadline!))}; nos últimos 3 meses, a média foi ${BRL(g.monthlyPace)}.`;
    case "abaixo":
      return `<span class="pior">Abaixo do ritmo:</span> para chegar até ${escapeHtml(monthTitle(g.deadline!))}, guarde ${BRL(g.monthlyNeeded!)} por mês (${g.monthsLeft} mês(es)); a média dos últimos 3 meses foi ${BRL(g.monthlyPace)}.`;
    case "prazo-vencido":
      return `<span class="pior">O prazo (${escapeHtml(monthTitle(g.deadline!))}) passou.</span> Faltam ${BRL(g.remaining)}; ajuste o prazo ou o valor.`;
    case "sem-prazo":
      return `No ritmo dos últimos 3 meses (${BRL(g.monthlyPace)} por mês), chega lá em ${g.monthsAtPace} mês(es).`;
    default:
      return "Sem prazo e sem nada guardado nos últimos 3 meses.";
  }
}

function goalCard(g: GoalProgress, entries: GoalEntry[], today: string): string {
  const history = entries.length
    ? `<ul class="historico">${entries
        .map(
          (e) => `<li><span class="data">${brDate(e.date)}</span>
          <span class="${e.amount > 0 ? "entrada" : "pior"}">${e.amount > 0 ? "+" : "−"}${BRL(Math.abs(e.amount))}</span>
          <span class="suave">${escapeHtml(e.description ? `extrato: ${e.description}` : e.note ?? (e.amount > 0 ? "guardado" : "retirado"))}</span>
          <form method="post" action="/metas/registros/${escapeHtml(e.id)}/apagar"><button class="discreto" type="submit">${e.transactionId ? "desligar" : "apagar"}</button></form></li>`,
        )
        .join("")}</ul>`
    : '<p class="suave">Nada registrado ainda.</p>';
  return `<li class="cartao meta">
    <div class="cabeca">
      <span class="descricao">${escapeHtml(g.name)}</span>
      <span><strong>${BRL(g.saved)}</strong> <span class="suave">de ${BRL(g.target)}</span></span>
    </div>
    <div class="progresso" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${g.percent}" aria-label="Progresso de ${escapeHtml(g.name)}">
      <span style="width:${g.percent}%"></span>
    </div>
    <p class="suave">${g.percent}% · faltam ${BRL(g.remaining)}${g.deadline ? ` · prazo: ${escapeHtml(monthTitle(g.deadline))}` : ""}</p>
    <p>${goalStatus(g)}</p>
    <form class="linha-form" method="post" action="/metas/${g.id}/registros">
      <select name="tipo" aria-label="Guardar ou retirar"><option value="guardar">Guardei</option><option value="retirar">Retirei</option></select>
      <label><input type="text" name="valor" inputmode="decimal" placeholder="valor" required aria-label="Valor"></label>
      <label>em <input type="date" name="data" value="${today}" required></label>
      <label><input type="text" name="nota" maxlength="120" placeholder="nota (opcional)" aria-label="Nota"></label>
      <button type="submit">Registrar</button>
    </form>
    <details><summary>Histórico e ajustes</summary>
      ${history}
      <form class="linha-form" method="post" action="/metas/${g.id}">
        <label>Nome <input type="text" name="nome" value="${escapeHtml(g.name)}" required minlength="2" maxlength="60"></label>
        <label>Valor alvo <input type="text" name="alvo" inputmode="decimal" value="${(g.target / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}" required></label>
        <label>Prazo <input type="month" name="prazo" value="${g.deadline ? g.deadline.slice(0, 7) : ""}"></label>
        <button type="submit">Salvar</button>
      </form>
      <form class="linha-form" method="post" action="/metas/${g.id}/arquivar"><input type="hidden" name="arquivar" value="1"><button class="discreto" type="submit">Arquivar</button></form>
      <form class="linha-form" method="post" action="/metas/${g.id}/apagar">
        <label class="regra"><input type="checkbox" name="confirmar" value="1" required> Confirmo apagar “${escapeHtml(g.name)}” e o histórico dela</label>
        <button class="discreto" type="submit">Apagar</button>
      </form>
    </details>
  </li>`;
}

export function goalsPage(opts: {
  goals: GoalProgress[];
  entries: Record<number, GoalEntry[]>;
  archived: GoalProgress[];
  investments: InvestmentTransaction[];
  today: string;
  message?: string;
  error?: string;
}): string {
  const flash = [
    opts.message ? `<div class="painel" role="status"><p>${escapeHtml(opts.message)}</p></div>` : "",
    opts.error ? `<div class="painel"><p class="erro" role="alert">${escapeHtml(opts.error)}</p></div>` : "",
  ].join("");
  const cards = opts.goals.map((g) => goalCard(g, opts.entries[g.id] ?? [], opts.today)).join("");

  const investments = opts.investments.length && opts.goals.length
    ? `<h2>Aportes e resgates sem meta</h2>
  <p class="suave">Lançamentos do extrato nas categorias de aporte e resgate. Ligue cada um a uma meta para ele contar no progresso.</p>
  <ul class="lista-ajustes">${opts.investments
    .map(
      (t) => `<li><form class="linha-form" method="post" action="/metas/ligar/${escapeHtml(t.id)}">
      <span>${brDate(t.date)} · ${escapeHtml(t.description)} · <span class="${t.amount < 0 ? "" : "entrada"}">${BRL(Math.abs(t.amount))}</span> <span class="suave">(${escapeHtml(t.categoryName)})</span></span>
      <select name="meta" aria-label="Meta">${opts.goals.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select>
      <button type="submit">Ligar</button>
    </form></li>`,
    )
    .join("")}</ul>`
    : "";

  const archived = opts.archived.length
    ? `<h2>Arquivadas</h2><ul class="lista-ajustes">${opts.archived
        .map(
          (g) => `<li><form class="linha-form" method="post" action="/metas/${g.id}/arquivar">
          <span><strong>${escapeHtml(g.name)}</strong> <span class="suave">· ${BRL(g.saved)} de ${BRL(g.target)}</span></span>
          <input type="hidden" name="arquivar" value="0"><button class="discreto" type="submit">Reativar</button></form></li>`,
        )
        .join("")}</ul>`
    : "";

  return layout(
    "Metas · Jatobá Finance",
    `  <h1>Metas</h1>${flash}
  <p class="suave">O progresso soma o que você registra (guardei, retirei) e os aportes e resgates do extrato que você liga a cada meta.</p>
  ${cards ? `<ul class="cartoes">${cards}</ul>` : '<p>Nenhuma meta ainda. Crie a primeira abaixo, por exemplo “Viagem”, R$ 10.000.</p>'}

  <h2>Nova meta</h2>
  <form class="linha-form" method="post" action="/metas">
    <label>Nome <input type="text" name="nome" required minlength="2" maxlength="60" placeholder="Viagem"></label>
    <label>Valor alvo <input type="text" name="alvo" inputmode="decimal" required placeholder="10.000"></label>
    <label>Prazo (opcional) <input type="month" name="prazo"></label>
    <label>Já guardado (opcional) <input type="text" name="guardado" inputmode="decimal" placeholder="0"></label>
    <button type="submit">Criar meta</button>
  </form>
  ${investments}
  ${archived}`,
    { section: "metas", wide: true },
  );
}

function subscriptionRow(s: Subscription, today: string): string {
  const change = s.previousAmount !== undefined
    ? ` <span class="${s.lastAmount > s.previousAmount ? "pior" : "melhor"}">${s.lastAmount > s.previousAmount ? "subiu" : "baixou"} de ${BRL(s.previousAmount)}</span>`
    : "";
  const next = s.active
    ? s.late
      ? `<span class="pior">prevista para ${brDate(s.nextDate)}, ainda não apareceu</span>`
      : `próxima por volta de ${brDate(s.nextDate)}${s.nextDate < today ? ' <span class="suave">(importe o extrato mais recente para conferir)</span>' : ""}`
    : `<span class="suave">sem cobrança desde ${brDate(s.lastDate)}</span>`;
  return `<tr>
    <td><strong>${escapeHtml(s.name)}</strong>${s.categoryName ? ` <span class="suave">· ${escapeHtml(s.categoryName)}</span>` : ""}${s.accountName ? ` <span class="suave">· ${escapeHtml(s.accountName)}</span>` : ""}
      <div class="suave">${s.charges} cobrança(s) desde ${escapeHtml(monthTitle(`${s.firstDate.slice(0, 7)}-01`))}</div></td>
    <td class="valor">${BRL(s.lastAmount)}${change}</td>
    <td>${next}<div class="suave">última em ${brDate(s.lastDate)}</div></td>
    <td><form method="post" action="/assinaturas/ignorar">
      <input type="hidden" name="chave" value="${escapeHtml(s.key)}"><input type="hidden" name="nome" value="${escapeHtml(s.name)}">
      <button class="discreto" type="submit">Não é assinatura</button></form></td>
  </tr>`;
}

function subscriptionTable(list: Subscription[], today: string): string {
  return `<div class="tabela"><table>
    <thead><tr><th scope="col">Assinatura</th><th scope="col" class="valor">Valor</th><th scope="col">Cobrança</th><th scope="col"><span class="sr">Ações</span></th></tr></thead>
    <tbody>${list.map((s) => subscriptionRow(s, today)).join("")}</tbody>
  </table></div>`;
}

export function subscriptionsPage(opts: { list: SubscriptionList; today: string; message?: string }): string {
  const { list, today } = opts;
  const flash = opts.message ? `<div class="painel" role="status"><p>${escapeHtml(opts.message)}</p></div>` : "";
  const active = list.active.length
    ? `<div class="resumo"><div class="caixa"><span class="suave">Assinaturas ativas</span><strong>${list.active.length}</strong></div>
      <div class="caixa"><span class="suave">Por mês</span><strong>${BRL(list.monthlyTotal)}</strong></div>
      <div class="caixa"><span class="suave">Por ano</span><strong>${BRL(list.monthlyTotal * 12)}</strong></div></div>
      ${subscriptionTable(list.active, today)}`
    : '<p>Nenhuma assinatura encontrada ainda. Elas aparecem quando o mesmo gasto se repete por volta de uma vez por mês.</p>';
  const stopped = list.stopped.length
    ? `<h2>Pararam</h2><p class="suave">Sem cobrança há mais de 45 dias: talvez tenham sido canceladas.</p>${subscriptionTable(list.stopped, today)}`
    : "";
  const ignored = list.ignored.length
    ? `<h2>Marcadas como “não é assinatura”</h2><ul class="lista-ajustes">${list.ignored
        .map(
          (i) => `<li><form class="linha-form" method="post" action="/assinaturas/voltar">
          <span>${escapeHtml(i.name)}</span><input type="hidden" name="chave" value="${escapeHtml(i.key)}">
          <button class="discreto" type="submit">Voltar a mostrar</button></form></li>`,
        )
        .join("")}</ul>`
    : "";
  return layout(
    "Assinaturas · Jatobá Finance",
    `  <h1>Assinaturas</h1>${flash}
  <p class="suave">Encontradas sozinhas: o mesmo estabelecimento, por volta de uma vez por mês, com valor parecido. Parcelas e estornos ficam de fora.</p>
  ${active}
  ${stopped}
  ${ignored}`,
    { section: "assinaturas", wide: true },
  );
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "escolhida por você",
  regra: "sugerida por regra",
  banco: "sugerida pela categoria do banco",
  estorno: "igual à da compra estornada",
  ia: "sugerida pela IA",
};

export function transactionPage(opts: { t: TransactionDetail; categories: Category[]; message?: string; error?: string }): string {
  const { t } = opts;
  const flash = [
    opts.message ? `<div class="painel" role="status"><p>${escapeHtml(opts.message)}</p></div>` : "",
    opts.error ? `<div class="painel"><p class="erro" role="alert">${escapeHtml(opts.error)}</p></div>` : "",
  ].join("");
  const clean = t.cleanDescription ?? t.description;
  const row = (label: string, value: string) => `<tr><th scope="row">${label}</th><td>${value}</td></tr>`;
  const details = [
    row("Data", brDate(t.date)),
    row("Valor", `<span class="${t.amount > 0 ? "entrada" : ""}">${escapeHtml(formatMoney(t.amount, "pt-BR", t.currency))}</span>`),
    t.foreign ? row("Valor original", `${escapeHtml(formatMoney(t.foreign.amount, "pt-BR", t.foreign.currency || "USD"))}${t.foreign.rate ? ` · cotação ${escapeHtml(t.foreign.rate)}` : ""}`) : "",
    row("Conta", `${escapeHtml(t.accountName)}${t.cardLast4 ? ` · cartão final ${escapeHtml(t.cardLast4)}` : ""}`),
    row("Mês", `${escapeHtml(monthTitle(t.month))}${t.billing ? " (vencimento da fatura)" : ""}`),
    t.installment ? row("Parcela", escapeHtml(t.installment)) : "",
    row("Descrição original", escapeHtml(t.description)),
    t.bankCategory ? row("Categoria do banco", escapeHtml(t.bankCategory)) : "",
    row("Categoria", t.categoryName
      ? `${escapeHtml(t.categoryName)} <span class="suave">· ${SOURCE_LABEL[t.categorySource ?? ""] ?? ""}${t.rulePattern ? ` “${escapeHtml(t.rulePattern)}”` : ""}${t.reviewed ? " · revisado" : " · ainda não revisado"}</span>`
      : `<span class="suave">sem categoria${t.reviewed ? "" : " · ainda não revisado"}</span>`),
    t.goalName ? row("Meta", escapeHtml(t.goalName)) : "",
    row("Veio de", `${escapeHtml(t.fileName)} <span class="suave">· importado em ${t.importedAt.toLocaleDateString("pt-BR")}</span>`),
  ].join("");

  const duplicateNote = t.duplicateOf
    ? `<div class="painel"><p>Este lançamento foi marcado como <strong>cópia</strong> de <a href="/lancamentos/${escapeHtml(t.duplicateOf)}">outro</a> e não entra em listas nem somas.</p></div>`
    : t.suspectOf
      ? `<div class="painel"><p>Possível duplicado de <a href="/lancamentos/${escapeHtml(t.suspectOf)}">outro lançamento</a>. Decida em <a href="/revisar">Revisar</a>.</p></div>`
      : "";

  const edit = t.duplicateOf
    ? ""
    : `<h2>Categoria</h2>
  <form class="linha-form" method="post" action="/lancamentos/${escapeHtml(t.id)}">
    ${categorySelect(opts.categories, t.categoryId)}
    <button type="submit">Salvar</button>
    <label class="regra"><input type="checkbox" name="criar_regra" value="1"> Usar sempre que a descrição contiver
      <input type="text" name="regra" value="${escapeHtml(normalizeText(clean))}" aria-label="Texto da regra"></label>
  </form>
  ${t.reviewed ? `<form class="linha-form" method="post" action="/lancamentos/${escapeHtml(t.id)}/revisar"><button class="discreto" type="submit">Voltar para revisão</button>
    <span class="suave">Desfaz a escolha e devolve o lançamento para Revisar, com a sugestão automática.</span></form>` : ""}`;

  return layout(
    "Lançamento · Jatobá Finance",
    `  <p><a href="/lancamentos?mes=${t.month.slice(0, 7)}">‹ Lançamentos de ${escapeHtml(monthTitle(t.month))}</a></p>
  <h1>${escapeHtml(clean)}</h1>${flash}${duplicateNote}
  <div class="tabela"><table class="detalhes"><tbody>${details}</tbody></table></div>
  ${edit}`,
    { section: "lancamentos" },
  );
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Seção de backups dos Ajustes. `now` para calcular há quanto tempo foi o último. */
function backupSection(b: BackupStatus | undefined, now: Date): string {
  if (!b) return "";
  if (!b.configured) {
    return `<h2>Backups</h2>
  <div class="painel"><p class="erro"><strong>Backup não configurado.</strong> Sem ele, seus dados ficam só neste computador.</p>
  <p>Siga os três passos de <code>docs/backup.md</code>: gerar as chaves, guardar a privada fora do computador e pôr a pública no <code>.env</code>.</p></div>`;
  }
  const days = b.last ? Math.floor((now.getTime() - b.last.date.getTime()) / (24 * 60 * 60_000)) : undefined;
  const last = b.last
    ? `Último: <strong>${b.last.date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</strong> (${escapeHtml(b.last.reason)}, ${sizeLabel(b.last.bytes)})${days !== undefined && days >= 7 ? ` <span class="pior">há ${days} dias</span>` : ""}`
    : '<span class="pior">Nenhum backup ainda.</span>';
  const daily = b.daily
    ? `Automático todo dia a partir das ${String(b.hour).padStart(2, "0")}h (ou assim que o computador ligar), guardando os ${b.keep} diários mais recentes.`
    : "Backup automático diário desligado (JATOBA_BACKUP_DAILY=false no .env).";
  return `<h2>Backups</h2>
  <p>${last} · ${b.count} arquivo(s) na pasta <code>backups/</code>.</p>
  <p class="suave">${daily} Backups manuais e os feitos antes de migrações nunca são apagados. Copie alguns para fora deste computador de vez em quando.</p>
  <form class="linha-form" method="post" action="/ajustes/backup"><button type="submit">Fazer backup agora</button></form>`;
}
