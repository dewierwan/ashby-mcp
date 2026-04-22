import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import { error, json } from "../tool-helpers.js";

const API_DOCS = `# Ashby API quick reference

Use this when the narrow \`ashby_*\` tools don't cover what you need, and call
\`ashby_call_api\` to hit any endpoint directly. Full reference:
https://developers.ashbyhq.com/reference/

## Basics

- Base URL: \`https://api.ashbyhq.com\`
- All endpoints are **POST** with a JSON body.
- Auth is Basic: \`Authorization: Basic base64(apiKey:)\`. The MCP handles this —
  \`ashby_call_api\` does not take an API key.

## Response envelope

Success:
\`\`\`json
{ "success": true, "results": <object or array>, "moreDataAvailable": false, "nextCursor": null }
\`\`\`

Failure (note: usually returned as HTTP 200):
\`\`\`json
{ "success": false, "errors": ["..."], "errorInfo": { "code": "not_found", "message": "..." } }
\`\`\`

List endpoints include \`moreDataAvailable\` and \`nextCursor\`. To paginate, pass
the previous \`nextCursor\` back as \`cursor\` in the next call.

## Endpoint index

Endpoints the MCP already wraps natively are marked ✓ — prefer the dedicated
tool for those. The rest are reachable via \`ashby_call_api\`.

### Jobs (permission: \`jobsRead\`)
- \`job.list\` ✓ — list jobs. Params: \`limit\`, \`cursor\`, \`status\` (omit for All).
- \`job.info\` ✓ — single job. Params: \`id\` (NOT \`jobId\`).
- \`jobPosting.list\` — list job postings. Params: \`limit\`, \`cursor\`.
- \`jobPosting.info\` — single posting. Params: \`jobPostingId\`.
- \`jobPosting.update\` — edit a posting (permission: \`jobsWrite\`).
- \`hiringTeam.addMember\` — add member to a job's hiring team.

### Candidates (permission: \`candidatesRead\` / \`candidatesWrite\`)
- \`candidate.search\` ✓ — search by name/email.
- \`candidate.info\` ✓ — single candidate. Params: \`id\` (NOT \`candidateId\`).
- \`candidate.list\` — list all candidates. Params: \`limit\`, \`cursor\`, \`syncToken\`.
- \`candidate.create\` ✓ (via \`ashby_add_lead\`) — create a candidate.
- \`candidate.update\` — edit candidate fields (write).
- \`candidate.createNote\` ✓ — add a note (write).
- \`candidate.listNotes\` ✓ — list notes.
- \`candidate.addTag\` ✓ — tag candidate (write).
- \`candidate.removeTag\` — untag candidate (write).
- \`candidate.anonymize\` — GDPR anonymize (write).
- \`candidateTag.list\` — list all tags.

### Applications (permission: \`candidatesRead\` / \`candidatesWrite\`)
- \`application.list\` ✓ — list applications. Params: \`limit\`, \`cursor\`,
  \`jobId\`, \`status\`, \`stageType\`, \`stageName\`, \`source\`, \`createdAfter\`,
  \`createdBefore\`.
- \`application.info\` ✓ — single application. Params: \`applicationId\`.
- \`application.create\` — create application (write).
- \`application.changeStage\` ✓ — move stage (write).
- \`application.archive\` ✓ — archive (write).
- \`application.listHistory\` — stage-change history.
- \`application.listCriteriaEvaluations\` — scorecard evaluations.
- \`applicationFeedback.list\` ✓ — list submitted feedback.
- \`applicationFormSubmission.list\` ✓ — candidate form responses.

### Interviews (permission: \`interviewsRead\`)
- \`interviewPlan.list\` — list all interview plans.
- \`interviewStage.list\` ✓ — stages. **Requires \`interviewPlanId\`.**
- \`interviewSchedule.list\` ✓ — upcoming interviews. Params: \`startAfter\`,
  \`startBefore\`, \`status\`.
- \`interview.list\` — list interview types.

### Offers (permission: \`offersRead\` / \`offersWrite\`)
- \`offer.list\` — list offers.
- \`offer.info\` — single offer. Params: \`offerId\`.
- \`offer.create\` — create offer (write).
- \`offer.update\` — edit offer (write).

### Metadata (permission: \`hiringProcessMetadataRead\`)
- \`archiveReason.list\` ✓ — list archive/rejection reasons.
- \`communicationTemplate.list\` ✓ — list email templates.
- \`department.list\` — list departments.
- \`location.list\` — list locations.
- \`source.list\` — list candidate sources.
- \`user.list\` — list Ashby users (hiring team).

### Files
- \`file.info\` — download a file (resume, etc.). Params: \`fileHandle\`.

### Surveys / referrals (if enabled)
- \`survey.list\`, \`surveySubmission.list\`, \`referral.list\`.

## Common gotchas

- Many \`*.info\` endpoints take \`id\`, not a named id like \`jobId\` or
  \`candidateId\`. When in doubt, try \`id\` first.
- \`job.list\` rejects \`status: "All"\` — omit the param to fetch every status.
- \`interviewStage.list\` requires \`interviewPlanId\`; get this from \`job.info\`
  (\`defaultInterviewPlanId\` or \`interviewPlanIds\`) or \`interviewPlan.list\`.
- Pagination: pass \`limit\` (max 100) and repeat with \`cursor\` while
  \`moreDataAvailable\` is \`true\`.
- Write endpoints fail with \`forbidden\` / HTTP 403 if the API key lacks the
  matching \`*Write\` permission — fix in Ashby Admin > Integrations > API Keys.
- Errors are often HTTP 200 with \`success: false\`. Always check the envelope.
`;

