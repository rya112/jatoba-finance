function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function layout(title: string, body: string): string {
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
    --campo: #ffffff; --erro: #a12b1b;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fundo: #171412; --texto: #ece7e1; --suave: #a59d93; --cerne: #d27a5c; --linha: #2e2925;
      --campo: #201c19; --erro: #f08a76; color-scheme: dark; }
  }
  body { margin: 0; background: var(--fundo); color: var(--texto);
    font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 18vh 1.5rem 4rem; }
  h1 { font-size: clamp(2rem, 7vw, 3rem); line-height: 1.1; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .anel { width: 3.5rem; height: 3.5rem; border-radius: 50%; margin-bottom: 1.5rem;
    background: radial-gradient(circle, var(--cerne) 0 18%, transparent 19% 34%, var(--cerne) 35% 42%, transparent 43% 58%, var(--cerne) 59% 64%, transparent 65%); }
  p { margin: 1rem 0 0; }
  .suave { color: var(--suave); font-size: 0.95rem; border-top: 1px solid var(--linha); padding-top: 1rem; margin-top: 2rem;
    display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  form.entrar { margin-top: 2rem; display: grid; gap: 1rem; max-width: 22rem; }
  label { display: grid; gap: 0.3rem; font-size: 0.95rem; color: var(--suave); }
  input { font: inherit; color: var(--texto); background: var(--campo); border: 1px solid var(--linha);
    border-radius: 0.5rem; padding: 0.6rem 0.75rem; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--cerne); outline-offset: 2px; }
  button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 0.5rem; padding: 0.6rem 1rem;
    border: 1px solid var(--cerne); background: var(--cerne); color: var(--fundo); }
  button.discreto { background: transparent; color: var(--suave); border-color: var(--linha); font-weight: 500; padding: 0.3rem 0.8rem; }
  .erro { color: var(--erro); margin: 0; }
</style>
</head>
<body>
<main>
  <div class="anel" aria-hidden="true"></div>
${body}
</main>
</body>
</html>`;
}

/** Página provisória, enquanto as telas da fase 3 não existem. */
export function homePage(version: string): string {
  return layout(
    "Jatobá Finance",
    `  <h1>Jatobá Finance</h1>
  <p>Every resource has a purpose.</p>
  <p>A instalação está funcionando. As telas de importação, mês e metas chegam nas próximas versões.</p>
  <div class="suave">
    <span>Versão ${escapeHtml(version)}</span>
    <form method="post" action="/sair"><button class="discreto" type="submit">Sair</button></form>
  </div>`,
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
