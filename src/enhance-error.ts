import { AshbyApiError } from "./ashby-client.js";

const PERMISSION_MAP: Record<string, string> = {
  "job.list": "jobsRead",
  "job.info": "jobsRead",
  "jobPosting.info": "jobsRead",
  "candidate.info": "candidatesRead",
  "candidate.search": "candidatesRead",
  "candidate.listNotes": "candidatesRead",
  "candidate.createNote": "candidatesWrite",
  "candidate.addTag": "candidatesWrite",
  "candidate.create": "candidatesWrite",
  "application.create": "candidatesWrite",
  "application.info": "candidatesRead",
  "application.list": "candidatesRead",
  "application.listHistory": "candidatesRead",
  "application.listCriteriaEvaluations": "candidatesRead",
  "application.changeStage": "candidatesWrite",
  "applicationFeedback.list": "candidatesRead",
  "interviewPlan.list": "interviewsRead",
  "interviewStage.list": "interviewsRead",
  "interviewSchedule.list": "interviewsRead",
  "archiveReason.list": "hiringProcessMetadataRead",
  "communicationTemplate.list": "hiringProcessMetadataRead",
  "file.info": "candidatesRead",
  "apiKey.info": "apiKeysRead",
  "sequenceTemplate.list": "sourcingRead",
  "emailSender.list": "sourcingRead",
  "sequence.list": "sourcingRead",
  "candidate.getRecentEmailMessages": "emailsRead",
};

/**
 * Transform an AshbyApiError into an actionable message with guidance
 * on how to fix the issue.
 */
export function enhanceError(err: AshbyApiError): string {
  const base = `Ashby API error: ${err.message}${err.code ? ` (code: ${err.code})` : ""}${err.endpoint ? ` [${err.endpoint}]` : ""}`;

  if (err.httpStatus === 401) {
    return (
      `${base}\n\n` +
      `Your API key appears to be invalid or expired.\n` +
      `- Check that ASHBY_API_KEY is set correctly\n` +
      `- Ashby API keys use Basic auth (the key is base64-encoded automatically)\n` +
      `- Create or rotate your key at: Ashby Admin > Integrations > API Keys`
    );
  }

  if (err.code === "missing_endpoint_permission") {
    const permission = getRequiredPermission(err.endpoint ?? "");
    return (
      `${base}\n\n` +
      `${err.endpoint ?? "This endpoint"} requires ${permission ? `the ${permission} permission` : "an additional API-key permission"}.\n` +
      `Update your key at: Ashby Admin > Integrations > API Keys`
    );
  }

  if (err.httpStatus === 403) {
    return (
      `${base}\n\n` +
      `Access was denied. Check that your API key is active and has permission for this endpoint.\n` +
      `Review your key at: Ashby Admin > Integrations > API Keys`
    );
  }

  if (err.httpStatus === 404) {
    return (
      `${base}\n\n` +
      `The requested resource was not found. Possible causes:\n` +
      `- The ID may be incorrect (Ashby uses UUIDs like "a1b2c3d4-...")\n` +
      `- The resource may have been deleted or archived\n` +
      `- The API endpoint may not exist in your Ashby plan`
    );
  }

  if (err.httpStatus === 422) {
    return (
      `${base}\n\n` +
      `The request was invalid. Check that all required parameters are provided ` +
      `and IDs are valid UUIDs.`
    );
  }

  // Ashby application-level error codes (returned as HTTP 200 with success: false)
  if (err.code === "invalid_input") {
    return (
      `${base}\n\n` +
      `The input was invalid. Common causes:\n` +
      `- The ID is not a valid UUID (Ashby IDs look like "a1b2c3d4-e5f6-...")\n` +
      `- A required field is missing or has the wrong type\n` +
      `- The value is out of the allowed range`
    );
  }

  if (err.code === "not_found") {
    return (
      `${base}\n\n` +
      `The resource was not found. It may have been deleted, or the ID is wrong.`
    );
  }

  if (err.code === "unauthorized" || err.code === "forbidden") {
    return (
      `${base}\n\n` +
      `Permission denied. Check your API key permissions at: Ashby Admin > Integrations > API Keys`
    );
  }

  return base;
}

/**
 * Look up the required Ashby permission for a given API endpoint.
 */
export function getRequiredPermission(endpoint: string): string | undefined {
  return PERMISSION_MAP[endpoint];
}

/**
 * Validate that an Ashby API key looks reasonable.
 * Ashby keys are typically 40+ character alphanumeric strings.
 */
export function validateApiKeyFormat(key: string): { valid: boolean; reason?: string } {
  if (!key || key.trim().length === 0) {
    return { valid: false, reason: "API key is empty" };
  }
  if (key.length < 20) {
    return { valid: false, reason: `API key seems too short (${key.length} chars). Ashby keys are typically 40+ characters.` };
  }
  if (key.startsWith("Bearer ") || key.startsWith("Basic ")) {
    return { valid: false, reason: "API key should be the raw key, not prefixed with 'Bearer' or 'Basic'. The server handles encoding." };
  }
  return { valid: true };
}
