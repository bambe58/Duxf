import { db } from "./db";

const DEFCATS: [string, string, string, string[]][] = [
  ["Casa", "#3d6bff", "casa", ["Affitto / mutuo", "Utenze"]],
  ["Spesa", "#12b5a0", "spesa", ["Supermercato"]],
  ["Trasporti", "#8b5cf6", "trasporti", ["Carburante"]],
  ["Ristorante", "#ffb020", "ristorante", ["Cene fuori"]],
  ["Altro", "#7b8099", "altro", ["Varie"]],
];

/** Trova l'utente con questa email; se non esiste crea un nuovo nucleo con categorie di partenza. */
export async function ensureUser(email: string, name: string): Promise<string> {
  const e = email.trim().toLowerCase();
  const found = await db().query<{ id: string }>("select id from users where lower(email) = $1", [e]);
  if (found.rows[0]) return found.rows[0].id;
  const display = (name || e.split("@")[0]).trim().slice(0, 40) || "Utente";
  try {
    return await create(e, display);
  } catch (err) {
    // due accessi contemporanei con la stessa email: vince il primo, l'altro riusa l'utente creato
    if ((err as { code?: string }).code === "23505") {
      const r = await db().query<{ id: string }>("select id from users where lower(email) = $1", [e]);
      if (r.rows[0]) return r.rows[0].id;
    }
    throw err;
  }
}

function create(e: string, display: string): Promise<string> {
  return db().tx(async (q) => {
    const again = await q.query<{ id: string }>("select id from users where lower(email) = $1", [e]);
    if (again.rows[0]) return again.rows[0].id;
    const h = await q.query<{ id: string }>("insert into households default values returning id");
    const hid = h.rows[0].id;
    const u = await q.query<{ id: string }>("insert into users (household_id, email, name, slot) values ($1, $2, $3, 1) returning id", [hid, e, display]);
    for (const [n, color, icon, subs] of DEFCATS) {
      const c = await q.query<{ id: string }>("insert into categories (household_id, name, color, icon) values ($1,$2,$3,$4) returning id", [hid, n, color, icon]);
      for (const s of subs) await q.query("insert into subcategories (household_id, category_id, name) values ($1,$2,$3)", [hid, c.rows[0].id, s]);
    }
    return u.rows[0].id;
  });
}
