import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toCents } from "../src/money.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "latin1");

// Teste provisório: garante que os extratos fictícios continuam válidos
// até o leitor de OFX de verdade chegar na fase 2.
describe("extratos fictícios", () => {
  it.each(["banco-exemplo-corrente.ofx", "cartao-exemplo.ofx"])("%s tem lançamentos com FITID único e valor legível", (name) => {
    const content = fixture(name);
    const fitids = [...content.matchAll(/<FITID>([^<\r\n]+)/g)].map((m) => m[1]);
    const amounts = [...content.matchAll(/<TRNAMT>([^<\r\n]+)/g)].map((m) => m[1] ?? "");
    expect(fitids.length).toBeGreaterThan(0);
    expect(new Set(fitids).size).toBe(fitids.length);
    expect(amounts.length).toBe(fitids.length);
    for (const amount of amounts) expect(() => toCents(amount)).not.toThrow();
  });
});
