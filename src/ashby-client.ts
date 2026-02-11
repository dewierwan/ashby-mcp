import type {
  AshbyResponse,
  AshbyListResponse,
  AshbyErrorResponse,
} from "./types.js";
import { logger } from "./logger.js";

const BASE_URL = "https://api.ashbyhq.com";
const API_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

export class AshbyClient {
  private authHeader: string;

  constructor() {
    const apiKey = process.env.ASHBY_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ASHBY_API_KEY environment variable is required. " +
          "Get an API key from your Ashby admin settings."
      );
    }
    this.authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  }

  /** Shared fetch with timeout, retry on 429/5xx, and error handling. */
  private async post(
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<Response> {
    const url = `${BASE_URL}/${endpoint}`;
    const body = JSON.stringify(params ?? {});

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const t0 = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authHeader,
        },
        body,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      const ms = Date.now() - t0;
      if (response.ok) {
        logger.debug("api request", { endpoint, status: response.status, ms });
        return response;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES - 1) {
        logger.error("api request failed", { endpoint, status: response.status, attempt: attempt + 1, ms });
        throw new AshbyApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      // Respect Retry-After header, otherwise use exponential backoff
      const retryAfter = response.headers.get("retry-after");
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000 || BASE_DELAY_MS
        : BASE_DELAY_MS * 2 ** attempt;
      logger.warn("api retry", { endpoint, status: response.status, attempt: attempt + 1, delayMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // Unreachable, but satisfies TypeScript
    throw new AshbyApiError("Max retries exceeded");
  }

  /** Parse an error response into an AshbyApiError. */
  private parseError(data: AshbyErrorResponse): AshbyApiError {
    const message =
      data.errorInfo?.message ??
      data.errors?.join(", ") ??
      "Unknown Ashby API error";
    return new AshbyApiError(message, 200, data.errorInfo?.code);
  }

  /**
   * Make a single request to an Ashby API endpoint.
   * All Ashby endpoints are POST with JSON bodies.
   */
  async request<T>(
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const response = await this.post(endpoint, params);
    const data = (await response.json()) as AshbyResponse<T>;

    if (!data.success) {
      const err = this.parseError(data as AshbyErrorResponse);
      logger.error("api error", { endpoint, code: err.code, message: err.message });
      throw err;
    }

    return (data as { success: true; results: T }).results;
  }

  /**
   * Make a paginated request, returning a single page of results
   * along with pagination metadata.
   */
  async requestList<T>(
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<{
    results: T[];
    moreDataAvailable: boolean;
    nextCursor?: string;
  }> {
    const response = await this.post(endpoint, params);
    const data = (await response.json()) as AshbyListResponse<T>;

    if (!data.success) {
      const err = this.parseError(data as AshbyErrorResponse);
      logger.error("api error", { endpoint, code: err.code, message: err.message });
      throw err;
    }

    const ok = data as {
      success: true;
      results: T[];
      moreDataAvailable: boolean;
      nextCursor?: string;
    };

    return {
      results: ok.results,
      moreDataAvailable: ok.moreDataAvailable,
      nextCursor: ok.nextCursor,
    };
  }
}

export class AshbyApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "AshbyApiError";
  }
}