export function registerEscapeHatchTools(
  server: McpServer,
  client: AshbyClient
): void {
  // ── ashby_call_api ───────────────────────────────────────────────────

  server.tool(
    "ashby_call_api",
    `Call any Ashby API endpoint directly. Escape hatch for endpoints the
narrow ashby_* tools don't wrap (e.g. offer.list, user.list, department.list,
interviewPlan.list, candidate.update).

Prefer the dedicated tool when one exists — they return cleaner, summarised
data. Use this when you need an endpoint that has no dedicated tool.

Call ashby_get_api_docs first if you're not sure which endpoint to use.

Handles auth, retries, and timeouts automatically. Returns the raw Ashby
response including \`success\`, \`results\`, \`moreDataAvailable\`, \`nextCursor\`,
and any error details — nothing is stripped.`,
    {
      endpoint: z
        .string()
        .min(1)
        .describe(
          'Ashby endpoint path, e.g. "job.list", "candidate.info", "offer.list". No leading slash.'
        ),
      params: z
        .record(z.unknown())
        .optional()
        .describe(
          "JSON body to POST. Defaults to {}. See ashby_get_api_docs for per-endpoint parameter names."
        ),
    },
    { destructiveHint: true },
    async ({ endpoint, params }) => {
      try {
        const body = await client.rawRequest(endpoint, params ?? {});
        const envelope = body as {
          success?: boolean;
          errorInfo?: { code?: string; message?: string };
          errors?: string[];
          results?: unknown;
          moreDataAvailable?: boolean;
          nextCursor?: string | null;
        };

        if (envelope?.success === false) {
          const msg =
            envelope.errorInfo?.message ??
            envelope.errors?.join(", ") ??
            "unknown error";
          return json(
            `Ashby ${endpoint} returned success: false — ${msg}`,
            body
          );
        }

        const resultCount = Array.isArray(envelope?.results)
          ? envelope.results.length
          : envelope?.results !== undefined
          ? 1
          : 0;
        const more = envelope?.moreDataAvailable ? " (more available)" : "";
        return json(
          `Ashby ${endpoint} returned ${resultCount} result(s)${more}.`,
          body
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_api_docs ───────────────────────────────────────────────

  server.tool(
    "ashby_get_api_docs",
    `Return a reference for the Ashby API: base URL, auth, response envelope,
pagination, and a curated endpoint index with parameter hints and common
gotchas.

Call this before ashby_call_api when you're unsure which endpoint or param
names to use. The full official reference is at
https://developers.ashbyhq.com/reference/.`,
    {},
    { readOnlyHint: true },
    async () => {
      return {
        content: [{ type: "text" as const, text: API_DOCS }],
      };
    }
  );
}
