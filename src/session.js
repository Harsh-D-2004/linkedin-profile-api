import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Impit } from "impit";
import { CookieJar } from "./cookies.js";

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// impit's generic `chrome` profile is Chrome 124 on macOS. Pinning chrome151
// matches a current Chrome's TLS fingerprint and sec-ch-ua; the OS strings are
// overridden because the profile ships the Windows build. LinkedIn can check
// the UA against the device that logged in (bscookie), and a session claiming a
// different OS than its own login is the replayed-cookie signature.
const impit = new Impit({
  browser: "chrome151",
  proxyUrl: process.env.PROXY_URL || undefined,
  headers: {
    "user-agent":
      process.env.LI_USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "sec-ch-ua-platform": `"${process.env.LI_PLATFORM || "Linux"}"`,
  },
});

const WARMUP_TTL_MS = 15 * 60 * 1000;
const STATE_FILE = path.resolve(process.cwd(), ".session.json");
const LI_COOKIE = (process.env.LI_COOKIE || "").trim();

// Saved state belongs to one session: if LI_COOKIE changes, the cookies on disk
// came from the old (probably revoked) one and must not be carried over.
const fingerprint = crypto.createHash("sha256").update(LI_COOKIE).digest("hex").slice(0, 16);

const jar = new CookieJar(LI_COOKIE);
let warmedAt = 0;

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (saved.fingerprint === fingerprint) {
    jar.restore(saved.cookies);
    warmedAt = saved.warmedAt ?? 0;
  }
} catch {
  // No state yet, or unreadable. Starting cold is fine.
}

function persist() {
  try {
    const state = { fingerprint, cookies: jar.snapshot(), warmedAt };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Persistence is an optimisation; never fail a request over it.
  }
}

/** x-li-track describes the client. All of it is derived from the host. */
function trackHeader() {
  const clientVersion = process.env.LI_CLIENT_VERSION || "1.13.46243";
  return JSON.stringify({
    clientVersion,
    mpVersion: clientVersion,
    osName: "web",
    // getTimezoneOffset() is minutes *behind* UTC, so IST (+5:30) returns -330.
    timezoneOffset: -new Date().getTimezoneOffset() / 60,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    deviceFormFactor: "DESKTOP",
    mpName: "voyager-web",
    displayDensity: 1,
    displayWidth: 1920,
    displayHeight: 1080,
  });
}

/**
 * Feed a response's cookies back into the jar. A deleted li_at is LinkedIn
 * revoking the session — a hard stop, never something to retry.
 */
function absorb(res) {
  const deleted = jar.applySetCookie(res.headers.getSetCookie());
  if (deleted.includes("li_at") || res.headers.get("clear-site-data") !== null) {
    throw new HttpError(
      401,
      "linkedin_auth_failed",
      "LinkedIn revoked the session (cleared li_at). The cookie is dead — log in again and update LI_COOKIE. Do not retry.",
    );
  }
}

/**
 * A Voyager call is never a browser's first request — a page load always
 * precedes it and establishes the session. Arriving cold, with no __cf_bm and a
 * stale lidc, reads as a replayed cookie. So load the page, collect what
 * LinkedIn hands us, then call the API with the full jar.
 */
async function warmUp(profileUrl) {
  if (warmedAt && Date.now() - warmedAt < WARMUP_TTL_MS) return;

  // LinkedIn 301s /in/<slug>/ to the no-trailing-slash form. Start there so the
  // common case is one hop, but follow a couple and absorb cookies at each —
  // they are set on the hops, not only on the final 200.
  let url = profileUrl.replace(/\/+$/, "");

  for (let hop = 0; hop < 3; hop++) {
    const res = await impit.fetch(url, {
      redirect: "manual",
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        cookie: jar.toHeader(),
      },
    });

    absorb(res);
    if (res.status < 300 || res.status >= 400) break;

    const location = res.headers.get("location") || "";
    if (/authwall|\/login|checkpoint/i.test(location)) {
      throw new HttpError(401, "linkedin_auth_failed", "Warm-up hit the auth wall — the session is not logged in");
    }
    if (!location) break;
    url = new URL(location, url).toString();
  }

  warmedAt = Date.now();
  persist();
}

/** GET a Voyager endpoint with a warmed jar and the headers voyager-web sends. */
export async function voyagerFetch(url, { referer }) {
  if (!jar.has("li_at") || !jar.has("JSESSIONID")) {
    throw new HttpError(
      500,
      "not_configured",
      "LI_COOKIE is missing li_at or JSESSIONID. Copy the whole cookie header from a /voyager/api request.",
    );
  }

  await warmUp(referer);

  const res = await impit.fetch(url, {
    redirect: "manual",
    headers: {
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "accept-language": "en-US,en;q=0.9",
      "csrf-token": jar.csrfToken(),
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
      "x-li-track": trackHeader(),
      // LinkedIn's client mints a fresh tracking id per page view.
      "x-li-page-instance": `urn:li:page:d_flagship3_profile_view_base;${crypto.randomBytes(16).toString("base64")}`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      priority: "u=1, i",
      cookie: jar.toHeader(),
      referer,
    },
  });

  absorb(res);
  persist();
  return res;
}

export const sessionState = () => ({
  hasSession: jar.has("li_at"),
  cookies: [...jar.cookies.keys()],
  warmedAt: warmedAt ? new Date(warmedAt).toISOString() : null,
});
