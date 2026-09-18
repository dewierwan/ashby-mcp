import { describe, it, expect } from "vitest";
import { AshbyApiError } from "./ashby-client.js";
import { enhanceError } from "./enhance-error.js";

describe("permission errors", () => {
  it.each([
    ["apiKey.info", "apiKeysRead"],
    ["sequenceTemplate.list", "sourcingRead"],
    ["emailSender.list", "sourcingRead"],
    ["sequence.list", "sourcingRead"],
    ["candidate.getRecentEmailMessages", "emailsRead"],
  ])("names the required permission for %s", (endpoint, permission) => {
    const message = enhanceError(new AshbyApiError(
      "HTTP 403: Forbidden", 403, "missing_endpoint_permission", endpoint
    ));
    expect(message).toContain(endpoint);
    expect(message).toContain(permission);
    expect(message).toContain("Ashby Admin > Integrations > API Keys");
  });

  it("does not claim every 403 is a missing permission", () => {
    const message = enhanceError(new AshbyApiError("HTTP 403: Forbidden", 403));
    expect(message).not.toContain("Your API key lacks the required permission");
    expect(message).toContain("active");
  });

  it("handles unknown endpoints without guessing a permission", () => {
    const message = enhanceError(new AshbyApiError(
      "HTTP 403: Forbidden", 403, "missing_endpoint_permission", "unknown.endpoint"
    ));
    expect(message).toContain("unknown.endpoint");
    expect(message).not.toContain("undefined");
    expect(message).toContain("Ashby Admin > Integrations > API Keys");
  });
});
