import express from "express";
import { fetchProfile } from "./linkedin.js";
import { sessionState, HttpError } from "./session.js";
import { rateLimitState } from "./rate-limit.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...sessionState(), rateLimit: rateLimitState() });
});

app.post("/api/profile", async (req, res, next) => {
  try {
    const { profile, files } = await fetchProfile(req.body?.url);
    res.json({ ok: true, profile, debug: files });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    if (err.details?.retryAfterSeconds) {
      res.set("Retry-After", String(err.details.retryAfterSeconds));
    }
    return res.status(err.status).json({
      ok: false,
      code: err.code,
      error: err.message,
      details: err.details,
    });
  }
  console.error(err);
  res
    .status(500)
    .json({ ok: false, code: "internal_error", error: err.message });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`listening on http://localhost:${port}`));
