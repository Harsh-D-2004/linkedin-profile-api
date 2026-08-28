// Identity cookies from the login event. A response must never overwrite these:
// a fresh anonymous bcookie/bscookie paired with a real li_at is the
// "replayed cookie" signature. Everything else is meant to be refreshed.
const PROTECTED = new Set(["li_at", "bcookie", "bscookie", "liap"]);

/** Split `name=value` on the first `=`. Returns null if there isn't one. */
function splitPair(text) {
  const eq = text.indexOf("=");
  if (eq === -1) return null;
  const name = text.slice(0, eq).trim();
  return name ? { name, value: text.slice(eq + 1).trim() } : null;
}

export class CookieJar {
  constructor(seed = "") {
    this.cookies = new Map();
    for (const part of seed.split(";")) {
      const pair = splitPair(part);
      if (pair) this.cookies.set(pair.name, pair.value);
    }
  }

  /**
   * Absorb a response's Set-Cookie headers.
   * Returns the names LinkedIn asked us to delete — a deleted li_at is how a
   * revoked session announces itself, so the caller has to see it.
   */
  applySetCookie(headers = []) {
    const deleted = [];

    for (const header of headers) {
      const [first, ...attrs] = header.split(";");
      const pair = splitPair(first);
      if (!pair) continue;

      // `Max-Age=0` or an Expires in the past means "drop this cookie".
      const expired = attrs.some((attr) => {
        const [key, val = ""] = attr.split("=").map((s) => s.trim());
        if (/^max-age$/i.test(key)) return Number(val) <= 0;
        if (/^expires$/i.test(key)) return new Date(val).getTime() <= Date.now();
        return false;
      });

      if (expired) {
        // Deletions apply even to protected cookies — that is the revocation signal.
        this.cookies.delete(pair.name);
        deleted.push(pair.name);
      } else if (!PROTECTED.has(pair.name) || !this.cookies.has(pair.name)) {
        this.cookies.set(pair.name, pair.value);
      }
    }

    return deleted;
  }

  /** Cookies earned at runtime, for persisting across restarts. */
  snapshot() {
    return Object.fromEntries(
      [...this.cookies].filter(([name]) => !PROTECTED.has(name)),
    );
  }

  /** Identity cookies always come from LI_COOKIE, never from disk. */
  restore(saved = {}) {
    for (const [name, value] of Object.entries(saved)) {
      if (!PROTECTED.has(name)) this.cookies.set(name, value);
    }
  }

  has(name) {
    return this.cookies.has(name);
  }

  toHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** LinkedIn checks that this matches the JSESSIONID cookie, quotes stripped. */
  csrfToken() {
    return (this.cookies.get("JSESSIONID") ?? "").replace(/"/g, "");
  }
}
