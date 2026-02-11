import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AshbyClient, AshbyApiError } from "./ashby-client.js";

// Helper to create a mock Response
function mockResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText(status),
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response;
}

function statusText(code: number): string {
  const map: Record<number, string> = {
    200: "OK", 400: "Bad Request", 404: "Not Found",
    429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable",
  };
  return map[code] ?? "Unknown";
}

describe("AshbyClient", () => {
  let originalEnv: string | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = process.env.ASHBY_API_KEY;
    process.env.ASHBY_API_KEY = "test-api-key";
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ASHBY_API_KEY = originalEnv;
    } else {
      delete process.env.ASHBY_API_KEY;
    }
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when ASHBY_API_KEY is missing", () => {
      delete process.env.ASHBY_API_KEY;
      expect(() => new AshbyClient()).toThrow("ASHBY_API_KEY");
    });

    it("creates client when API key is set", () => {
      expect(() => new AshbyClient()).not.toThrow();
    });
  });

  describe("request()", () => {
    it("returns unwrapped results on success", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(200, { success: true, results: { id: "job-1", title: "Engineer" } })
      );

      const client = new AshbyClient();
      const result = await client.request<{ id: string; title: string }>("job.info", { id: "job-1" });

      expect(result).toEqual({ id: "job-1", title: "Engineer" });
    });

    it("sends POST with correct headers and body", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(200, { success: true, results: {} })
      );

      const client = new AshbyClient();
      await client.request("job.info", { id: "abc" });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.ashbyhq.com/job.info");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers.Authorization).toMatch(/^Basic /);
      expect(JSON.parse(opts.body)).toEqual({ id: "abc" });
    });

    it("throws AshbyApiError on API-level error (success: false)", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse(200, {
          success: false,
          errors: ["candidate_not_found"],
          errorInfo: { code: "not_found", message: "Candidate not found" },
        })
      );

      const client = new AshbyClient();
      try {
        await client.request("candidate.info", { id: "bad" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AshbyApiError);
        expect((e as AshbyApiError).message).toBe("Candidate not found");
        expect((e as AshbyApiError).code).toBe("not_found");
      }
    });

    it("throws AshbyApiError on HTTP error", async () => {
      fetchSpy.mockResolvedValue(mockResponse(400, {}));

      const client = new AshbyClient();
      await expect(client.request("bad.endpoint", {})).rejects.toThrow(AshbyApiError);

      try {
        await client.request("bad.endpoint", {});
      } catch (e) {
        expect((e as AshbyApiError).httpStatus).toBe(400);
      }
    });
  });

  describe("requestList()", () => {
    it("returns results with pagination metadata", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(200, {
          success: true,
          results: [{ id: "1" }, { id: "2" }],
          moreDataAvailable: true,
          nextCursor: "cursor-abc",
        })
      );

      const client = new AshbyClient();
      const page = await client.requestList<{ id: string }>("job.list", { limit: 2 });

      expect(page.results).toHaveLength(2);
      expect(page.moreDataAvailable).toBe(true);
      expect(page.nextCursor).toBe("cursor-abc");
    });

    it("throws AshbyApiError on API-level error", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(200, { success: false, errors: ["invalid_request"] })
      );

      const client = new AshbyClient();
      await expect(client.requestList("job.list", {})).rejects.toThrow(AshbyApiError);
    });
  });

  describe("retry logic", () => {
    it("retries on 429 and eventually succeeds", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(429, {}))
        .mockResolvedValueOnce(mockResponse(200, { success: true, results: { ok: true } }));

      const client = new AshbyClient();
      const result = await client.request<{ ok: boolean }>("test", {});

      expect(result).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("retries on 500 and eventually succeeds", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(500, {}))
        .mockResolvedValueOnce(mockResponse(200, { success: true, results: "ok" }));

      const client = new AshbyClient();
      const result = await client.request<string>("test", {});

      expect(result).toBe("ok");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 400", async () => {
      fetchSpy.mockResolvedValue(mockResponse(400, {}));

      const client = new AshbyClient();
      await expect(client.request("test", {})).rejects.toThrow(AshbyApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 404", async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, {}));

      const client = new AshbyClient();
      await expect(client.request("test", {})).rejects.toThrow(AshbyApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("gives up after MAX_RETRIES (3) attempts", async () => {
      fetchSpy.mockResolvedValue(mockResponse(503, {}));

      const client = new AshbyClient();
      await expect(client.request("test", {})).rejects.toThrow("HTTP 503");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("respects Retry-After header", async () => {
      const start = Date.now();
      fetchSpy
        .mockResolvedValueOnce(mockResponse(429, {}, { "retry-after": "1" }))
        .mockResolvedValueOnce(mockResponse(200, { success: true, results: "ok" }));

      const client = new AshbyClient();
      await client.request("test", {});

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s retry
    });
  });

  describe("timeout", () => {
    it("passes AbortSignal.timeout to fetch", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(200, { success: true, results: {} })
      );

      const client = new AshbyClient();
      await client.request("test", {});

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.signal).toBeDefined();
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

describe("AshbyApiError", () => {
  it("has correct properties", () => {
    const err = new AshbyApiError("test error", 429, "rate_limit");
    expect(err.name).toBe("AshbyApiError");
    expect(err.message).toBe("test error");
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe("rate_limit");
    expect(err).toBeInstanceOf(Error);
  });
});
