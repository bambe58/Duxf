import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, newUser } from "./helpers";
import { db } from "../lib/db";
import { loadCtx } from "../lib/session";
import { handleDb } from "../lib/table";
import { handleRpc } from "../lib/rpc";
import { passwordLogin, passwordSignup } from "../lib/login";
import { ensureUser } from "../lib/users";
import { hashPassword } from "../lib/password";

const sel = (ctx: any, t: string, extra: object = {}) => handleDb(ctx, { t, op: "select", ...extra } as any).then((r: any) => r.data);
const rejects = (p: Promise<unknown>, status?: number) =>
  assert.rejects(p, (e: any) => (status ? e.status === status : typeof e.status === "number"));

async function setup() {
  const a = await newUser("francesco@example.com", "Francesco");
  const b = await newUser("altro@example.com", "Altro");
  const cats = await sel(a, "categories");
  const subs = await sel(a, "subcategories");
  return { a, b, cat: cats[0], sub: subs.find((s: any) => s.category_id === cats[0].id) };
}
const spesa = (s: any, extra: object = {}) => ({ kind: "spesa", amount_cents: 1250, tx_date: "2026-10-05", category_id: s.cat.id, subcategory_id: s.sub.id, payer: "P1", note: "pane", ...extra });

beforeEach(async () => {
  await freshDb();
});

test("il primo accesso crea nucleo, categorie di partenza e un solo utente", async () => {
  const s = await setup();
  assert.equal((await sel(s.a, "categories")).length, 5);
  assert.equal(s.a.slot, 1);
  const again = await newUser("FRANCESCO@example.com", "Altro nome");
  assert.equal(again.uid, s.a.uid, "stessa email, maiuscole comprese, stesso utente");
  const profile: any = (await handleRpc(s.a, "get_profile", {})).data;
  assert.equal(profile.members.length, 1);
  assert.equal(profile.joint, "Conto comune");
});

test("spese: inserimento, modifica, eliminazione e registro modifiche", async () => {
  const s = await setup();
  const ins: any = await handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s), one: true });
  assert.equal(ins.data.amount_cents, 1250);
  assert.equal(ins.data.tx_date, "2026-10-05");
  assert.equal(ins.data.payer, "P1");

  await handleDb(s.a, { t: "transactions", op: "update", f: [["id", ins.data.id]], p: { amount_cents: 1500, kind: "spesa" } });
  await handleDb(s.a, { t: "transactions", op: "delete", f: [["id", ins.data.id]] });
  assert.equal((await sel(s.a, "transactions")).length, 0);

  const log = await sel(s.a, "audit_log", { o: [["at", false]] });
  assert.equal(log.length, 3);
  assert.ok(log.some((l: any) => l.summary.startsWith("Aggiunta: Spesa 12,50 €") && l.summary.includes("pagata da Francesco")));
  assert.ok(log.some((l: any) => l.summary.startsWith("Modificata:") && l.summary.includes("15,00 €")));
  assert.ok(log.some((l: any) => l.summary.startsWith("Eliminata:")));
  assert.ok(log.every((l: any) => l.user_name === "Francesco"));
});

test("regole: un versamento non può essere del conto comune né cambiare tipo, la spesa ha la categoria", async () => {
  const s = await setup();
  await rejects(handleDb(s.a, { t: "transactions", op: "insert", p: { kind: "versamento", amount_cents: 100, tx_date: "2026-10-01", payer: "J" } }), 400);
  await rejects(handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s, { category_id: null, subcategory_id: null }) }), 400);
  await rejects(handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s, { amount_cents: -5 }) }), 400);
  await rejects(handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s, { tx_date: "2026-02-31" }) }), 400);
  await rejects(handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s, { payer: "X" }) }), 400);
  const v: any = await handleDb(s.a, { t: "transactions", op: "insert", p: { kind: "versamento", amount_cents: 70000, tx_date: "2026-10-01", payer: "P2", note: "" }, one: true });
  await rejects(handleDb(s.a, { t: "transactions", op: "update", f: [["id", v.data.id]], p: { kind: "spesa" } }), 400);
});

