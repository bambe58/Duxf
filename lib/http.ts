export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Traduce gli errori del database in messaggi comprensibili (senza esporre dettagli interni). */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const code = (e as { code?: string })?.code;
  if (code === "23505") return new HttpError(409, "Esiste già un elemento uguale");
  if (code === "23503") return new HttpError(400, "Riferimento non valido");
  if (code === "23514" || code === "22P02" || code === "22007" || code === "22008") return new HttpError(400, "Dati non validi");
  console.error("errore interno", e);
  return new HttpError(500, "Errore del server");
}

/** Difesa da richieste inviate da altri siti: l'origine deve coincidere con l'host dell'app. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let ok = false;
  try {
    ok = !!origin && !!host && new URL(origin).host === host;
  } catch {}
  if (!ok) throw new HttpError(403, "Richiesta non consentita");
}
