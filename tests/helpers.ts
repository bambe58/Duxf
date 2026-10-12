import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { setDb, db } from "../lib/db";
import { ensureUser } from "../lib/users";
import { loadCtx, type Ctx } from "../lib/session";

/** Database Postgres vero ma in memoria (PGlite), con lo stesso schema di Neon. */
export async function freshDb() {
  const pg = new PGlite({ parsers: { 20: (v: string) => Number(v), 1082: (v: string) => v } });
  await pg.exec(readFileSync(new URL("../migrations/001_schema.sql", import.meta.url), "utf8"));
  setDb({
    query: async (sql, params) => {
      const r = await pg.query(sql, params as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    tx: (fn) =>
      pg.transaction((t) =>
        fn({
          query: async (sql, params) => {
            const r = await t.query(sql, params as any[]);
            return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
          },
        }),
      ),
  });
  return pg;
}

export async function newUser(email: string, name: string): Promise<Ctx> {
  const id = await ensureUser(email, name);
  return (await loadCtx(db(), id))!;
}