test("ogni nucleo vede e modifica solo i propri dati", async () => {
  const s = await setup();
  const mine: any = await handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s), one: true });

  assert.equal((await sel(s.b, "transactions")).length, 0);
  // l'altro nucleo non può leggere, modificare, eliminare né collegare i dati del primo
  assert.deepEqual((await handleDb(s.b, { t: "transactions", op: "update", f: [["id", mine.data.id]], p: { note: "hack" } }) as any).data, []);
  await handleDb(s.b, { t: "transactions", op: "delete", f: [["id", mine.data.id]] });
  assert.equal((await sel(s.a, "transactions")).length, 1);
  assert.equal((await sel(s.a, "transactions"))[0].note, "pane");
  await rejects(handleDb(s.b, { t: "transactions", op: "insert", p: spesa(s) }), 400); // categoria di un altro nucleo
  await rejects(handleDb(s.b, { t: "subcategories", op: "insert", p: { category_id: s.cat.id, name: "intrusa" } }), 400);
  assert.equal((await sel(s.b, "audit_log")).length, 0);
});

test("richieste malformate: tabelle, colonne e operazioni non previste", async () => {
  const s = await setup();
  await rejects(handleDb(s.a, { t: "users", op: "select" } as any), 400);
  await rejects(handleDb(s.a, { t: "households", op: "select" } as any), 400);
  await rejects(handleDb(s.a, { t: "transactions", op: "select", f: [["household_id", "x"]] }), 400);
  await rejects(handleDb(s.a, { t: "transactions", op: "select", o: [["1; drop table users", true]] }), 400);
  await rejects(handleDb(s.a, { t: "audit_log", op: "insert", p: { summary: "x" } }), 403);
  await rejects(handleDb(s.a, { t: "categories", op: "delete", f: [["id", s.cat.id]] }), 403);
  await rejects(handleDb(s.a, { t: "transactions", op: "update", p: { note: "tutto" } }), 400); // senza filtro
  await rejects(handleDb(s.a, { t: "transactions", op: "drop" } as any), 400);
  assert.equal((await db().query("select count(*)::int as n from users")).rows[0].n, 2);
});

test("categorie, sottocategorie e quota annuale", async () => {
  const s = await setup();
  const c: any = await handleDb(s.a, { t: "categories", op: "insert", p: { name: "Bambini", color: "#ff7a45", icon: "bambini" }, one: true });
  const sc: any = await handleDb(s.a, { t: "subcategories", op: "insert", p: { category_id: c.data.id, name: "Scuola" }, one: true });
  await handleDb(s.a, { t: "subcategories", op: "update", f: [["id", sc.data.id]], p: { archived: true } });
  await rejects(handleDb(s.a, { t: "categories", op: "insert", p: { name: "bambini", color: "#ff7a45", icon: "x" } }), 409);
  await handleDb(s.a, { t: "year_settings", op: "upsert", p: { year: 2026, monthly_quota_cents: 125000 } });
  await handleDb(s.a, { t: "year_settings", op: "upsert", p: { year: 2026, monthly_quota_cents: 130000 } });
  const q = await sel(s.a, "year_settings", { o: [["year", true]] });
  assert.deepEqual(q, [{ year: 2026, monthly_quota_cents: 130000 }]);
  const log = (await sel(s.a, "audit_log")).map((l: any) => l.summary);
  assert.ok(log.some((x: string) => x === "Sottocategoria archiviata: Bambini › Scuola"));
  assert.ok(log.some((x: string) => x.startsWith("Quota 2026: 1250,00 € → 1300,00 €")));
});

