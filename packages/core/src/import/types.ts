import type { Cents } from "../money.js";

/** Formato comum de um extrato lido, venha ele de OFX ou de CSV. */

export type StatementKind = "conta" | "cartao";

export interface Transaction {
  /** Identificador do banco (FITID no OFX). Muitos CSVs não têm; a importação usa uma impressão digital. */
  externalId?: string;
  /** AAAA-MM-DD, como o banco informou (sem converter fuso). */
  date: string;
  /** Sempre na convenção do Jatobá: saída negativa, entrada positiva. */
  amount: Cents;
  /** TRNTYPE do OFX (DEBIT, CREDIT...) ou "OTHER". */
  type: string;
  /** Texto que a limpeza e as regras vão usar. */
  description: string;
  name?: string;
  memo?: string;
  checkNumber?: string;
  /** Parcela informada pelo banco, como 3 de 10. */
  installment?: { current: number; total: number };
  /** Últimos dígitos do cartão (titular, adicional ou virtual). */
  cardLast4?: string;
  /** Categoria que o próprio banco sugeriu. Só uma dica para as regras. */
  bankCategory?: string;
  /** Valor original de compra em outra moeda. */
  foreign?: { amount: Cents; currency: string; rate?: string };
}

export interface Statement {
  kind: StatementKind;
  currency: string;
  account: { bankId?: string; branchId?: string; accountId: string; accountType?: string };
  /** Período declarado pelo arquivo. Alguns bancos (como o C6) põem a data da exportação. */
  start?: string;
  end?: string;
  ledgerBalance?: { amount: Cents; date?: string };
  /**
   * "fatura": o arquivo é uma fatura de cartão inteira, e todos os lançamentos entram no mês
   * de vencimento dela. Sem isso, cada lançamento entra no mês da própria data.
   */
  billing?: "fatura";
  transactions: Transaction[];
}

export interface ImportResult {
  statements: Statement[];
  /** Linhas ignoradas e outras observações, sem valores. */
  warnings: string[];
}
