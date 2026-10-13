import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, newUser } from "./helpers";
import { db } from "../lib/db";
import { handleRpc } from "../lib/rpc";
import { handleDb } from "../lib/table";
import { backupToDrive, decrypt, encrypt, finishDrive, startDrive } from "../lib/drive";

process.env.AUTH_SECRET = "x".repeat(40);
process.env.GOOGLE_CLIENT_ID = "cid";
process.env.GOOGLE_CLIENT_SECRET = "csecret";

const idToken = (email: string) => "h." + Buffer.from(JSON.stringify({ email })).toString("base64url") + ".s";
type Call = { url: string; method: string; body: string; auth: string | null };
let calls: Call[], files: string[], folderExists: boolean, refreshOk: boolean, uploadStatus: number;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await freshDb();
  calls = []; files = ["old1", "old2"]; folderExists = false; refreshOk = true; uploadStatus = 200;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? String(init.body) : "";
    calls.push({ url, method, body, auth: init.headers?.authorization ?? null });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (body.includes("authorization_code")) return json({ refresh_token: "REFRESH-1", scope: "openid email https://www.googleapis.com/auth/drive.file", id_token: idToken("main@gmail.com") });
      return refreshOk ? json({ access_token: "ACCESS-1" }) : json({ error: "invalid_grant" }, 400);
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    if (url.includes("/upload/drive/v3/files")) return uploadStatus === 200 ? json({ id: "f1", name: "x", webViewLink: "https://drive.google.com/file/f1" }) : json({}, uploadStatus);
    if (url.includes("/drive/v3/files?q=") && url.includes("mimeType")) return json({ files: folderExists ? [{ id: "FOLDER" }] : [] });
    if (url.includes("/drive/v3/files?q=")) return json({ files: ["new", ...files].map((id) => ({ id })).concat(Array.from({ length: 35 }, (_, i) => ({ id: "x" + i }))) });
    if (method === "POST" && url.includes("/drive/v3/files")) return json({ id: "FOLDER" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 500);
  }) as typeof fetch;
});

test("token cifrati e collegamento a Drive", async () => {
  assert.equal(decrypt(encrypt("segreto")), "segreto");
  assert.notEqual(encrypt("segreto"), encrypt("segreto"));
  const u = await newUser("main@gmail.com", "Francesco");
  const { url, verifier } = startDrive("https://app.test", u.email);
  const q = new URL(url).searchParams;
  assert.equal(q.get("scope"), "https://www.googleapis.com/auth/drive.file openid email");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("login_hint"), "main@gmail.com");
  await finishDrive("https://app.test", "CODE", verifier, u.uid);
  const row = (await db().query("select refresh_token_enc, google_email from drive_links")).rows[0] as any;
  assert.equal(row.google_email, "main@gmail.com");
  assert.ok(!row.refresh_token_enc.includes("REFRESH-1")); // mai in chiaro
  assert.equal(decrypt(row.refresh_token_enc), "REFRESH-1");
  const st = ((await handleRpc(u, "drive_status", {})) as any).data;
  assert.equal(st.linked, true);
});

test("backup su Drive: cartella, file, pulizia e registro", async () => {
  const u = await newUser("main@gmail.com", "Francesco");
  await assert.rejects(backupToDrive(u), (e: any) => e.status === 400); // non collegato
  await finishDrive("https://app.test", "CODE", "v", u.uid);
  await handleRpc(u, "seed_demo", {});
  const r = await backupToDrive(u, new Date("2026-10-13T10:30:00Z"));
  assert.equal(r.name, "duofin-backup-2026-10-13_10-30.json");
  assert.ok(r.count > 100);
  const up = calls.find((c) => c.url.includes("/upload/drive/v3/files"))!;
  assert.equal(up.auth, "Bearer ACCESS-1");
  const json = JSON.parse(up.body.split("\r\n\r\n")[2].split("\r\n--")[0]);
  assert.equal(json.app, "duofin");
  assert.equal(json.transactions.length, r.count);
  assert.ok(json.transactions[0].id && json.transactions[0].household_id === undefined);
  assert.ok(up.body.includes('"parents":["FOLDER"]'));
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2 + 35 + 1 - 30); // tiene gli ultimi 30
  const log = ((await handleDb(u, { t: "audit_log", op: "select" } as any)) as any).data.map((l: any) => l.summary);
  assert.ok(log.some((s: string) => s.startsWith("Backup salvato su Google Drive")));
  // troppo ravvicinato
  await assert.rejects(backupToDrive(u, new Date("2026-10-13T10:30:05Z")), (e: any) => e.status === 429);
  // la seconda volta riusa la cartella senza cercarla
  calls.length = 0;
  await backupToDrive(u, new Date("2026-10-13T11:00:00Z"));
  assert.ok(!calls.some((c) => c.url.includes("mimeType")));
});

test("accesso revocato: il collegamento viene tolto", async () => {
  const u = await newUser("main@gmail.com", "Francesco");
  await finishDrive("https://app.test", "CODE", "v", u.uid);
  refreshOk = false;
  await assert.rejects(backupToDrive(u), (e: any) => e.status === 401);
  assert.equal(((await handleRpc(u, "drive_status", {})) as any).data.linked, false);
});

test("scollega e isolamento tra utenti", async () => {
  const a = await newUser("main@gmail.com", "A"), b = await newUser("altro@gmail.com", "B");
  await finishDrive("https://app.test", "CODE", "v", a.uid);
  assert.equal(((await handleRpc(b, "drive_status", {})) as any).data.linked, false);
  await assert.rejects(backupToDrive(b), (e: any) => e.status === 400);
  await handleRpc(a, "drive_unlink", {});
  assert.equal(((await handleRpc(a, "drive_status", {})) as any).data.linked, false);
  assert.ok(calls.some((c) => c.url.includes("/revoke")));
  globalThis.fetch = realFetch;
});

test("il backup di Drive si può ripristinare", async () => {
  const u = await newUser("main@gmail.com", "Francesco");
  await handleRpc(u, "seed_demo", {});
  const { buildBackup } = await import("../lib/drive");
  const payload = await buildBackup(db(), u.hid);
  await handleRpc(u, "set_restore_password", { new: "ripristino1" });
  await db().query("delete from transactions where household_id = $1", [u.hid]);
  await handleRpc(u, "restore_backup", { pw: "ripristino1", payload: JSON.parse(JSON.stringify(payload)) });
  const n = ((await handleDb(u, { t: "transactions", op: "select" } as any)) as any).data.length;
  assert.equal(n, payload.transactions.length);
  globalThis.fetch = realFetch;
});
