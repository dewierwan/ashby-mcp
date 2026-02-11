import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { AshbyClient, AshbyApiError } from "./ashby-client.js";
import { extractPdfText } from "./pdf.js";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
import type {
  Job,
  Application,
  Candidate,
  CandidateNote,
  InterviewStage,
  InterviewPlan,
  ApplicationHistoryEntry,
  CriteriaEvaluation,
  ApplicationFeedback,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type ToolResult = { content: { type: "text"; text: string }[] };

function error(e: unknown): ToolResult {
  const msg =
    e instanceof AshbyApiError
      ? `Ashby API error: ${e.message}${e.code ? ` (code: ${e.code})` : ""}`
      : `Error: ${e instanceof Error ? e.message : String(e)}`;
  return { content: [{ type: "text" as const, text: msg }] };
}

function json(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ─── Server factory ─────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ashby",
    version,
  });

  const client = new AshbyClient();

  // ── 1. ashby_list_jobs ──────────────────────────────────────────────────

  server.tool(
    "ashby_list_jobs",
    `List jobs from Ashby with their IDs, titles, department, location, and status.

Use this to discover what positions exist before looking at candidates.
Returns a paginated list — pass the next_cursor value to fetch more results.

Response: items[] (id, title, status, locationId, departmentId), has_more, next_cursor.`,
    {
      status: z
        .enum(["Open", "Closed", "Archived", "Draft", "All"])
        .default("Open")
        .describe('Filter by job status. Use "All" to return every job. Defaults to "Open".'),
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
    async ({ status, limit, cursor }) => {
      try {
        const params: Record<string, unknown> = { limit };
        if (cursor) params.cursor = cursor;

        const page = await client.requestList<Job>("job.list", params);
        const filtered = status === "All"
          ? page.results
          : page.results.filter((j) => j.status === status);

        return json({
          items: filtered.map((j) => ({
            id: j.id,
            title: j.title,
            status: j.status,
            locationId: j.locationId ?? null,
            departmentId: j.departmentId ?? null,
            createdAt: j.createdAt,
            updatedAt: j.updatedAt,
          })),
          has_more: page.moreDataAvailable,
          next_cursor: page.nextCursor ?? null,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 2. ashby_get_job_details ────────────────────────────────────────────

  server.tool(
    "ashby_get_job_details",
    `Get full details for a specific job including its description and interview plan stages.

Use this after ashby_list_jobs to understand a position's requirements and hiring pipeline.
Fetches the job, resolves the job posting description, and interview plan stages automatically.

Response: job (id, title, status, description, hiringTeam, customFields, locationId, departmentId), interview_stages[] (id, title, type, order).`,
    {
      job_id: z.string().describe("The job ID (UUID) to fetch details for."),
    },
    async ({ job_id }) => {
      try {
        const job = await client.request<Job>("job.info", { id: job_id });

        // Fetch stages and job posting description concurrently
        const planIds = job.interviewPlanIds ?? (job.defaultInterviewPlanId ? [job.defaultInterviewPlanId] : []);
        const postingId = (job.jobPostingIds ?? [])[0] ?? null;

        const [stageResults, description] = await Promise.all([
          Promise.all(
            planIds.map((planId) =>
              client
                .requestList<InterviewStage>("interviewStage.list", { interviewPlanId: planId })
                .then((r) => r.results)
                .catch((e) => {
                  logger.warn("failed to fetch interview stages", { planId, error: e instanceof Error ? e.message : String(e) });
                  return [] as InterviewStage[];
                })
            )
          ),
          postingId
            ? client
                .request<{ descriptionPlain?: string }>("jobPosting.info", { jobPostingId: postingId })
                .then((p) => p.descriptionPlain ?? null)
                .catch((e) => {
                  logger.warn("failed to fetch job posting", { postingId, error: e instanceof Error ? e.message : String(e) });
                  return null as string | null;
                })
            : Promise.resolve(null as string | null),
        ]);
        const stages = stageResults.flat();

        return json({
          job: {
            id: job.id,
            title: job.title,
            status: job.status,
            description,
            employmentType: job.employmentType ?? null,
            locationId: job.locationId ?? null,
            departmentId: job.departmentId ?? null,
            hiringTeam: (job.hiringTeam ?? []).map((m) => ({
              name: `${m.firstName} ${m.lastName}`,
              email: m.email,
              role: m.role,
            })),
            customFields: job.customFields ?? [],
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          },
          interview_stages: stages
            .sort((a, b) => a.orderInInterviewPlan - b.orderInInterviewPlan)
            .map((s) => ({
              id: s.id,
              title: s.title,
              type: s.type,
              order: s.orderInInterviewPlan,
            })),
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 3. ashby_list_candidates_for_job ────────────────────────────────────

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
    async ({ job_id, limit, cursor }) => {
      try {
        const params: Record<string, unknown> = { jobId: job_id, limit };
        if (cursor) params.cursor = cursor;

        const page = await client.requestList<Application>("application.list", params);

        return json({
          items: page.results.map((app) => ({
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
          })),
          has_more: page.moreDataAvailable,
          next_cursor: page.nextCursor ?? null,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 4. ashby_get_candidate ──────────────────────────────────────────────

  server.tool(
    "ashby_get_candidate",
    `Get a comprehensive candidate profile.

Returns everything needed to evaluate a candidate: name, contact info, social links, tags,
resume/file handles, source, and all their applications with current stages.
Fetches the candidate profile, then resolves each application for full details.

Response: candidate (id, name, email, phone, socialLinks, tags, source, profileUrl, fileHandles), applications[] (id, status, job, current_stage, source, hiringTeam).`,
    {
      candidate_id: z.string().describe("The candidate ID (UUID) to fetch."),
    },
    async ({ candidate_id }) => {
      try {
        const candidate = await client.request<Candidate>("candidate.info", { id: candidate_id });

        // Resolve full application details from applicationIds
        let applications: Application[] = [];
        const appIds = candidate.applicationIds ?? [];
        if (appIds.length > 0) {
          const appResults = await Promise.all(
            appIds.map((appId) =>
              client
                .request<Application>("application.info", { applicationId: appId })
                .catch((e) => {
                  logger.warn("failed to resolve application", { appId, error: e instanceof Error ? e.message : String(e) });
                  return null;
                })
            )
          );
          applications = appResults.filter((a): a is Application => a !== null);
        }

        return json({
          candidate: {
            id: candidate.id,
            name: candidate.name,
            email: candidate.primaryEmailAddress?.value ?? null,
            phone: candidate.primaryPhoneNumber?.value ?? null,
            socialLinks: candidate.socialLinks ?? [],
            tags: (candidate.tags ?? []).map((t) => ({ id: t.id, title: t.title })),
            source: candidate.source?.title ?? null,
            customFields: candidate.customFields ?? [],
            fileHandles: candidate.fileHandles ?? [],
            profileUrl: candidate.profileUrl ?? null,
          },
          applications: applications.map((app) => ({
            id: app.id,
            status: app.status,
            job: { id: app.job.id, title: app.job.title },
            current_stage: app.currentInterviewStage
              ? {
                  id: app.currentInterviewStage.id,
                  title: app.currentInterviewStage.title,
                  type: app.currentInterviewStage.type,
                }
              : null,
            source: app.source?.title ?? null,
            hiringTeam: (app.hiringTeam ?? []).map((m) => ({
              name: `${m.firstName} ${m.lastName}`,
              email: m.email,
              role: m.role,
            })),
            createdAt: app.createdAt,
          })),
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 5. ashby_get_application_details ────────────────────────────────────

  server.tool(
    "ashby_get_application_details",
    `Get full application details including stage history, hiring team, feedback, and criteria evaluations.

Use this to deep-dive into a specific application. Fires four API calls concurrently for speed.

Response: application (id, status, candidate, job, current_stage, hiringTeam, source, customFields), stage_history[], criteria_evaluations[], feedback[].`,
    {
      application_id: z.string().describe("The application ID (UUID) to fetch."),
    },
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

        return json({
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
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 6. ashby_get_candidate_notes ────────────────────────────────────────

  server.tool(
    "ashby_get_candidate_notes",
    `List all notes on a candidate.

Use this to see existing evaluation notes or comments left by the hiring team.

Response: notes[] (id, content, createdAt, author).`,
    {
      candidate_id: z.string().describe("The candidate ID (UUID) to fetch notes for."),
    },
    async ({ candidate_id }) => {
      try {
        const page = await client.requestList<CandidateNote>(
          "candidate.listNotes",
          { candidateId: candidate_id, limit: 100 }
        );

        return json({
          notes: page.results.map((n) => ({
            id: n.id,
            content: n.content,
            createdAt: n.createdAt,
            author: n.author
              ? `${n.author.firstName} ${n.author.lastName} (${n.author.email})`
              : null,
          })),
          has_more: page.moreDataAvailable,
          next_cursor: page.nextCursor ?? null,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 7. ashby_search_candidates ──────────────────────────────────────────

  server.tool(
    "ashby_search_candidates",
    `Search for candidates by name or email.

Use this when you know a candidate's name or email but not their ID.
Both name and email use AND logic if both provided. Max 100 results.

Response: candidates[] (id, name, email, phone).`,
    {
      query: z.string().describe("Candidate name to search for."),
      email: z
        .string()
        .optional()
        .describe("Optional email to narrow search (AND logic with name)."),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max results (1-100). Defaults to 25."),
    },
    async ({ query, email, limit }) => {
      try {
        const params: Record<string, unknown> = { name: query, limit };
        if (email) params.email = email;

        const results = await client.request<
          Array<{
            id: string;
            name: string;
            primaryEmailAddress?: { value: string };
            primaryPhoneNumber?: { value: string };
          }>
        >("candidate.search", params);

        return json({
          candidates: results.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.primaryEmailAddress?.value ?? null,
            phone: c.primaryPhoneNumber?.value ?? null,
          })),
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 8. ashby_list_interview_stages ──────────────────────────────────────

  server.tool(
    "ashby_list_interview_stages",
    `List all interview stages across all interview plans.

Use this to understand the hiring pipeline and get stage IDs for ashby_move_application_stage.
Fetches all interview plans, then resolves stages for each.

Response: plans[] (plan_id, plan_title, stages[] (id, title, type, order)).`,
    {},
    async () => {
      try {
        const planPage = await client.requestList<InterviewPlan>("interviewPlan.list", {});

        const plansWithStages = await Promise.all(
          planPage.results.map(async (plan) => {
            const stagePage = await client
              .requestList<InterviewStage>("interviewStage.list", { interviewPlanId: plan.id })
              .catch((e) => {
                logger.warn("failed to fetch stages for plan", { planId: plan.id, error: e instanceof Error ? e.message : String(e) });
                return { results: [] as InterviewStage[], moreDataAvailable: false };
              });

            return {
              plan_id: plan.id,
              plan_title: plan.title,
              stages: stagePage.results
                .sort((a, b) => a.orderInInterviewPlan - b.orderInInterviewPlan)
                .map((s) => ({
                  id: s.id,
                  title: s.title,
                  type: s.type,
                  order: s.orderInInterviewPlan,
                })),
            };
          })
        );

        return json({ plans: plansWithStages });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 9. ashby_get_feedback ───────────────────────────────────────────────

  server.tool(
    "ashby_get_feedback",
    `Get submitted feedback/scorecards for an application.

Use this to review interviewer evaluations and scores.

Response: feedback[] (form definition with sections/fields, submitted values).`,
    {
      application_id: z.string().describe("The application ID (UUID) to fetch feedback for."),
    },
    async ({ application_id }) => {
      try {
        const page = await client.requestList<ApplicationFeedback>(
          "applicationFeedback.list",
          { applicationId: application_id }
        );

        return json({
          feedback: page.results,
          has_more: page.moreDataAvailable,
          next_cursor: page.nextCursor ?? null,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 10. ashby_add_candidate_note ────────────────────────────────────────

  server.tool(
    "ashby_add_candidate_note",
    `Add an evaluation note to a candidate.

Use this to record your assessment or recommendations. The note will be visible to the hiring team in Ashby.

Response: note_id, confirmation message.`,
    {
      candidate_id: z.string().describe("The candidate ID (UUID) to add a note to."),
      note: z.string().describe("The note content (plain text). Visible to the hiring team."),
    },
    async ({ candidate_id, note }) => {
      try {
        const result = await client.request<{ id: string }>(
          "candidate.createNote",
          { candidateId: candidate_id, note }
        );

        return json({
          note_id: result.id,
          message: `Note added to candidate ${candidate_id}.`,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 11. ashby_move_application_stage ────────────────────────────────────

  server.tool(
    "ashby_move_application_stage",
    `Move an application to a different interview stage.

Use this to advance a candidate through the pipeline. Get stage IDs from ashby_list_interview_stages.
Moving to an "Archived" type stage requires an archive reason — use only for active transitions.

Response: updated application with new current_stage.`,
    {
      application_id: z.string().describe("The application ID (UUID) to move."),
      stage_id: z.string().describe("The target interview stage ID (UUID). Get from ashby_list_interview_stages."),
    },
    async ({ application_id, stage_id }) => {
      try {
        const result = await client.request<Application>(
          "application.changeStage",
          { applicationId: application_id, interviewStageId: stage_id }
        );

        return json({
          application_id: result.id,
          new_stage: result.currentInterviewStage
            ? {
                id: result.currentInterviewStage.id,
                title: result.currentInterviewStage.title,
                type: result.currentInterviewStage.type,
              }
            : null,
          status: result.status,
          message: `Application moved to stage "${result.currentInterviewStage?.title ?? stage_id}".`,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 12. ashby_get_resume ───────────────────────────────────────────────

  server.tool(
    "ashby_get_resume",
    `Download and read a candidate's resume or uploaded file.

Use this after ashby_get_candidate to read the actual content of a resume or file.
Takes a file handle string from the candidate's fileHandles array.
Fetches the file URL from Ashby, downloads the file, and returns the text content.

Supports PDF, DOCX (as plain text), and plain text files. For other formats, returns the download URL.

Response: filename, content (extracted text), or url (for unsupported formats).`,
    {
      file_handle: z.string().describe("The file handle string from a candidate's fileHandles array."),
      file_name: z.string().optional().describe("Original filename (helps determine format). Optional."),
    },
    async ({ file_handle, file_name }) => {
      try {
        // Get the download URL from Ashby
        const result = await client.request<{ url: string }>("file.info", {
          fileHandle: file_handle,
        });

        const url = result.url;
        if (!url) {
          return json({ error: "No download URL returned by Ashby." });
        }

        // Download the file (60s timeout for large files)
        const response = await fetch(url, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          return json({
            error: `Failed to download file: HTTP ${response.status}`,
            url,
          });
        }

        const contentType = response.headers.get("content-type") ?? "";
        const name = file_name ?? "unknown";
        const ext = name.split(".").pop()?.toLowerCase() ?? "";

        // For plain text files, return content directly
        if (contentType.includes("text/") || ["txt", "md", "csv"].includes(ext)) {
          const text = await response.text();
          return json({ filename: name, content: text });
        }

        // For PDFs, extract text from the binary
        if (contentType.includes("pdf") || ext === "pdf") {
          const buffer = Buffer.from(await response.arrayBuffer());
          const text = extractPdfText(buffer);

          if (text.length > 0) {
            return json({ filename: name, format: "pdf", content: text });
          }

          return json({
            filename: name,
            format: "pdf",
            content: "(Could not extract text — PDF may be scanned/image-only. Use the URL to view it directly.)",
            url,
          });
        }

        // For other formats, just return the URL
        return json({
          filename: name,
          format: ext || contentType,
          content: "(Unsupported format for text extraction. Use the URL to view it directly.)",
          url,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 13. ashby_add_candidate_tag ─────────────────────────────────────────

  server.tool(
    "ashby_add_candidate_tag",
    `Tag a candidate with a label (e.g. "Strong Hire", "Needs Review").

Use this to categorize candidates during evaluation. You need the tag ID from Ashby admin settings.

Response: confirmation message.`,
    {
      candidate_id: z.string().describe("The candidate ID (UUID) to tag."),
      tag_id: z.string().describe("The tag ID (UUID). Tags are configured in Ashby admin settings."),
    },
    async ({ candidate_id, tag_id }) => {
      try {
        await client.request<unknown>("candidate.addTag", {
          candidateId: candidate_id,
          tagId: tag_id,
        });

        return json({ message: `Tag ${tag_id} added to candidate ${candidate_id}.` });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 14. ashby_get_application_form_submission ────────────────────────

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
          return json({
            application_id: app.id,
            candidate_name: app.candidate.name,
            job_title: app.job.title,
            form_responses: [],
            message: "No application form submission found for this application.",
          });
        }

        // Build path→title+type lookup from the form definition
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
              // Location objects have a .text field
              answer = String((value as { text: string }).text);
            } else if (typeof value === "object") {
              answer = JSON.stringify(value);
            } else {
              answer = String(value);
            }

            formResponses.push({ question, field_type: fieldType, answer });
          }
        }

        return json({
          application_id: app.id,
          candidate_name: app.candidate.name,
          job_title: app.job.title,
          form_responses: formResponses,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 15. ashby_list_applications ───────────────────────────────────────

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

        return json({
          items: items.slice(0, limit),
          has_more: hasMore || items.length > limit,
          next_cursor: nextCursor ?? null,
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 15. ashby_get_pipeline_summary ──────────────────────────────────

  server.tool(
    "ashby_get_pipeline_summary",
    `Get a pipeline summary showing candidate counts per interview stage, per job.

Use this to answer "What does our pipeline look like?", "How many candidates at each stage?",
or "Give me an overview of where things stand across open roles."
The MCP server fetches and aggregates all applications internally — no need to paginate manually.

Response: jobs[] (job_id, job_title, total_active, total_archived, stages[] (stage_title, stage_type, count)), totals (active, archived, leads).`,
    {
      job_id: z
        .string()
        .optional()
        .describe("Summary for one specific job (UUID). If omitted, summarizes all jobs matching the status filter."),
      status: z
        .enum(["Open", "Closed", "All"])
        .default("Open")
        .describe("Which jobs to include. Defaults to Open."),
    },
    async ({ job_id, status }) => {
      try {
        // Determine which jobs to summarize
        let jobIds: { id: string; title: string }[];
        if (job_id) {
          const job = await client.request<{ id: string; title: string }>("job.info", { id: job_id });
          jobIds = [{ id: job.id, title: job.title }];
        } else {
          const jobPage = await client.requestList<Job>("job.list", { limit: 100 });
          const filtered = status === "All"
            ? jobPage.results
            : jobPage.results.filter((j) => j.status === status);
          jobIds = filtered.map((j) => ({ id: j.id, title: j.title }));
        }

        let totalActive = 0;
        let totalArchived = 0;
        let totalLeads = 0;

        const jobs = await Promise.all(
          jobIds.map(async (job) => {
            // Fetch all applications for this job (paginate internally)
            const allApps: Application[] = [];
            let cursor: string | undefined;
            do {
              const params: Record<string, unknown> = { jobId: job.id, limit: 100 };
              if (cursor) params.cursor = cursor;
              const page = await client.requestList<Application>("application.list", params);
              allApps.push(...page.results);
              cursor = page.moreDataAvailable ? page.nextCursor : undefined;
            } while (cursor);

            // Count by stage
            const stageCounts = new Map<string, { title: string; type: string; count: number }>();
            let jobActive = 0;
            let jobArchived = 0;

            for (const app of allApps) {
              if (app.status === "Archived") {
                jobArchived++;
              } else {
                jobActive++;
              }

              const stageTitle = app.currentInterviewStage?.title ?? "(No stage)";
              const stageType = app.currentInterviewStage?.type ?? "Unknown";
              const key = `${stageType}::${stageTitle}`;
              const entry = stageCounts.get(key);
              if (entry) {
                entry.count++;
              } else {
                stageCounts.set(key, { title: stageTitle, type: stageType, count: 1 });
              }

              if (app.status === "Lead") totalLeads++;
            }

            totalActive += jobActive;
            totalArchived += jobArchived;

            return {
              job_id: job.id,
              job_title: job.title,
              total_active: jobActive,
              total_archived: jobArchived,
              stages: [...stageCounts.values()].sort((a, b) => b.count - a.count),
            };
          })
        );

        return json({
          jobs,
          totals: { active: totalActive, archived: totalArchived, leads: totalLeads },
        });
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── 17. ashby_list_upcoming_interviews ────────────────────────────────

  server.tool(
    "ashby_list_upcoming_interviews",
    `List upcoming and pending interview schedules.

Use this to answer "What interviews do I have this week?", "Who needs to be scheduled?",
or "Show me all upcoming interviews."
Fetches interview schedules from Ashby, resolves candidate and job details, and filters by date range.

Response: items[] (schedule_id, status, candidate_name, candidate_id, job_title, job_id, interview_stage, events[] (start_time, end_time, interviewers, meeting_link, location, has_submitted_feedback)).`,
    {
      start_after: z
        .string()
        .optional()
        .describe("ISO datetime — only interviews starting after this time. Defaults to now."),
      start_before: z
        .string()
        .optional()
        .describe("ISO datetime — only interviews starting before this time."),
      status: z
        .enum(["Scheduled", "NeedsScheduling", "Complete", "Cancelled", "All"])
        .default("All")
        .describe("Filter by schedule status. Defaults to All (excludes Cancelled/Complete unless specified)."),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max results to return (1-100). Defaults to 25."),
    },
    async ({ start_after, start_before, status, limit }) => {
      try {
        const startAfterTime = start_after ?? new Date().toISOString();
        const includeStatuses = status === "All"
          ? new Set(["Scheduled", "NeedsScheduling"])
          : new Set([status]);

        // Fetch all schedules (paginate internally, filter by status)
        type InterviewEvent = {
          id: string;
          startTime: string;
          endTime: string;
          interviewers: Array<{ firstName: string; lastName: string; email: string }>;
          meetingLink?: string;
          location?: string;
          hasSubmittedFeedback: boolean;
        };
        type Schedule = {
          id: string;
          status: string;
          applicationId: string;
          interviewStageId: string;
          interviewEvents: InterviewEvent[];
        };

        const matching: Schedule[] = [];
        let cursor: string | undefined;

        do {
          const params: Record<string, unknown> = { limit: 100 };
          if (cursor) params.cursor = cursor;
          const page = await client.requestList<Schedule>("interviewSchedule.list", params);

          for (const schedule of page.results) {
            if (!includeStatuses.has(schedule.status)) continue;

            // For schedules with events, filter by time range
            if (schedule.interviewEvents.length > 0) {
              const hasMatchingEvent = schedule.interviewEvents.some((e) => {
                if (e.startTime < startAfterTime) return false;
                if (start_before && e.startTime > start_before) return false;
                return true;
              });
              if (!hasMatchingEvent) continue;
            }
            // NeedsScheduling has no events — always include if status matches

            matching.push(schedule);
            if (matching.length >= limit) break;
          }

          cursor = page.moreDataAvailable ? page.nextCursor : undefined;
        } while (cursor && matching.length < limit);

        // Resolve candidate/job details from applicationIds
        const uniqueAppIds = [...new Set(matching.map((s) => s.applicationId))];
        const appMap = new Map<string, { candidateName: string; candidateId: string; jobTitle: string; jobId: string }>();

        const appResults = await Promise.all(
          uniqueAppIds.map((appId) =>
            client
              .request<Application>("application.info", { applicationId: appId })
              .then((app) => ({
                appId,
                candidateName: app.candidate.name,
                candidateId: app.candidate.id,
                jobTitle: app.job.title,
                jobId: app.job.id,
              }))
              .catch((e) => {
                logger.warn("failed to resolve application for interview", { appId, error: e instanceof Error ? e.message : String(e) });
                return null;
              })
          )
        );

        for (const r of appResults) {
          if (r) appMap.set(r.appId, r);
        }

        const items = matching.map((schedule) => {
          const app = appMap.get(schedule.applicationId);
          return {
            schedule_id: schedule.id,
            status: schedule.status,
            application_id: schedule.applicationId,
            candidate_name: app?.candidateName ?? "(unknown)",
            candidate_id: app?.candidateId ?? null,
            job_title: app?.jobTitle ?? "(unknown)",
            job_id: app?.jobId ?? null,
            events: schedule.interviewEvents
              .filter((e) => {
                if (e.startTime < startAfterTime) return false;
                if (start_before && e.startTime > start_before) return false;
                return true;
              })
              .map((e) => ({
                start_time: e.startTime,
                end_time: e.endTime,
                interviewers: e.interviewers.map((i) => `${i.firstName} ${i.lastName} (${i.email})`),
                meeting_link: e.meetingLink ?? null,
                location: e.location ?? null,
                has_submitted_feedback: e.hasSubmittedFeedback,
              })),
          };
        });

        return json({ items });
      } catch (e) {
        return error(e);
      }
    }
  );

  return server;
}
