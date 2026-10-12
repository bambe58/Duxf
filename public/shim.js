/* Collegamento tra l'interfaccia e il server: espone gli stessi metodi usati dall'app
   (from/select/insert/update/upsert/delete, rpc, auth) e li inoltra alle API di DuoFin. */
(function () {
  "use strict";
  let lastV = null; // ultima versione del registro vista da questo dispositivo

  async function post(url, body) {
    let r, j = null;
    try {
      r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    } catch (_) {
      return { data: null, error: { message: "Connessione assente" } };
    }
    try { j = await r.json(); } catch (_) { }
    if (!r.ok || (j && j.error)) return { data: null, error: { message: (j && j.error) || "Errore " + r.status } };
    if (j && typeof j.v === "number") lastV = j.v; // le modifiche fatte da qui non devono far ricaricare la pagina
    return j || { data: null, error: null };
  }

  class Q {
    constructor(t) { this.s = { t, op: "select", f: [], o: [], r: null, p: null, one: false }; }
    select() { return this; }
    order(c, opt) { this.s.o.push([c, !(opt && opt.ascending === false)]); return this; }
    range(a, b) { this.s.r = [a, b]; return this; }
    eq(c, v) { this.s.f.push([c, v]); return this; }
    insert(p) { this.s.op = "insert"; this.s.p = p; return this; }
    update(p) { this.s.op = "update"; this.s.p = p; return this; }
    upsert(p) { this.s.op = "upsert"; this.s.p = p; return this; }
    delete() { this.s.op = "delete"; return this; }
    single() { this.s.one = true; return this; }
    then(a, b) { return post("/api/db", this.s).then(a, b); }
  }

  // aggiornamenti dall'altro dispositivo: ogni 25 secondi controlla se il registro è cambiato
  const chan = {
    cb: null,
    on(_e, _f, cb) { chan.cb = cb; return chan; },
    subscribe() {
      if (chan.timer) return chan;
      chan.timer = setInterval(async () => {
        if (document.hidden || !chan.cb) return;
        const r = await post("/api/rpc", { n: "last_change", a: {} });
        if (r.error || typeof r.data !== "number") return;
        if (lastV === null) { lastV = r.data; return; }
        if (r.data !== lastV) { lastV = r.data; chan.cb(); }
      }, 25000);
      return chan;
    },
  };

  window.DuoFin = {
    from: (t) => new Q(t),
    rpc: (n, a) => post("/api/rpc", { n, a: a || {} }),
    channel: () => chan,
    auth: {
      async getSession() {
        try {
          const r = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
          const j = await r.json();
          return { data: { session: j && j.user ? { user: { id: j.user.id } } : null } };
        } catch (_) {
          return { data: { session: null } };
        }
      },
      signInWithOAuth() {
        location.href = "/api/auth/google";
        return new Promise(() => { }); // la pagina sta per cambiare
      },
      async signOut() {
        await post("/api/auth/signout", {});
        return { error: null };
      },
    },
  };
})();
