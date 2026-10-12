import { HttpError } from "./http";

const bad = (m = "Dati non validi") => new HttpError(400, m);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SKINS = ["classico", "salvia", "bordi", "sabbia", "blu"];

export function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && +v.slice(0, 4) >= 2000 && +v.slice(0, 4) <= 2100;
}

/** Vecchi backup usavano F/M al posto di P1/P2. */
export function normPayer(v: unknown): string {
  if (v === "F") return "P1";
  if (v === "M") return "P2";
  if (v === "P1" || v === "P2" || v === "J") return v;
  throw bad();
}

const name = (v: unknown, max = 60) => {
  if (typeof v !== "string") throw bad();
  const s = v.trim();
  if (!s || s.length > max) throw bad();
  return s;
};
const uuid = (v: unknown, nullable = false) => {
  if (v === null || v === undefined || v === "") {
    if (nullable) return null;
    throw bad();
  }
  if (typeof v !== "string" || !UUID.test(v)) throw bad();
  return v;
};
const bool = (v: unknown) => {
  if (typeof v !== "boolean") throw bad();
  return v;
};
const int = (v: unknown, min: number, max: number) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};

type Rule = (v: unknown) => unknown;

export const WRITE_RULES: Record<string, Record<string, Rule>> = {
  categories: {
    name: (v) => name(v),
    color: (v) => {
      if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad();
      return v;
    },
    icon: (v) => name(v, 30),
    archived: bool,
  },
  subcategories: {
    category_id: (v) => uuid(v),
    name: (v) => name(v),
    archived: bool,
  },
  transactions: {
    kind: (v) => {
      if (v !== "spesa" && v !== "versamento") throw bad();
      return v;
    },
    amount_cents: (v) => int(v, 1, 1e12),
    tx_date: (v) => {
      if (!isDate(v)) throw bad();
      return v;
    },
    category_id: (v) => uuid(v, true),
    subcategory_id: (v) => uuid(v, true),
    payer: (v) => normPayer(v),
    note: (v) => {
      if (v === null || v === undefined) return "";
      if (typeof v !== "string" || v.length > 500) throw bad();
      return v;
    },
    rec_id: (v) => uuid(v, true),
  },
  year_settings: {
    year: (v) => int(v, 2000, 2100),
    monthly_quota_cents: (v) => int(v, 0, 1e12),
  },
  recurrences: {
    freq: (v) => {
      if (v !== "w" && v !== "m" && v !== "y") throw bad();
      return v;
    },
    anchor_date: (v) => {
      if (!isDate(v)) throw bad();
      return v;
    },
    active: bool,
  },
};

/** Tiene solo le colonne consentite e le valida. */
export function cleanPayload(table: string, p: unknown, requireAll: boolean): Record<string, unknown> {
  const rules = WRITE_RULES[table];
  if (!rules || !p || typeof p !== "object" || Array.isArray(p)) throw bad();
  const src = p as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const [col, rule] of Object.entries(rules)) {
    if (col in src) out[col] = rule(src[col]);
  }
  if (requireAll) {
    const need: Record<string, string[]> = {
      categories: ["name"],
      subcategories: ["category_id", "name"],
      transactions: ["kind", "amount_cents", "tx_date", "payer"],
      year_settings: ["year", "monthly_quota_cents"],
      recurrences: ["freq", "anchor_date"],
    };
    for (const c of need[table] ?? []) if (!(c in out)) throw bad();
  }
  if (!Object.keys(out).length) throw bad();
  return out;
}

export { name as cleanName };
