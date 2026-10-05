import { describe, it, expect, vi } from "vitest";
import { AshbyApiError } from "./ashby-client.js";
import { runPool, withBackoff } from "./archive.js";

describe("runPool", () => {
  it("keeps at most `concurrency` calls in flight and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });
    expect(peak).toBe(5);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });
});

describe("withBackoff", () => {
  it("retries 429 and 5xx errors, then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AshbyApiError("rate limited", 429))
      .mockRejectedValueOnce(new AshbyApiError("bad gateway", 502))
      .mockResolvedValueOnce("ok");
    await expect(withBackoff(fn, { baseDelayMs: 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry limit", async () => {
    const fn = vi.fn().mockRejectedValue(new AshbyApiError("rate limited", 429));
    await expect(withBackoff(fn, { retries: 2, baseDelayMs: 0 })).rejects.toThrow("rate limited");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const fn = vi.fn().mockRejectedValue(new AshbyApiError("not found", 404, "not_found"));
    await expect(withBackoff(fn, { baseDelayMs: 0 })).rejects.toThrow("not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
