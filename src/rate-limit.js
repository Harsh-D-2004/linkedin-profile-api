/**
 * Spaces out calls to LinkedIn. Callers wait rather than being rejected — at
 * a few seconds the wait is short enough to absorb inside the request.
 *
 * The slot is reserved synchronously before any await, so concurrent callers
 * take sequential slots instead of all waking at once.
 */
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS ?? 1000);
const JITTER_MS = Number(process.env.JITTER_MS ?? 9000);

let nextAllowedAt = 0;

/** Resolves when this caller's slot opens. @returns {Promise<number>} ms waited */
export async function waitForSlot() {
  const now = Date.now();
  const slotAt = Math.max(now, nextAllowedAt);

  // Jitter so the cadence is never a clean multiple.
  nextAllowedAt = slotAt + MIN_INTERVAL_MS + Math.random() * JITTER_MS;

  const waitMs = slotAt - now;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return waitMs;
}

export const rateLimitState = () => ({
  minIntervalMs: MIN_INTERVAL_MS,
  jitterMs: JITTER_MS,
  nextSlotInMs: Math.max(0, nextAllowedAt - Date.now()),
});
