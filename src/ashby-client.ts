import type {
  AshbyResponse,
  AshbyListResponse,
  AshbyErrorResponse,
} from "./types.js";

const BASE_URL = "https://api.ashbyhq.com";

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

  /**
   * Make a single request to an Ashby API endpoint.
   * All Ashby endpoints are POST with JSON bodies.
   */
  async request<T>(
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const url = `${BASE_URL}/${endpoint}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify(params ?? {}),
    });

    if (!response.ok) {
      throw new AshbyApiError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status
      );
    }

    const data = (await response.json()) as AshbyResponse<T>;

    if (!data.success) {
      const err = data as AshbyErrorResponse;
      const message =
        err.errorInfo?.message ??
        err.errors?.join(", ") ??
        "Unknown Ashby API error";
      throw new AshbyApiError(message, 200, err.errorInfo?.code);
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
    const url = `${BASE_URL}/${endpoint}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify(params ?? {}),
    });

    if (!response.ok) {
      throw new AshbyApiError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status
      );
    }

    const data = (await response.json()) as AshbyListResponse<T>;

    if (!data.success) {
      const err = data as AshbyErrorResponse;
      const message =
        err.errorInfo?.message ??
        err.errors?.join(", ") ??
        "Unknown Ashby API error";
      throw new AshbyApiError(message, 200, err.errorInfo?.code);
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

  /**
   * Async generator that yields items across all pages.
   * Useful when you need to collect all results.
   */
  async *paginate<T>(
    endpoint: string,
    params?: Record<string, unknown>
  ): AsyncGenerator<T> {
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const reqParams: Record<string, unknown> = { ...params };
      if (cursor) {
        reqParams.cursor = cursor;
      }

      const page = await this.requestList<T>(endpoint, reqParams);
      for (const item of page.results) {
        yield item;
      }

      hasMore = page.moreDataAvailable;
      cursor = page.nextCursor;
    }
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
