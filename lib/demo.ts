import type { Q } from "./db";
import { HttpError } from "./http";
import { addLog } from "./audit";
import { seedDefaults } from "./users";
import type { Ctx } from "./session";

type Row = Record<string, any>;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

// spese tipo: [indice categoria, indice sottocategoria, importo in centesimi, chi paga, nota, giorno]
const SPESE: [number, number, number, string, string, number][] = [
  [1, 0, 8420, "J", "Spesa settimanale", 3],
  [1, 0, 6735, "P1", "Spesa", 11],
  [1, 0, 9150, "J", "Spesa grande", 19],
  [1, 0, 5290, "P2", "Spesa", 26],
  [0, 1, 11840, "J", "Bolletta luce e gas", 8],
  [2, 0, 5500, "P1", "Benzina", 14],
  [2, 0, 4800, "P2", "Benzina", 24],
  [3, 0, 6200, "P2", "Cena con amici", 16],
  [3, 0, 3850, "P1", "Pizzeria", 22],
  [4, 0, 2990, "J", "Varie", 12],
];

/** Inserisce un po' di movimenti inventati degli ultimi sei mesi. Solo se non ci sono già movimenti. */
export async function seedDemo(q: Q, ctx: Ctx, today = new Date()) {
  const has = await q.query("select 1 from transactions where household_id = $1 limit 1", [ctx.hid]);
  if (has.rows.length) throw new HttpError(400, "Ci sono già dei movimenti: cancella prima tutti i dati");
  let cats = (await q.query<Row>("select id from categories where household_id = $1 and not archived order by created_at, name", [ctx.hid])).rows;
  if (!cats.length) {
    await seedDefaults(q, ctx.hid);
    cats = (await q.query<Row>("select id from categories where household_id = $1 and not archived order by created_at, name", [ctx.hid])).rows;
  }
  const subsOf = async (cid: string) => (await q.query<Row>("select id from subcategories where household_id = $1 and category_id = $2 and not archived order by created_at, name", [ctx.hid, cid])).rows;

  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1, td = today.getUTCDate();
  const sm0 = tm - 5 > 0 ? tm - 5 : tm - 5 + 12, sy0 = tm - 5 > 0 ? ty : ty - 1;
  const rec = (await q.query<Row>("insert into recurrences (household_id, freq, anchor_date, active) values ($1,'m',$2,true) returning id", [ctx.hid, iso(sy0, sm0, 5)])).rows[0].id;

  const years = new Set<number>();
  let n = 0;
  const add = async (y: number, m: number, d: number, kind: "spesa" | "versamento", cents: number, payer: string, note: string, cat?: Row, sub?: Row, recId?: string) => {
    if (iso(y, m, d) > iso(ty, tm, td)) return; // niente date future
    years.add(y);
    await q.query(
      "insert into transactions (household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [ctx.hid, kind, cents, iso(y, m, d), cat?.id ?? null, sub?.id ?? null, payer, note, recId ?? null, ctx.uid],
    );
    n++;
  };

  for (let k = 5; k >= 0; k--) {
    let m = tm - k, y = ty;
    if (m < 1) { m += 12; y -= 1; }
    await add(y, m, 1, "versamento", 90000, "P1", "Quota mensile");
    await add(y, m, 1, "versamento", 90000, "P2", "Quota mensile");
    // affitto ricorrente (stessa serie ogni mese)
    const home = cats[0], hs = (await subsOf(home.id))[0];
    await add(y, m, 5, "spesa", 85000, "J", "Affitto", home, hs, rec);
    for (const [ci, si, cents, payer, note, day] of SPESE) {
      const cat = cats[ci % cats.length], subs = await subsOf(cat.id);
      if (!subs.length) continue;
      const wobble = ((y * 12 + m + day) % 7) * 150 - 450; // variazione ripetibile
      await add(y, m, day, "spesa", Math.max(500, cents + wobble), payer, note, cat, subs[si % subs.length]);
    }
  }
  for (const y of years) {
    await q.query("insert into year_settings (household_id, year, monthly_quota_cents) values ($1,$2,180000) on conflict (household_id, year) do nothing", [ctx.hid, y]);
  }
  await addLog(q, ctx, "backup", "insert", `Inseriti dati di prova (${n} movimenti)`, "ha inserito i dati di prova");
  return n;
}

/** Cancella tutti i dati del nucleo e rimette le categorie di partenza. Utenti, nomi e storico modifiche restano. */
export async function wipeAll(q: Q, ctx: Ctx) {
  for (const t of ["transactions", "recurrences", "subcategories", "categories", "year_settings"]) await q.query(`delete from ${t} where household_id = $1`, [ctx.hid]);
  await seedDefaults(q, ctx.hid);
  await addLog(q, ctx, "backup", "delete", "Tutti i dati cancellati", "ha cancellato tutti i dati");
}
