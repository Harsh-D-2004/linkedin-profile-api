/**
 * Fires N profile requests at the API back-to-back and reports on each.
 *
 *   node scripts/test-profiles.mjs
 *   node scripts/test-profiles.mjs https://www.linkedin.com/in/foo/ ...
 *   API_BASE=http://localhost:3001 node scripts/test-profiles.mjs
 *
 * Requests run sequentially and honour the server's 429 + Retry-After, which
 * is what a real client should do. The waits are the rate limiter working.
 */
const API_BASE = process.env.API_BASE || "http://localhost:3000";
const DEFAULT_URLS = [
  "https://www.linkedin.com/in/williamhgates/",
  "https://www.linkedin.com/in/satyanadella/",
];

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_URLS;
const started = Date.now();
const elapsed = () =>
  ((Date.now() - started) / 1000).toFixed(1).padStart(5) + "s";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchProfile(url, attempt = 1) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();

    if (res.status === 429 && attempt <= 3) {
      const waitFor = (Number(res.headers.get("retry-after")) || 30) + 1;
      console.log(`         429 — cooling down ${waitFor}s`);
      await sleep(waitFor * 1000);
      return fetchProfile(url, attempt + 1);
    }

    return { url, status: res.status, body, took: (Date.now() - t0) / 1000 };
  } catch (err) {
    return {
      url,
      status: 0,
      body: { error: err.message },
      took: (Date.now() - t0) / 1000,
    };
  }
}

/** A profile is only useful to a frontend if these are actually populated. */
function validate(profile) {
  const problems = [];
  if (!profile) return ["no profile object"];
  for (const field of ["publicId", "fullName", "profileUrl"]) {
    if (!profile[field]) problems.push(`missing ${field}`);
  }
  for (const field of ["positions", "education", "skills", "certifications"]) {
    if (!Array.isArray(profile[field]))
      problems.push(`${field} is not an array`);
  }
  if (profile.positions?.length === 0)
    problems.push("no positions (may be a visibility limit)");
  return problems;
}

console.log(
  `POST ${API_BASE}/api/profile  x${urls.length}, sequential, honouring 429\n`,
);

const results = [];
for (const url of urls) {
  const result = await fetchProfile(url);
  const slug = url.replace(/\/+$/, "").split("/").pop();
  console.log(
    `[${elapsed()}] ${result.status} ${slug} (${result.took.toFixed(2)}s)`,
  );
  results.push(result);
}

console.log("\n" + "-".repeat(78));
let failed = 0;

for (const { url, status, body } of results) {
  const slug = url.replace(/\/+$/, "").split("/").pop();

  if (status !== 200 || !body.ok) {
    failed++;
    console.log(
      `FAIL  ${slug}\n      ${body.code ?? status}: ${body.error ?? "unknown"}`,
    );
    continue;
  }

  const p = body.profile;
  const problems = validate(p);
  if (problems.length) failed++;

  console.log(
    `${problems.length ? "WARN" : "OK  "}  ${slug} — ${p.fullName} — ${p.location ?? "?"}\n` +
      `      positions ${p.positions.length} | education ${p.education.length} | ` +
      `skills ${p.skills.length} | certs ${p.certifications.length}` +
      (problems.length ? `\n      ${problems.join(", ")}` : ""),
  );
}

console.log("-".repeat(78));
console.log(
  `${results.length - failed}/${results.length} passed in ${elapsed().trim()}`,
);
process.exit(failed ? 1 : 0);