test("ricorrenze: il movimento automatico è del Sistema e non si duplica", async () => {
  const s = await setup();
  const rec: any = await handleDb(s.a, { t: "recurrences", op: "insert", p: { freq: "m", anchor_date: "2026-09-10", active: true }, one: true });
  await handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s, { tx_date: "2026-09-10", rec_id: rec.data.id }) });
  const auto = { ...spesa(s, { tx_date: "2026-10-10", rec_id: rec.data.id }), auto: true };
  await handleDb(s.a, { t: "transactions", op: "insert", p: auto });
  await rejects(handleDb(s.a, { t: "transactions", op: "insert", p: auto }), 409); // secondo dispositivo, stessa scadenza
  assert.equal((await sel(s.a, "transactions")).length, 2);
  const log = await sel(s.a, "audit_log", { o: [["at", false]] });
  const sys = log.find((l: any) => l.sys);
  assert.equal(sys.user_name, "Sistema");
  assert.ok(sys.summary.startsWith("Ricorrente registrata:"));
  await handleDb(s.a, { t: "recurrences", op: "update", f: [["id", rec.data.id]], p: { active: false } });
  assert.ok((await sel(s.a, "audit_log")).some((l: any) => l.summary.startsWith("Ricorrenza terminata:")));
});

test("inviti: flusso completo", async () => {
  const s = await setup();
  await handleRpc(s.a, "invite_partner", { email: "Altro@Example.com" });
  await rejects(handleRpc(s.a, "invite_partner", { email: "altro@example.com" }), 400); // già inviato
  const pa: any = (await handleRpc(s.a, "get_profile", {})).data;
  assert.equal(pa.invites_out.length, 1);
  const pb: any = (await handleRpc(s.b, "get_profile", {})).data;
  assert.equal(pb.invites_in.length, 1);
  assert.equal(pb.invites_in[0].from_name, "Francesco");

  assert.equal(pb.invites_in[0].code, undefined); // il codice lo vede solo chi invita
  const code = pa.invites_out[0].code as string;
  assert.match(code, /^[A-Z2-9]{8}$/);
  await rejects(handleRpc(s.b, "answer_invite", { id: pb.invites_in[0].id, accept: true }), 400); // senza codice
  await rejects(handleRpc(s.b, "answer_invite", { id: pb.invites_in[0].id, accept: true, code: "AAAAAAAA" }), 400);
  const oldHousehold = s.b.hid;
  await handleRpc(s.b, "answer_invite", { id: pb.invites_in[0].id, accept: true, code: code.toLowerCase().slice(0, 4) + "-" + code.slice(4) });
  const b2 = (await loadCtx(db(), s.b.uid))!;
  assert.equal(b2.hid, s.a.hid);
  assert.equal(b2.slot, 2);
  assert.equal((await db().query("select count(*)::int as n from households where id = $1", [oldHousehold])).rows[0].n, 0);
  const members = ((await handleRpc(b2, "get_profile", {})).data as any).members;
  assert.deepEqual(members.map((m: any) => m.name), ["Francesco", "Altro"]);
  // una terza persona non può essere aggiunta
  const c = await newUser("terzo@example.com", "Terzo");
  await rejects(handleRpc(s.a, "invite_partner", { email: "terzo@example.com" }), 400);
  // la seconda utenza vede gli stessi dati
  const cats = await sel(b2, "categories");
  assert.equal(cats.length, 5);
  // un invito di un altro non si può accettare
  await handleRpc(c, "invite_partner", { email: "mia@example.com" });
  const d = await newUser("MIA@example.com", "Mia");
  const inv = ((await handleRpc(d, "get_profile", {})).data as any).invites_in[0];
  await rejects(handleRpc(s.a, "answer_invite", { id: inv.id, accept: true }), 400);
});

