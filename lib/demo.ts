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

const MONTHS = 60; // cinque anni di storico

/** Inserisce movimenti inventati degli ultimi cinque anni. Solo se non ci sono già movimenti. */
export async function seedDemo(q: Q, ctx: Ctx, today = new Date()) {
  const has = await q.query("select 1 from transactions where household_id = $1 limit 1", [ctx.hid]);
  if (has.rows.length) throw new HttpError(400, "Ci sono già dei movimenti: cancella prima tutti i dati");
  const loadCats = async () => (await q.query<Row>("select id from categories where household_id = $1 and not archived order by created_at, name", [ctx.hid])).rows;
  let cats = await loadCats();
  if (!cats.length) {
    await seedDefaults(q, ctx.hid);
    cats = await loadCats();
  }
  const subs: Row[][] = [];
  for (const c of cats) subs.push((await q.query<Row>("select id from subcategories where household_id = $1 and category_id = $2 and not archived order by created_at, name", [ctx.hid, c.id])).rows);

  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1, td = today.getUTCDate();
  const todayIso = iso(ty, tm, td);
  const startIdx = ty * 12 + (tm - 1) - (MONTHS - 1); // indice del primo mese
  const sy0 = Math.floor(startIdx / 12), sm0 = (startIdx % 12) + 1;
  const rec = (await q.query<Row>("insert into recurrences (household_id, freq, anchor_date, active) values ($1,'m',$2,true) returning id", [ctx.hid, iso(sy0, sm0, 5)])).rows[0].id;

  const rows: Row[] = [];
  const years = new Set<number>();
  const add = (y: number, m: number, d: number, kind: "spesa" | "versamento", cents: number, payer: string, note: string, ci?: number, si?: number, recId?: string) => {
    if (iso(y, m, d) > todayIso) return; // niente date future
    years.add(y);
    rows.push({
      kind, amount_cents: Math.round(cents), tx_date: iso(y, m, d), payer, note, rec_id: recId ?? null,
      category_id: ci === undefined ? null : cats[ci % cats.length].id,
      subcategory_id: ci === undefined ? null : subs[ci % cats.length][(si ?? 0) % subs[ci % cats.length].length]?.id ?? null,
    });
  };

  for (let k = 0; k < MONTHS; k++) {
    const idx = startIdx + k, y = Math.floor(idx / 12), m = (idx % 12) + 1;
    const drift = 1 + 0.03 * (k / 12); // i prezzi salgono del 3% l'anno
    const winter = m === 12 || m <= 2 ? 1.35 : m >= 6 && m <= 8 ? 0.85 : 1; // bollette più alte d'inverno
    add(y, m, 1, "versamento", 90000 * (1 + 0.02 * Math.floor(k / 12)), "P1", "Quota mensile");
    add(y, m, 1, "versamento", 90000 * (1 + 0.02 * Math.floor(k / 12)), "P2", "Quota mensile");
    add(y, m, 5, "spesa", 80000 + 2500 * Math.floor(k / 12), "J", "Affitto", 0, 0, rec);
    for (const [ci, si, cents, payer, note, day] of SPESE) {
      if (ci === 0 && si === 1) { add(y, m, day, "spesa", cents * winter * drift, payer, note, ci, si); continue; }
      if (cats[ci % cats.length] && subs[ci % cats.length].length) {
        const wobble = ((y * 12 + m + day) % 7) * 150 - 450; // variazione ripetibile
        add(y, m, day, "spesa", Math.max(500, cents * drift + wobble), payer, note, ci, si);
      }
    }
    if (m === 8) add(y, m, 18, "spesa", 95000 + (y % 3) * 12000, "J", "Vacanze", 4, 0); // vacanza estiva
    if (m === 12) add(y, m, 20, "spesa", 42000, "J", "Regali di Natale", 4, 0);
  }
  for (let i = 0; i < rows.length; i += 500) {
    await q.query(
      `insert into transactions (household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id, created_by)
       select $1, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id, $3
       from jsonb_to_recordset($2::jsonb) as x(kind text, amount_cents bigint, tx_date date, category_id uuid, subcategory_id uuid, payer text, note text, rec_id uuid)`,
      [ctx.hid, JSON.stringify(rows.slice(i, i + 500)), ctx.uid],
    );
  }
  for (const y of years) {
    await q.query("insert into year_settings (household_id, year, monthly_quota_cents) values ($1,$2,$3) on conflict (household_id, year) do nothing", [ctx.hid, y, 180000 + 5000 * (y - sy0)]);
  }
  await addLog(q, ctx, "backup", "insert", `Inseriti dati di prova (${rows.length} movimenti, ${years.size} anni)`, "ha inserito i dati di prova");
  return rows.length;
}

/** Cancella tutti i dati del nucleo e rimette le categorie di partenza. Utenti, nomi e storico modifiche restano. */
export async function wipeAll(q: Q, ctx: Ctx) {
  for (const t of ["transactions", "recurrences", "subcategories", "categories", "year_settings"]) await q.query(`delete from ${t} where household_id = $1`, [ctx.hid]);
  await seedDefaults(q, ctx.hid);
  await addLog(q, ctx, "backup", "delete", "Tutti i dati cancellati", "ha cancellato tutti i dati");
}
