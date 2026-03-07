import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import { AshbyApiError } from "../ashby-client.js";
import type {
  Application,
  ApplicationHistoryEntry,
  CriteriaEvaluation,
  ApplicationFeedback,
  Job,
  InterviewStage,
} from "../types.js";
import { error, json } from "../tool-helpers.js";
import { logger } from "../logger.js";

export function registerApplicationTools(server: McpServer, client: AshbyClient): void {
  // ── ashby_list_candidates_for_job ────────────────────────────────────

  server.tool(
    "ashby_list_candidates_for_job",
    `List all candidates/applications for a specific job.

Returns each application with the candidate's name, current interview stage, and status.
Use this to see the pipeline for a job. Pass next_cursor to paginate.

Response: items[] (application_id, candidate_id, candidate_name, status, current_stage, source, createdAt), has_more, next_cursor.`,
    {
      job_id: z.string().describe("The job ID (UUID) to list candidates for."),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max results per page (1-100). Defaults to 25."),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response."),
    },
    { readOnlyHint: true },
    async ({ job_id, limit, cursor }) => {
      try {
        const params: Record<string, unknown> = { jobId: job_id, limit };
        if (cursor) params.cursor = cursor;

        const page = await client.requestList<Application>("application.list", params);

        const items = page.results.map((app) => ({
          application_id: app.id,
          candidate_id: app.candidate.id,
          candidate_name: app.candidate.name,
          candidate_email: app.candidate.primaryEmailAddress?.value ?? null,
          status: app.status,
          current_stage: app.currentInterviewStage
            ? {
                id: app.currentInterviewStage.id,
                title: app.currentInterviewStage.title,
                type: app.currentInterviewStage.type,
              }
            : null,
          source: app.source?.title ?? null,
          createdAt: app.createdAt,
        }));

        return json(
          `${items.length} application(s) for this job.`,
          { items, has_more: page.moreDataAvailable, next_cursor: page.nextCursor ?? null }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_application_details ────────────────────────────────────

  server.tool(
    "ashby_get_application_details",
    `Get full application details including stage history, hiring team, feedback, and criteria evaluations.

Use this to deep-dive into a specific application. Fires four API calls concurrently for speed.

Response: application (id, status, candidate, job, current_stage, hiringTeam, source, customFields), stage_history[], criteria_evaluations[], feedback[].`,
    {
      application_id: z.string().describe("The application ID (UUID) to fetch."),
    },
    { readOnlyHint: true },
    async ({ application_id }) => {
      try {
        const [appInfo, historyPage, criteriaPage, feedbackPage] = await Promise.all([
          client.request<Application>("application.info", { applicationId: application_id }),
          client
            .requestList<ApplicationHistoryEntry>("application.listHistory", { applicationId: application_id })
            .catch((e) => {
              logger.warn("failed to fetch application history", { applicationId: application_id, error: e instanceof Error ? e.message : String(e) });
              return { results: [] as ApplicationHistoryEntry[], moreDataAvailable: false };
            }),
          client
            .requestList<CriteriaEvaluation>("application.listCriteriaEvaluations", { applicationId: application_id })
            .catch((e) => {
              logger.warn("failed to fetch criteria evaluations", { applicationId: application_id, error: e instanceof Error ? e.message : String(e) });
              return { results: [] as CriteriaEvaluation[], moreDataAvailable: false };
            }),
          client
            .requestList<ApplicationFeedback>("applicationFeedback.list", { applicationId: application_id })
            .catch((e) => {
              logger.warn("failed to fetch feedback", { applicationId: application_id, error: e instanceof Error ? e.message : String(e) });
              return { results: [] as ApplicationFeedback[], moreDataAvailable: false };
            }),
        ]);

        const data = {
          application: {
            id: appInfo.id,
            status: appInfo.status,
            candidate: {
              id: appInfo.candidate.id,
              name: appInfo.candidate.name,
              email: appInfo.candidate.primaryEmailAddress?.value ?? null,
            },
            job: { id: appInfo.job.id, title: appInfo.job.title },
            current_stage: appInfo.currentInterviewStage
              ? {
                  id: appInfo.currentInterviewStage.id,
                  title: appInfo.currentInterviewStage.title,
                  type: appInfo.currentInterviewStage.type,
                  order: appInfo.currentInterviewStage.orderInInterviewPlan,
                }
              : null,
            hiringTeam: (appInfo.hiringTeam ?? []).map((m) => ({
              name: `${m.firstName} ${m.lastName}`,
              email: m.email,
              role: m.role,
            })),
            source: appInfo.source?.title ?? null,
            customFields: appInfo.customFields ?? [],
            resumeFileHandle: appInfo.resumeFileHandle ?? null,
            createdAt: appInfo.createdAt,
            updatedAt: appInfo.updatedAt,
          },
          stage_history: historyPage.results.map((h) => ({
            stageId: h.stageId,
            title: h.title,
            enteredAt: h.enteredStageAt,
            leftAt: h.leftStageAt ?? null,
            stageNumber: h.stageNumber,
          })),
          criteria_evaluations: criteriaPage.results,
          feedback: feedbackPage.results,
        };

        return json(
          `Application for ${appInfo.candidate.name} → ${appInfo.job.title} (${appInfo.status}).`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_application_form_submission ─────────────────────────────

  server.tool(
    "ashby_get_application_form_submission",
    `Get a candidate's submitted application form responses for a specific application.

Use this to read what a candidate actually wrote in their application — their answers to screening questions,
cover letter text, and any other form fields.
Use after ashby_list_candidates_for_job or ashby_get_application_details when you need to evaluate a candidate's application content.

Response: application_id, candidate_name, job_title, form_responses[] (question, field_type, answer).`,
    {
      application_id: z.string().describe("The application ID (UUID) to fetch form responses for."),
    },
    { readOnlyHint: true },
    async ({ application_id }) => {
      try {
        const app = await client.request<{
          id: string;
          candidate: { name: string };
          job: { title: string };
          applicationFormSubmissions?: Array<{
            formDefinition: {
              sections: Array<{
                fields: Array<{
                  field: { title: string; type: string; path: string };
                }>;
              }>;
            };
            submittedValues: Record<string, unknown>;
          }>;
        }>("application.info", {
          applicationId: application_id,
          expand: ["applicationFormSubmissions"],
        });

        const submissions = app.applicationFormSubmissions ?? [];
        if (submissions.length === 0) {
          return json(
            `No application form submission found for ${app.candidate.name}.`,
            {
              application_id: app.id,
              candidate_name: app.candidate.name,
              job_title: app.job.title,
              form_responses: [],
              message: "No application form submission found for this application.",
            }
          );
        }

        // Build path->title+type lookup from the form definition
        const fieldMap = new Map<string, { title: string; type: string }>();
        for (const sub of submissions) {
          for (const section of sub.formDefinition.sections) {
            for (const f of section.fields) {
              fieldMap.set(f.field.path, { title: f.field.title, type: f.field.type });
            }
          }
        }

        // Map submitted values to readable question/answer pairs
        const formResponses: Array<{ question: string; field_type: string; answer: string }> = [];
        for (const sub of submissions) {
          for (const [path, value] of Object.entries(sub.submittedValues)) {
            const field = fieldMap.get(path);
            const question = field?.title ?? path;
            const fieldType = field?.type ?? "unknown";

            // Format the answer based on type
            let answer: string;
            if (value === null || value === undefined) {
              answer = "(empty)";
            } else if (typeof value === "boolean") {
              answer = value ? "Yes" : "No";
            } else if (typeof value === "object" && value !== null && "text" in value) {
              answer = String((value as { text: string }).text);
            } else if (typeof value === "object") {
              answer = JSON.stringify(value);
            } else {
              answer = String(value);
            }

            formResponses.push({ question, field_type: fieldType, answer });
          }
        }

        const data = {
          application_id: app.id,
          candidate_name: app.candidate.name,
          job_title: app.job.title,
          form_responses: formResponses,
        };

        return json(
          `${formResponses.length} form response(s) for ${app.candidate.name}'s application to ${app.job.title}.`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_list_applications ──────────────────────────────────────────

  server.tool(
    "ashby_list_applications",
    `List applications across all jobs with date, status, stage, and source filters.

Use this to answer operational questions like "How many people applied this week?",
"Show me all candidates in Application Review", or "Who applied via the Chrome extension?"
Date and status filtering happens server-side for efficiency. Stage and source filters are applied by the MCP server.

Response: items[] (application_id, candidate_id, candidate_name, candidate_email, status, current_stage, source, job_id, job_title, createdAt), has_more, next_cursor.`,
    {
      created_after: z
        .string()
        .optional()
        .describe("ISO datetime — only applications created after this timestamp (e.g. 2024-01-01T00:00:00Z)."),
      created_before: z
        .string()
        .optional()
        .describe("ISO datetime — only applications created before this timestamp. Filtered client-side."),
      job_id: z.string().optional().describe("Filter to a specific job (UUID)."),
      status: z
        .enum(["Active", "Archived", "Hired", "Lead", "All"])
        .default("All")
        .describe("Filter by application status. Defaults to All."),
      stage_type: z
        .enum(["Lead", "PreInterviewScreen", "Interview", "Offer", "All"])
        .optional()
        .describe("Filter by interview stage type (e.g. Lead, PreInterviewScreen, Interview, Offer)."),
      stage_name: z
        .string()
        .optional()
        .describe("Filter by exact interview stage name (e.g. 'Work test', 'Application Review')."),
      source: z
        .string()
        .optional()
        .describe("Filter by source title (e.g. 'Applied', 'Ashby Chrome Extension'). Case-insensitive substring match."),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max results to return (1-100). Defaults to 25."),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response."),
    },
    { readOnlyHint: true },
    async ({ created_after, created_before, job_id, status, stage_type, stage_name, source, limit, cursor }) => {
      try {
        const needsClientFilter = !!(created_before || stage_type || stage_name || source);

        // Build server-side params
        const params: Record<string, unknown> = {};
        if (created_after) params.createdAfter = new Date(created_after).getTime();
        if (job_id) params.jobId = job_id;
        if (status !== "All") params.status = status;
        if (cursor) params.cursor = cursor;

        // If we need client-side filtering, fetch larger batches internally
        const fetchLimit = needsClientFilter ? 100 : limit;
        params.limit = fetchLimit;

        const items: Array<{
          application_id: string;
          candidate_id: string;
          candidate_name: string;
          candidate_email: string | null;
          status: string;
          current_stage: { id: string; title: string; type: string } | null;
          source: string | null;
          job_id: string;
          job_title: string;
          createdAt: string;
        }> = [];

        let nextCursor: string | undefined = cursor;
        let hasMore = false;

        // Paginate internally until we have enough matching results
        while (items.length < limit) {
          if (nextCursor) params.cursor = nextCursor;

          const page = await client.requestList<Application>("application.list", params);

          for (const app of page.results) {
            // Client-side filters
            if (created_before && app.createdAt > created_before) continue;
            if (stage_type && stage_type !== "All" && app.currentInterviewStage?.type !== stage_type) continue;
            if (stage_name && app.currentInterviewStage?.title !== stage_name) continue;
            if (source && !(app.source?.title ?? "").toLowerCase().includes(source.toLowerCase())) continue;

            items.push({
              application_id: app.id,
              candidate_id: app.candidate.id,
              candidate_name: app.candidate.name,
              candidate_email: app.candidate.primaryEmailAddress?.value ?? null,
              status: app.status,
              current_stage: app.currentInterviewStage
                ? {
                    id: app.currentInterviewStage.id,
                    title: app.currentInterviewStage.title,
                    type: app.currentInterviewStage.type,
                  }
                : null,
              source: app.source?.title ?? null,
              job_id: app.job.id,
              job_title: app.job.title,
              createdAt: app.createdAt,
            });

            if (items.length >= limit) break;
          }

          hasMore = page.moreDataAvailable;
          nextCursor = page.nextCursor;

          // Stop if no more data from the API
          if (!page.moreDataAvailable) break;
        }

        const result = items.slice(0, limit);

        return json(
          `${result.length} application(s) found.`,
          { items: result, has_more: hasMore || items.length > limit, next_cursor: nextCursor ?? null }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_archive_application ────────────────────────────────────────

  server.tool(
    "ashby_archive_application",
    `Archive an application with an optional reason and rejection email.

Workflow: call ashby_list_archive_reasons to pick a reason, then ashby_list_email_templates to pick an email template, then call this tool.
Automatically resolves the correct "Archived" interview stage for the application's job.

Response: application_id, status, archive_reason_id, email_sent, message.`,
    {
      application_id: z.string().describe("The application ID (UUID) to archive."),
      archive_reason_id: z
        .string()
        .optional()
        .describe("Archive reason ID from ashby_list_archive_reasons."),
      send_email: z
        .boolean()
        .default(false)
        .describe("Whether to send a rejection email. Requires email_template_id."),
      email_template_id: z
        .string()
        .optional()
        .describe("Communication template ID from ashby_list_email_templates. Required when send_email is true."),
    },
    { destructiveHint: true },
    async ({ application_id, archive_reason_id, send_email, email_template_id }) => {
      try {
        if (send_email && !email_template_id) {
          return json(
            "email_template_id is required when send_email is true.",
            { error: "email_template_id is required when send_email is true. Use ashby_list_email_templates to find available templates." }
          );
        }

        // 1. Get application to find its interview plan
        const app = await client.request<Application>("application.info", { applicationId: application_id });

        // 2. Resolve the interview plan ID
        let interviewPlanId = app.currentInterviewStage?.interviewPlanId;
        if (!interviewPlanId) {
          const job = await client.request<Job>("job.info", { id: app.job.id });
          interviewPlanId = (job.interviewPlanIds ?? [])[0] ?? job.defaultInterviewPlanId;
        }
        if (!interviewPlanId) {
          return json(
            `Could not determine interview plan for application ${application_id}.`,
            { error: `Could not determine interview plan for application ${application_id}.` }
          );
        }

        // 3. Find the "Archived" stage in this plan
        const stagePage = await client.requestList<InterviewStage>("interviewStage.list", { interviewPlanId });
        const archivedStage = stagePage.results.find((s) => s.type === "Archived");
        if (!archivedStage) {
          return json(
            `No archived stage found in interview plan ${interviewPlanId}.`,
            { error: `No archived stage found in interview plan ${interviewPlanId}.` }
          );
        }

        // 4. Build the changeStage request
        const params: Record<string, unknown> = {
          applicationId: application_id,
          interviewStageId: archivedStage.id,
        };
        if (archive_reason_id) params.archiveReasonId = archive_reason_id;
        if (send_email && email_template_id) {
          params.archiveEmail = { communicationTemplateId: email_template_id };
        }

        const result = await client.request<Application>("application.changeStage", params);
        const msg = `Application ${result.id} archived${archive_reason_id ? " with reason" : ""}${send_email ? " and rejection email queued" : ""}.`;

        return json(msg, {
          application_id: result.id,
          status: result.status,
          archive_reason_id: archive_reason_id ?? null,
          email_sent: send_email && !!email_template_id,
          message: msg,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_bulk_archive ───────────────────────────────────────────────

  server.tool(
    "ashby_bulk_archive",
    `Archive multiple applications at once with an optional reason and rejection email.

Accepts up to 25 application IDs. Uses the same archiving logic as ashby_archive_application for each one.
Caches interview plan lookups for efficiency when applications share the same job.

Response: total, succeeded, failed, results[] (application_id, success, error?).`,
    {
      application_ids: z
        .array(z.string())
        .min(1)
        .max(25)
        .describe("Array of application IDs (UUIDs) to archive. Max 25."),
      archive_reason_id: z
        .string()
        .optional()
        .describe("Archive reason ID from ashby_list_archive_reasons. Applied to all."),
      send_email: z
        .boolean()
        .default(false)
        .describe("Whether to send rejection emails. Requires email_template_id."),
      email_template_id: z
        .string()
        .optional()
        .describe("Communication template ID from ashby_list_email_templates. Required when send_email is true."),
    },
    { destructiveHint: true },
    async ({ application_ids, archive_reason_id, send_email, email_template_id }) => {
      try {
        if (send_email && !email_template_id) {
          return json(
            "email_template_id is required when send_email is true.",
            { error: "email_template_id is required when send_email is true. Use ashby_list_email_templates to find available templates." }
          );
        }

        // Cache: interviewPlanId -> archived stage ID
        const archivedStageCache = new Map<string, string>();

        async function archiveOne(appId: string): Promise<{ application_id: string; success: boolean; error?: string }> {
          // 1. Get application
          const app = await client.request<Application>("application.info", { applicationId: appId });

          // 2. Resolve interview plan ID
          let planId = app.currentInterviewStage?.interviewPlanId;
          if (!planId) {
            const job = await client.request<Job>("job.info", { id: app.job.id });
            planId = (job.interviewPlanIds ?? [])[0] ?? job.defaultInterviewPlanId;
          }
          if (!planId) {
            return { application_id: appId, success: false, error: "Could not determine interview plan." };
          }

          // 3. Find archived stage (cached)
          let archivedStageId = archivedStageCache.get(planId);
          if (!archivedStageId) {
            const stagePage = await client.requestList<InterviewStage>("interviewStage.list", { interviewPlanId: planId });
            const archived = stagePage.results.find((s) => s.type === "Archived");
            if (!archived) {
              return { application_id: appId, success: false, error: `No archived stage in plan ${planId}.` };
            }
            archivedStageId = archived.id;
            archivedStageCache.set(planId, archivedStageId);
          }

          // 4. Archive
          const params: Record<string, unknown> = {
            applicationId: appId,
            interviewStageId: archivedStageId,
          };
          if (archive_reason_id) params.archiveReasonId = archive_reason_id;
          if (send_email && email_template_id) {
            params.archiveEmail = { communicationTemplateId: email_template_id };
          }

          await client.request<Application>("application.changeStage", params);
          return { application_id: appId, success: true };
        }

        // Process in batches of 5
        const results: Array<{ application_id: string; success: boolean; error?: string }> = [];
        for (let i = 0; i < application_ids.length; i += 5) {
          const batch = application_ids.slice(i, i + 5);
          const batchResults = await Promise.all(
            batch.map((appId) =>
              archiveOne(appId).catch((e) => ({
                application_id: appId,
                success: false,
                error: e instanceof AshbyApiError
                  ? `Ashby API error: ${e.message}${e.code ? ` (${e.code})` : ""}`
                  : e instanceof Error ? e.message : String(e),
              }))
            )
          );
          results.push(...batchResults);
        }

        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return json(
          `Bulk archive: ${succeeded} succeeded, ${failed} failed out of ${results.length}.`,
          { total: results.length, succeeded, failed, results }
        );
      } catch (e) {
        return error(e);
      }
    }
  );
}