test("login con email e password", async () => {
  await freshDb();
  const uid = await passwordSignup("Mario@Example.com", "Mario", "segretissima");
  assert.equal(await passwordLogin("mario@example.com", "segretissima"), uid);
  await rejects(passwordSignup("mario@example.com", "Altro", "altrapassword"), 409);
  await rejects(passwordSignup("x@example.com", "X", "corta"), 400);
  await rejects(passwordLogin("mario@example.com", "sbagliata"), 401);
  await rejects(passwordLogin("nessuno@example.com", "qualunque"), 401);
  // un account creato con Google non ha password: non si entra con una password
  await ensureUser("g@example.com", "G");
  await rejects(passwordLogin("g@example.com", ""), 401);
  // dopo troppi errori l'account si blocca anche con la password giusta
  for (let i = 0; i < 8; i++) await passwordLogin("mario@example.com", "no" + i).catch(() => {});
  await rejects(passwordLogin("mario@example.com", "segretissima"), 429);
});

test("nomi, tema e password di ripristino", async () => {
  const s = await setup();
  await handleRpc(s.a, "set_name", { name: "  Fra  " });
  await handleRpc(s.a, "set_joint_name", { name: "COI" });
  await handleRpc(s.a, "set_skin", { skin: "blu" });
  await rejects(handleRpc(s.a, "set_skin", { skin: "rosa-shocking" }), 400);
  await rejects(handleRpc(s.a, "set_name", { name: "   " }), 400);
  const p: any = (await handleRpc(s.a, "get_profile", {})).data;
  assert.deepEqual([p.name, p.joint, p.skin, p.has_pw], ["Fra", "COI", "blu", false]);

  await rejects(handleRpc(s.a, "set_restore_password", { old: null, new: "123" }), 400);
  await handleRpc(s.a, "set_restore_password", { old: null, new: "segreta1" });
  await rejects(handleRpc(s.a, "set_restore_password", { old: "sbagliata", new: "nuova123" }), 400);
  await handleRpc(s.a, "set_restore_password", { old: "segreta1", new: "nuova123" });
  assert.equal(((await handleRpc(s.a, "get_profile", {})).data as any).has_pw, true);
  const hash = (await db().query("select backup_password_hash h from households where id = $1", [s.a.hid])).rows[0].h;
  assert.ok(hash.startsWith("s1$") && !hash.includes("nuova123"));
});

test("backup: esportazione, ripristino con password e nuovi identificativi", async () => {
  const s = await setup();
  const c2: any = await handleDb(s.a, { t: "categories", op: "insert", p: { name: "Auto", color: "#8b5cf6", icon: "trasporti" }, one: true });
  const sc2: any = await handleDb(s.a, { t: "subcategories", op: "insert", p: { category_id: c2.data.id, name: "Benzina" }, one: true });
  const rec: any = await handleDb(s.a, { t: "recurrences", op: "insert", p: { freq: "m", anchor_date: "2026-01-05", active: true }, one: true });
  await handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s, { category_id: c2.data.id, subcategory_id: sc2.data.id, rec_id: rec.data.id, tx_date: "2026-01-05" }) });
  await handleDb(s.a, { t: "transactions", op: "insert", p: { kind: "versamento", amount_cents: 70000, tx_date: "2026-01-01", payer: "P2", note: "" } });
  await handleDb(s.a, { t: "year_settings", op: "upsert", p: { year: 2026, monthly_quota_cents: 70000 } });

  const backup: any = { app: "duofin", version: 2 };
  for (const t of ["categories", "subcategories", "transactions", "year_settings", "recurrences"]) backup[t] = await sel(s.a, t);

  await rejects(handleRpc(s.a, "restore_backup", { pw: "x", payload: backup }), 400); // password non impostata
  await handleRpc(s.a, "set_restore_password", { old: null, new: "segreta1" });
  await rejects(handleRpc(s.a, "restore_backup", { pw: "sbagliata", payload: backup }), 400);
  await rejects(handleRpc(s.a, "restore_backup", { pw: "segreta1", payload: { app: "altro" } }), 400);
  await rejects(handleRpc(s.a, "restore_backup", { pw: "segreta1", payload: { ...backup, transactions: [{ ...backup.transactions[0], category_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }] } }), 400);

  // dopo i tentativi falliti i dati sono intatti
  assert.equal((await sel(s.a, "transactions")).length, 2);

  // modifico qualcosa, poi ripristino
  await handleDb(s.a, { t: "transactions", op: "delete", f: [["id", backup.transactions[0].id]] });
  await handleRpc(s.a, "restore_backup", { pw: "segreta1", payload: backup });
  const tx = await sel(s.a, "transactions");
  assert.equal(tx.length, 2);
  assert.ok(tx.every((t: any) => !backup.transactions.some((b: any) => b.id === t.id)), "gli id sono nuovi");
  const spesaTx = tx.find((t: any) => t.kind === "spesa");
  const cats = await sel(s.a, "categories");
  assert.equal(cats.find((c: any) => c.id === spesaTx.category_id).name, "Auto");
  assert.ok(spesaTx.rec_id);
  assert.deepEqual(await sel(s.a, "year_settings"), [{ year: 2026, monthly_quota_cents: 70000 }]);
  assert.ok((await sel(s.a, "audit_log")).some((l: any) => l.summary === "Ripristino backup eseguito"));

  // i vecchi backup con F/M vengono letti come P1/P2
  const old = structuredClone(backup);
  old.transactions = old.transactions.map((t: any) => ({ ...t, payer: t.payer === "P1" ? "F" : t.payer === "P2" ? "M" : t.payer }));
  await handleRpc(s.a, "restore_backup", { pw: "segreta1", payload: old });
  assert.deepEqual((await sel(s.a, "transactions")).map((t: any) => t.payer).sort(), ["P1", "P2"]);

  // il ripristino non tocca gli altri nuclei
  assert.equal((await sel(s.b, "categories")).length, 5);
});

