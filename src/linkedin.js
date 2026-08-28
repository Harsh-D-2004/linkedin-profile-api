import fs from "node:fs/promises";
import path from "node:path";
import { normalizeProfile } from "./normalize.js";
import { voyagerFetch, HttpError } from "./session.js";
import { waitForSlot } from "./rate-limit.js";

const OUTPUT_DIR = path.resolve(process.cwd(), "output");

function parseProfileUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new HttpError(400, "bad_request", "`url` is required");
  }
  let parsed;
  try {
    parsed = new URL(
      input.trim().startsWith("http")
        ? input.trim()
        : `https://${input.trim()}`,
    );
  } catch {
    throw new HttpError(400, "bad_request", `Not a valid URL: ${input}`);
  }
  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) {
    throw new HttpError(
      400,
      "bad_request",
      `Not a linkedin.com URL: ${parsed.hostname}`,
    );
  }
  // /in/<slug>, with or without a trailing slash, locale subdomains, tracking params.
  const match = parsed.pathname.match(/\/in\/([^/]+)/i);
  if (!match) {
    throw new HttpError(
      400,
      "bad_request",
      "Only personal profile URLs (linkedin.com/in/<slug>) are supported",
    );
  }
  return decodeURIComponent(match[1]);
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function voyagerGet(url, { referer, attempt = 1, maxAttempts = 3 }) {
  const res = await voyagerFetch(url, { referer });

  // voyagerFetch already turns a revoked session into a 401, so any redirect
  // reaching here is something else.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") || "";
    if (/authwall|\/login|checkpoint|uas\/login/i.test(location)) {
      throw new HttpError(401, "linkedin_auth_failed", "Redirected to the auth wall — the session is not logged in");
    }
    throw new HttpError(502, "unexpected_redirect", `Unexpected redirect to ${location}`);
  }

  if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
    // Honour Retry-After when LinkedIn sends it, else exponential backoff + jitter.
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    const backoff =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : 2 ** attempt * 1000 + Math.random() * 1000;
    await sleep(backoff);
    return voyagerGet(url, { referer, attempt: attempt + 1, maxAttempts });
  }

  const body = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new HttpError(401, "linkedin_auth_failed", `LinkedIn returned ${res.status} — cookie rejected or csrf-token mismatch`, { body: body.slice(0, 500) });
  }
  // 999 is "Request denied" — LinkedIn blocking the source IP, almost always a
  // datacenter/cloud ASN. It is not transient and retrying it changes nothing.
  if (res.status === 999) {
    throw new HttpError(
      403,
      "linkedin_ip_blocked",
      "LinkedIn returned 999 — the source IP is blocked. Cloud/datacenter IPs (Render, AWS, GCP) are rejected by ASN; use a residential IP or set PROXY_URL to a residential proxy.",
    );
  }
  if (res.status === 429) {
    throw new HttpError(429, "linkedin_throttled", "LinkedIn returned 429 — rate limited");
  }
  if (res.status === 404) {
    throw new HttpError(404, "profile_not_found", "Profile does not exist or is not visible to this account");
  }
  if (!res.ok) {
    throw new HttpError(502, "linkedin_upstream_error", `LinkedIn returned ${res.status}`, { body: body.slice(0, 500) });
  }
  // A logged-out Voyager call answers 200 with an HTML login page, not JSON.
  if (body.trimStart().startsWith("<")) {
    throw new HttpError(401, "linkedin_auth_failed", "Got HTML instead of JSON — the session is not authenticated");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(502, "invalid_upstream_json", "Could not parse the Voyager response as JSON", { body: body.slice(0, 500) });
  }
}

/**
 * Fetch a profile, normalize it for the frontend, and dump both the raw
 * Voyager graph and the cleaned result to output/ for debugging.
 */
export async function fetchProfile(profileUrl) {
  const slug = parseProfileUrl(profileUrl);
  const referer = `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;

  const url =
    "https://www.linkedin.com/voyager/api/identity/dash/profiles" +
    `?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}` +
    "&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93";

  // One slot per profile, however many HTTP requests it takes.
  await waitForSlot();

  const raw = await voyagerGet(url, { referer });
  const profile = normalizeProfile(raw);

  if (!profile) {
    await writeDebugFile(slug, "raw", raw);
    throw new HttpError(404, "profile_not_found", "No profile in the response — it may be private, deleted, or invisible to this account");
  }

  // const files = {
  //   raw: await writeDebugFile(slug, "raw", raw),
  //   clean: await writeDebugFile(slug, "clean", profile),
  // };

  return { slug, profileUrl: referer, profile };
}

async function writeDebugFile(slug, kind, data) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const safeSlug = slug.replace(/[^a-z0-9_-]/gi, "_");
  const file = path.join(OUTPUT_DIR, `${safeSlug}.${kind}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  return file;
}
