import { db, type Q } from "./db";
import { HttpError, toHttpError } from "./http";
import { cleanPayload } from "./validate";
import { lastVersion, logChange } from "./audit";
import type { Ctx } from "./session";

type Row = Record<string, any>;

const TABLES: Record<string, { cols: string[]; write: boolean }> = {
  categories: { cols: ["id", "name", "color", "icon", "archived", "created_at"], write: true },
  subcategories: { cols: ["id", "category_id", "name", "archived", "created_at"], write: true },
  transactions: { cols: ["id", "kind", "amount_cents", "tx_date", "category_id", "subcategory_id", "payer", "note", "rec_id", "created_at"], write: true },
  year_settings: { cols: ["year", "monthly_quota_cents"], write: true },
  recurrences: { cols: ["id", "freq", "anchor_date", "active", "created_at"], write: true },
  audit_log: { cols: ["id", "at", "user_name", "table_name", "action", "summary", "title", "sys"], write: false },
};

export interface Spec {
  t: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  f?: [string, unknown][];
  o?: [string, boolean][];
  r?: [number, number] | null;
  p?: unknown;
  one?: boolean;
}

const bad = (m = "Richiesta non valida") => new HttpError(400, m);

function where(table: string, hid: string, filters: Spec["f"]) {
  const cols = TABLES[table].cols;
  const params: unknown[] = [hid];
  let sql = "household_id = $1";
  for (const f of filters ?? []) {
    if (!Array.isArray(f) || f.length !== 2 || !cols.includes(f[0])) throw bad();
    const v = f[1];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw bad();
    params.push(v);
    sql += ` and ${f[0]} = $${params.length}`;
  }
  return { sql, params };
}

const pick = (cols: string[], r: Row) => Object.fromEntries(cols.map((c) => [c, r[c]]));
const same = (cols: string[], a: Row, b: Row) => cols.every((c) => JSON.stringify(a[c]) === JSON.stringify(b[c]));

/** Esegue una richiesta sulla tabella indicata, sempre limitata al nucleo dell'utente. */
export async function handleDb(ctx: Ctx, spec: Spec) {
  const table = spec?.t;
  if (typeof table !== "string" || !Object.hasOwn(TABLES, table)) throw bad();
  const cfg = TABLES[table];
  const cols = cfg.cols.join(", ");

  try {
    if (spec.op === "select") {
      const w = where(table, ctx.hid, spec.f);
      const order: string[] = [];
      for (const o of spec.o ?? []) {
        if (!Array.isArray(o) || !cfg.cols.includes(o[0])) throw bad();
        order.push(`${o[0]} ${o[1] === false ? "desc" : "asc"}`);
      }
      if (cfg.cols.includes("id") && !(spec.o ?? []).some((o) => o[0] === "id")) order.push(table === "audit_log" ? "id desc" : "id asc");
      let limit = 1000, offset = 0;
      if (spec.r) {
        const [a, b] = spec.r;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a) throw bad();
        offset = a;
        limit = Math.min(1000, b - a + 1);
      }
      const { rows } = await db().query(`select ${cols} from ${table} where ${w.sql} ${order.length ? "order by " + order.join(", ") : ""} limit ${limit} offset ${offset}`, w.params);
      return { data: spec.one ? (rows[0] ?? null) : rows, error: null };
    }

    if (!cfg.write) throw new HttpError(403, "Tabella in sola lettura");

    const out = await db().tx(async (q: Q) => {
      let data: Row[] = [];

      if (spec.op === "insert") {
        const raw = (spec.p ?? {}) as Row;
        const p = cleanPayload(table, raw, true);
        const sys = table === "transactions" && raw.auto === true && p.rec_id != null;
        if (table === "transactions") {
          const spesa = p.kind === "spesa";
          if (spesa && (!p.category_id || !p.subcategory_id)) throw bad("Dati non validi");
          if (!spesa) { p.category_id = null; p.subcategory_id = null; }
        }
        const names = ["household_id", ...Object.keys(p)];
        const params: unknown[] = [ctx.hid, ...Object.keys(p).map((k) => p[k])];
        if (table === "transactions") {
          names.push("created_by");
          params.push(sys ? null : ctx.uid);
        }
        const sql = `insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => "$" + (i + 1)).join(", ")}) ${sys ? "on conflict do nothing " : ""}returning ${cols}`;
        const { rows } = await q.query(sql, params);
        if (!rows.length) throw new HttpError(409, "Movimento già registrato");
        data = rows;
        await logChange(q, ctx, table, "insert", null, rows[0], sys);
      } else if (spec.op === "update") {
        if (!spec.f?.length) throw bad();
        const p = cleanPayload(table, spec.p, false);
        const w = where(table, ctx.hid, spec.f);
        const old = (await q.query(`select ${cols} from ${table} where ${w.sql} for update`, w.params)).rows;
        const names = Object.keys(p);
        for (const o of old) {
          if (table === "transactions" && "kind" in p && p.kind !== o.kind) throw bad("Dati non validi");
          const set = names.map((k, i) => `${k} = $${i + 3}`).join(", ") + (table === "transactions" ? ", updated_at = now()" : "");
          const key = table === "year_settings" ? "year" : "id";
          const { rows } = await q.query(`update ${table} set ${set} where household_id = $1 and ${key} = $2 returning ${cols}`, [ctx.hid, o[key], ...names.map((k) => p[k])]);
          const n = rows[0];
          if (!same(cfg.cols, o, n)) await logChange(q, ctx, table, "update", o, n);
          data.push(n);
        }
      } else if (spec.op === "upsert") {
        if (table !== "year_settings") throw bad();
        const p = cleanPayload(table, spec.p, true);
        const old = (await q.query(`select ${cols} from year_settings where household_id = $1 and year = $2 for update`, [ctx.hid, p.year])).rows[0];
        if (old) {
          const { rows } = await q.query(`update year_settings set monthly_quota_cents = $3 where household_id = $1 and year = $2 returning ${cols}`, [ctx.hid, p.year, p.monthly_quota_cents]);
          if (!same(cfg.cols, old, rows[0])) await logChange(q, ctx, table, "update", old, rows[0]);
          data = rows;
        } else {
          const { rows } = await q.query(`insert into year_settings (household_id, year, monthly_quota_cents) values ($1, $2, $3) returning ${cols}`, [ctx.hid, p.year, p.monthly_quota_cents]);
          await logChange(q, ctx, table, "insert", null, rows[0]);
          data = rows;
        }
      } else if (spec.op === "delete") {
        if (table !== "transactions" || !spec.f?.length) throw new HttpError(403, "Eliminazione non consentita");
        const w = where(table, ctx.hid, spec.f);
        const { rows } = await q.query(`delete from transactions where ${w.sql} returning ${cols}`, w.params);
        for (const o of rows) await logChange(q, ctx, table, "delete", o, null);
        data = [];
      } else throw bad();

      return { data, v: await lastVersion(q, ctx.hid) };
    });

    return { data: spec.one ? (out.data[0] ?? null) : out.data, error: null, v: out.v };
  } catch (e) {
    throw toHttpError(e);
  }
}
