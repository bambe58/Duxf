import { randomUUID } from "node:crypto";
import { db, type Q } from "./db";
import { HttpError, toHttpError } from "./http";
import { addLog, lastVersion } from "./audit";
import { hashPassword, verifyPassword } from "./password";
import { SKINS, UUID, cleanName, cleanPayload, normPayer } from "./validate";
import type { Ctx } from "./session";

type Row = Record<string, any>;
const fail = (m: string, status = 400) => new HttpError(status, m);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const members = (q: Q, hid: string) => q.query<Row>("select id, name, email from users where household_id = $1 order by slot", [hid]);

async function getProfile(ctx: Ctx) {
  const q = db();
  const [me, mem, h, inIn, out] = await Promise.all([
    q.query<Row>("select id, name, email, skin from users where id = $1", [ctx.uid]),
    members(q, ctx.hid),
    q.query<Row>("select joint_name, backup_password_hash is not null as has_pw from households where id = $1", [ctx.hid]),
    q.query<Row>(
      `select i.id, u.name as from_name, u.email as from_email from invites i join users u on u.id = i.invited_by
       where lower(i.email) = lower($1) and not i.used and i.expires_at > now() order by i.created_at`,
      [ctx.email],
    ),
    q.query<Row>('select id, email as "to" from invites where household_id = $1 and invited_by = $2 and not used and expires_at > now() order by created_at', [ctx.hid, ctx.uid]),
  ]);
  return {
    id: me.rows[0].id,
    name: me.rows[0].name,
    email: me.rows[0].email,
    skin: me.rows[0].skin,
    joint: h.rows[0].joint_name,
    has_pw: h.rows[0].has_pw,
    members: mem.rows,
    invites_in: inIn.rows,
    invites_out: out.rows,
  };
}

async function invitePartner(ctx: Ctx, a: Row) {
  const e = String(a.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 200) throw fail("email non valida");
  if (e === ctx.email.toLowerCase()) throw fail("è la tua stessa email");
  await db().tx(async (q) => {
    if ((await members(q, ctx.hid)).rows.length >= 2) throw fail("la famiglia ha già due utenze");
    const dup = await q.query("select 1 from invites where household_id = $1 and lower(email) = $2 and not used and expires_at > now()", [ctx.hid, e]);
    if (dup.rows.length) throw fail("invito già inviato");
    const t = await q.query<Row>("select household_id from users where lower(email) = $1", [e]);
    if (t.rows[0] && (await members(q, t.rows[0].household_id)).rows.length > 1) throw fail("questa utenza è già collegata a un'altra famiglia");
    await q.query("delete from invites where household_id = $1 and lower(email) = $2", [ctx.hid, e]); // scaduti
    await q.query("insert into invites (household_id, email, invited_by) values ($1, $2, $3)", [ctx.hid, e, ctx.uid]);
  });
}

async function answerInvite(ctx: Ctx, a: Row) {
  if (typeof a.id !== "string" || !UUID.test(a.id)) throw fail("invito non trovato");
  await db().tx(async (q) => {
    const inv = (await q.query<Row>("select * from invites where id = $1 and lower(email) = lower($2) and not used and expires_at > now() for update", [a.id, ctx.email])).rows[0];
    if (!inv) throw fail("invito non trovato");
    await q.query("delete from invites where id = $1", [inv.id]);
    if (!a.accept) return;
    if ((await members(q, ctx.hid)).rows.length > 1) throw fail("sei già in una famiglia");
    const target = await q.query<Row>("select slot from users where household_id = $1 for update", [inv.household_id]);
    if (target.rows.length >= 2) throw fail("la famiglia ha già due utenze");
    const slot = target.rows.some((r) => r.slot === 1) ? 2 : 1;
    const old = ctx.hid;
    await q.query("update users set household_id = $1, slot = $2 where id = $3", [inv.household_id, slot, ctx.uid]);
    await q.query("delete from households where id = $1", [old]); // i dati del vecchio account non servono più
    await addLog(q, { ...ctx, hid: inv.household_id }, "users", "insert", `Utenza collegata: ${ctx.name}`, "ha collegato la propria utenza");
  });
}

const BACKUP_LIMITS = { categories: 500, subcategories: 5000, transactions: 200000, year_settings: 200, recurrences: 5000 } as const;

