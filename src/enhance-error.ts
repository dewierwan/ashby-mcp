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
};

/**
 * Transform an AshbyApiError into an actionable message with guidance
 * on how to fix the issue.
 */
export function enhanceError(err: AshbyApiError): string {
  const base = `Ashby API error: ${err.message}${err.code ? ` (code: ${err.code})` : ""}`;

  if (err.httpStatus === 401) {
    return (
      `${base}\n\n` +
      `Your API key appears to be invalid or expired.\n` +
      `- Check that ASHBY_API_KEY is set correctly\n` +
      `- Ashby API keys use Basic auth (the key is base64-encoded automatically)\n` +
      `- Create or rotate your key at: Ashby Admin > Integrations > API Keys`
    );
  }

  if (err.httpStatus === 403) {
    return (
      `${base}\n\n` +
      `Your API key lacks the required permission.\n` +
      `Required permissions for common operations:\n` +
      `- candidatesRead: read candidate profiles, applications, notes, feedback\n` +
      `- candidatesWrite: add notes, tags, move stages, archive\n` +
      `- jobsRead: read jobs and job postings\n` +
      `- interviewsRead: read interview stages, plans, and schedules\n` +
      `- hiringProcessMetadataRead: list archive reasons and email templates\n` +
      `Update your key at: Ashby Admin > Integrations > API Keys`
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