test("last_change cambia a ogni modifica", async () => {
  const s = await setup();
  const v0 = (await handleRpc(s.a, "last_change", {})).data as number;
  const r: any = await handleDb(s.a, { t: "transactions", op: "insert", p: spesa(s) });
  assert.ok(r.v > v0);
  assert.equal((await handleRpc(s.a, "last_change", {})).data, r.v);
  assert.equal((await handleRpc(s.b, "last_change", {})).data, 0);
});

test("dati di prova e cancellazione con doppia password", async () => {
  const s = await setup();
  await handleRpc(s.a, "set_restore_password", { new: "ripristino1" });
  const n = ((await handleRpc(s.a, "seed_demo", {})) as any).data;
  assert.ok(n > 40);
  const txs = await sel(s.a, "transactions");
  assert.equal(txs.length, n);
  assert.ok(txs.every((t: any) => t.tx_date <= new Date().toISOString().slice(0, 10)));
  await rejects(handleRpc(s.a, "seed_demo", {}), 400); // già pieno
  // l'altro nucleo non vede nulla
  assert.equal((await sel(s.b, "transactions")).length, 0);

  // senza sblocco o con password sbagliate non si cancella
  await rejects(handleRpc(s.a, "wipe_all", { token: "x", pw: "qualunque" }), 403);
  await rejects(handleRpc(s.a, "wipe_unlock", { pw: "sbagliata" }), 400);
  const token = ((await handleRpc(s.a, "wipe_unlock", { pw: "ripristino1" })) as any).data as string;
  await rejects(handleRpc(s.b, "wipe_all", { token, pw: "x" }), 403); // il gettone è personale
  await rejects(handleRpc(s.a, "wipe_all", { token, pw: "sbagliata" }), 400);
  assert.equal((await sel(s.a, "transactions")).length, n);

  // account con password: il secondo passo vuole quella dell'account
  await db().query("update users set password_hash = $1 where id = $2", [hashPassword("accesso123"), s.a.uid]);
  await rejects(handleRpc(s.a, "wipe_all", { token, pw: "ripristino1" }), 400);
  await handleRpc(s.a, "wipe_all", { token, pw: "accesso123" });
  assert.equal((await sel(s.a, "transactions")).length, 0);
  assert.equal((await sel(s.a, "categories")).length, 5);
  const log = (await sel(s.a, "audit_log")).map((l: any) => l.summary);
  assert.ok(log.includes("Tutti i dati cancellati"));
});
