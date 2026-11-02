/** Página provisória, enquanto as telas da fase 3 não existem. */
export function homePage(version: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jatobá Finance</title>
<style>
  :root {
    --fundo: #fbfaf8; --texto: #22201d; --suave: #6b655d; --cerne: #8a3b22; --linha: #e6e1d9;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fundo: #171412; --texto: #ece7e1; --suave: #a59d93; --cerne: #d27a5c; --linha: #2e2925; color-scheme: dark; }
  }
  body { margin: 0; background: var(--fundo); color: var(--texto);
    font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 18vh 1.5rem 4rem; }
  h1 { font-size: clamp(2rem, 7vw, 3rem); line-height: 1.1; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .anel { width: 3.5rem; height: 3.5rem; border-radius: 50%; margin-bottom: 1.5rem;
    background: radial-gradient(circle, var(--cerne) 0 18%, transparent 19% 34%, var(--cerne) 35% 42%, transparent 43% 58%, var(--cerne) 59% 64%, transparent 65%); }
  p { margin: 1rem 0 0; }
  .suave { color: var(--suave); font-size: 0.95rem; border-top: 1px solid var(--linha); padding-top: 1rem; margin-top: 2rem; }
</style>
</head>
<body>
<main>
  <div class="anel" aria-hidden="true"></div>
  <h1>Jatobá Finance</h1>
  <p>Every resource has a purpose.</p>
  <p>A instalação está funcionando. As telas de importação, mês e metas chegam nas próximas versões.</p>
  <p class="suave">Versão ${version}</p>
</main>
</body>
</html>`;
}
