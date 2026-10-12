import type { Q } from "./db";
import type { Ctx } from "./session";

type Row = Record<string, any>;

const fm = (c: number) => (c / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const fd = (d: string) => d.slice(8) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
const FR: Record<string, string> = { w: "settimanale", m: "mensile", y: "annuale" };

export async function householdNames(q: Q, hid: string): Promise<Record<string, string>> {
  const u = await q.query<{ slot: number; name: string }>("select slot, name from users where household_id = $1", [hid]);
  const h = await q.query<{ joint_name: string }>("select joint_name from households where id = $1", [hid]);
  const by = (s: number) => u.rows.find((r) => r.slot === s)?.name;
  return { P1: by(1) ?? "Utente 1", P2: by(2) ?? "Partner", J: h.rows[0]?.joint_name ?? "Conto comune" };
}

async function nameMap(q: Q, table: "categories" | "subcategories", hid: string) {
  const { rows } = await q.query<{ id: string; name: string }>(`select id, name from ${table} where household_id = $1`, [hid]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function addLog(q: Q, ctx: Ctx, table: string, action: "insert" | "update" | "delete", summary: string, title: string, sys = false) {
  await q.query(
    "insert into audit_log (household_id, user_id, user_name, table_name, action, summary, title, sys) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [ctx.hid, sys ? null : ctx.uid, sys ? "Sistema" : ctx.name, table, action, summary, title, sys],
  );
}

/** Scrive nel registro modifiche una voce leggibile per ogni cambiamento (stessi testi della demo). */
export async function logChange(q: Q, ctx: Ctx, table: string, op: "insert" | "update" | "delete", o: Row | null, n: Row | null, sys = false) {
  const r = (n ?? o)!;
  let s = "", t = "";
  if (table === "transactions") {
    const [nm, cats, subs] = await Promise.all([householdNames(q, ctx.hid), nameMap(q, "categories", ctx.hid), nameMap(q, "subcategories", ctx.hid)]);
    const dtx = (x: Row) =>
      (x.kind === "versamento"
        ? `Versamento ${fm(x.amount_cents)} di ${nm[x.payer]}`
        : `Spesa ${fm(x.amount_cents)} · ${cats.get(x.category_id) ?? "?"} › ${subs.get(x.subcategory_id) ?? "?"} · pagata da ${nm[x.payer]}`) +
      ` · ${fd(x.tx_date)}` +
      (x.note ? ` · ${x.note}` : "");
    const nn = r.kind === "spesa" ? "una spesa" : "un versamento";
    s = op === "insert" ? "Aggiunta: " + dtx(n!) : op === "delete" ? "Eliminata: " + dtx(o!) : "Modificata: " + dtx(o!) + "  →  " + dtx(n!);
    t = sys ? "È stato registrato un movimento ricorrente" : op === "insert" ? "ha aggiunto " + nn : op === "delete" ? "ha eliminato " + nn : "ha modificato " + nn;
    if (sys) s = "Ricorrente registrata: " + dtx(n!);
  } else if (table === "categories") {
    s = op === "insert" ? "Categoria creata: " + n!.name : op === "delete" ? "Categoria eliminata: " + o!.name
      : o!.name !== n!.name ? `Categoria rinominata: ${o!.name} → ${n!.name}`
      : o!.archived !== n!.archived ? (n!.archived ? "Categoria archiviata: " : "Categoria ripristinata: ") + n!.name
      : "Categoria modificata: " + n!.name;
    t = op === "insert" ? "ha creato la categoria " + n!.name : op === "delete" ? "ha eliminato la categoria " + o!.name
      : o!.name !== n!.name ? "ha rinominato la categoria " + o!.name
      : o!.archived !== n!.archived ? (n!.archived ? "ha archiviato la categoria " : "ha ripristinato la categoria ") + n!.name
      : "ha modificato la categoria " + n!.name;
  } else if (table === "subcategories") {
    const p = (await nameMap(q, "categories", ctx.hid)).get(r.category_id) ?? "?";
    s = op === "insert" ? `Sottocategoria creata: ${p} › ${n!.name}` : op === "delete" ? `Sottocategoria eliminata: ${p} › ${o!.name}`
      : o!.name !== n!.name ? `Sottocategoria rinominata: ${p} › ${o!.name} → ${n!.name}`
      : o!.archived !== n!.archived ? (n!.archived ? "Sottocategoria archiviata: " : "Sottocategoria ripristinata: ") + `${p} › ${n!.name}`
      : "Sottocategoria modificata";
    t = op === "insert" ? "ha creato la sottocategoria " + n!.name : op === "delete" ? "ha eliminato la sottocategoria " + o!.name
      : o!.name !== n!.name ? "ha rinominato la sottocategoria " + o!.name
      : o!.archived !== n!.archived ? (n!.archived ? "ha archiviato la sottocategoria " : "ha ripristinato la sottocategoria ") + n!.name
      : "ha modificato una sottocategoria";
  } else if (table === "recurrences") {
    const m = await q.query<Row>("select * from transactions where household_id = $1 and rec_id = $2 order by tx_date desc limit 1", [ctx.hid, r.id]);
    let d = "";
    if (m.rows[0]) {
      const [nm, cats, subs] = await Promise.all([householdNames(q, ctx.hid), nameMap(q, "categories", ctx.hid), nameMap(q, "subcategories", ctx.hid)]);
      const x = m.rows[0];
      d = (x.kind === "versamento"
        ? `Versamento ${fm(x.amount_cents)} di ${nm[x.payer]}`
        : `Spesa ${fm(x.amount_cents)} · ${cats.get(x.category_id) ?? "?"} › ${subs.get(x.subcategory_id) ?? "?"} · pagata da ${nm[x.payer]}`) + ` · ${fd(x.tx_date)}`;
    }
    if (op === "insert") { s = `Ricorrenza ${FR[n!.freq]} attivata, dal ${fd(n!.anchor_date)}`; t = `ha reso ricorrente un movimento (${FR[n!.freq]})`; }
    else if (op === "delete") { s = "Ricorrenza eliminata"; t = "ha eliminato una ricorrenza"; }
    else if (o!.active && !n!.active) { s = "Ricorrenza terminata: " + d; t = "ha terminato una ricorrenza"; }
    else if (!o!.active && n!.active) { s = `Ricorrenza riattivata (${FR[n!.freq]}): ${d}`; t = "ha riattivato una ricorrenza"; }
    else if (o!.freq !== n!.freq) { s = `Frequenza ${FR[o!.freq]} → ${FR[n!.freq]}: ${d}`; t = "ha cambiato la frequenza di una ricorrenza"; }
    else { s = "Ricorrenza modificata: " + d; t = "ha modificato una ricorrenza"; }
  } else {
    // year_settings
    s = op === "insert" ? `Quota ${n!.year} impostata a ${fm(n!.monthly_quota_cents)} al mese` : op === "delete" ? `Quota ${o!.year} rimossa`
      : `Quota ${n!.year}: ${fm(o!.monthly_quota_cents)} → ${fm(n!.monthly_quota_cents)} al mese`;
    t = op === "delete" ? "ha rimosso la quota " + o!.year : "ha impostato la quota " + n!.year;
  }
  await addLog(q, ctx, table, op, s, t, sys);
}

/** Numero dell'ultima voce di registro del nucleo: serve a capire se qualcuno ha cambiato qualcosa. */
export async function lastVersion(q: Q, hid: string): Promise<number> {
  const { rows } = await q.query<{ v: number }>("select coalesce(max(id), 0) as v from audit_log where household_id = $1", [hid]);
  return rows[0].v;
}