async function restoreBackup(ctx: Ctx, a: Row) {
  const pw = typeof a.pw === "string" ? a.pw : "";
  const p = a.payload as Row;
  const { rows } = await db().query<Row>("select backup_password_hash from households where id = $1", [ctx.hid]);
  const stored = rows[0]?.backup_password_hash;
  if (!stored) throw fail("password non impostata");
  if (!verifyPassword(pw, stored)) throw fail("password errata");
  if (!p || typeof p !== "object" || p.app !== "duofin") throw fail("file non valido");
  const arr = (k: keyof typeof BACKUP_LIMITS): Row[] => {
    const v = p[k] ?? [];
    if (!Array.isArray(v) || v.length > BACKUP_LIMITS[k]) throw fail("file non valido");
    return v;
  };
  try {
    await db().tx(async (q) => {
      const map = (list: Row[]) => new Map(list.map((r) => [String(r.id), randomUUID()]));
      const cats = arr("categories"), subs = arr("subcategories"), recs = arr("recurrences"), years = arr("year_settings"), txs = arr("transactions");
      const cm = map(cats), sm = map(subs), rm = map(recs);
      const ref = (m: Map<string, string>, id: unknown) => (id == null || id === "" ? null : (m.get(String(id)) ?? (() => { throw fail("file non valido"); })()));

      for (const t of ["transactions", "recurrences", "subcategories", "categories", "year_settings"]) await q.query(`delete from ${t} where household_id = $1`, [ctx.hid]);

      const bulk = async (sql: string, rows: Row[], size = 3000) => {
        for (let i = 0; i < rows.length; i += size) await q.query(sql, [ctx.hid, JSON.stringify(rows.slice(i, i + size))]);
      };
      await bulk(
        "insert into categories (id, household_id, name, color, icon, archived) select id, $1, name, color, icon, archived from jsonb_to_recordset($2::jsonb) as x(id uuid, name text, color text, icon text, archived boolean)",
        cats.map((c) => ({ id: cm.get(String(c.id)), ...cleanPayload("categories", { archived: false, color: "#7b8099", icon: "altro", ...c }, true) })),
      );
      await bulk(
        "insert into subcategories (id, household_id, category_id, name, archived) select id, $1, category_id, name, archived from jsonb_to_recordset($2::jsonb) as x(id uuid, category_id uuid, name text, archived boolean)",
        subs.map((s) => ({ id: sm.get(String(s.id)), ...cleanPayload("subcategories", { archived: false, ...s, category_id: ref(cm, s.category_id) }, true) })),
      );
      await bulk(
        "insert into recurrences (id, household_id, freq, anchor_date, active) select id, $1, freq, anchor_date, active from jsonb_to_recordset($2::jsonb) as x(id uuid, freq text, anchor_date date, active boolean)",
        recs.map((r) => ({ id: rm.get(String(r.id)), ...cleanPayload("recurrences", { active: true, ...r }, true) })),
      );
      await bulk(
        "insert into year_settings (household_id, year, monthly_quota_cents) select $1, year, monthly_quota_cents from jsonb_to_recordset($2::jsonb) as x(year int, monthly_quota_cents bigint)",
        years.map((y) => cleanPayload("year_settings", y, true)),
      );
      const seen = new Set<string>();
      await bulk(
        `insert into transactions (household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id, created_by)
         select $1, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id, null
         from jsonb_to_recordset($2::jsonb) as x(kind text, amount_cents bigint, tx_date date, category_id uuid, subcategory_id uuid, payer text, note text, rec_id uuid)`,
        txs.map((t) => {
          const c = cleanPayload("transactions", { note: "", ...t, payer: normPayer(t.payer), category_id: ref(cm, t.category_id), subcategory_id: ref(sm, t.subcategory_id), rec_id: ref(rm, t.rec_id) }, true);
          if (c.kind === "versamento" && (c.category_id || c.subcategory_id)) throw fail("file non valido");
          if (c.rec_id) {
            const k = c.rec_id + "|" + c.tx_date; // una sola voce per serie e giorno
            if (seen.has(k)) c.rec_id = null;
            else seen.add(k);
          }
          return c;
        }),
      );
      await addLog(q, ctx, "backup", "insert", "Ripristino backup eseguito", "ha ripristinato un backup");
    });
  } catch (e) {
    throw toHttpError(e);
  }
}

/** Operazioni dell'account e della famiglia (nomi, tema, inviti, password di ripristino, backup). */
export async function handleRpc(ctx: Ctx, n: string, a: Row) {
  try {
    switch (n) {
      case "is_member":
        return { data: true, error: null };
      case "get_profile":
        return { data: await getProfile(ctx), error: null };
      case "last_change":
        return { data: await lastVersion(db(), ctx.hid), error: null };
      case "set_skin": {
        if (!SKINS.includes(a.skin)) throw fail("tema non valido");
        await db().query("update users set skin = $1 where id = $2", [a.skin, ctx.uid]);
        return { error: null };
      }
      case "set_name": {
        const v = cleanName(a.name, 40);
        await db().tx(async (q) => {
          const old = (await q.query<Row>("select name from users where id = $1 for update", [ctx.uid])).rows[0].name;
          if (old === v) return;
          await q.query("update users set name = $1 where id = $2", [v, ctx.uid]);
          await addLog(q, { ...ctx, name: v }, "users", "update", `Nome utente: ${old} → ${v}`, "ha cambiato il proprio nome");
        });
        return { error: null };
      }
      case "set_joint_name": {
        const v = cleanName(a.name, 40);
        await db().tx(async (q) => {
          const old = (await q.query<Row>("select joint_name from households where id = $1 for update", [ctx.hid])).rows[0].joint_name;
          if (old === v) return;
          await q.query("update households set joint_name = $1 where id = $2", [v, ctx.hid]);
          await addLog(q, ctx, "households", "update", `Nome del conto comune: ${old} → ${v}`, "ha rinominato il conto comune");
        });
        return { error: null };
      }
      case "invite_partner":
        await invitePartner(ctx, a);
        return { error: null };
      case "cancel_invite": {
        if (typeof a.id === "string" && UUID.test(a.id)) await db().query("delete from invites where id = $1 and household_id = $2 and invited_by = $3", [a.id, ctx.hid, ctx.uid]);
        return { error: null };
      }
      case "answer_invite":
        await answerInvite(ctx, a);
        return { error: null };
      case "set_restore_password": {
        const nw = typeof a.new === "string" ? a.new : "";
        if (nw.length < 6 || nw.length > 200) throw fail("almeno 6 caratteri");
        await db().tx(async (q) => {
          const stored = (await q.query<Row>("select backup_password_hash from households where id = $1 for update", [ctx.hid])).rows[0].backup_password_hash;
          if (stored && !(typeof a.old === "string" && verifyPassword(a.old, stored))) throw fail("password attuale errata");
          await q.query("update households set backup_password_hash = $1 where id = $2", [hashPassword(nw), ctx.hid]);
        });
        return { error: null };
      }
      case "restore_backup":
        await restoreBackup(ctx, a);
        return { error: null };
      default:
        throw fail("operazione non disponibile", 404);
    }
  } catch (e) {
    throw toHttpError(e);
  }
}
