import { Pool, types } from "pg";

// int8 (contatori, importi in centesimi) come numeri; date come testo "AAAA-MM-GG"
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1082, (v) => v);

export interface Q {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface Db extends Q {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
}

let override: Db | undefined;
/** usato dai test per sostituire il database */
export function setDb(d: Db | undefined) {
  override = d;
}

const g = globalThis as unknown as { __duofinPool?: Pool };

export function db(): Db {
  if (override) return override;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL non impostata");
  const pool = (g.__duofinPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4 }));
  return {
    query: (sql, params) => pool.query(sql, params) as any,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const r = await fn({ query: (sql, params) => c.query(sql, params) as any });
        await c.query("commit");
        return r;
      } catch (e) {
        try {
          await c.query("rollback");
        } catch {}
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
