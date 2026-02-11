import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AshbyClient, AshbyApiError } from "./ashby-client.js";
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
    version: "1.0.0",
  });

  const client = new AshbyClient();

  // ── 1. ashby_list_jobs ──────────────────────────────────────────────────

  server.tool(
    "ashby_list_jobs",
    `List jobs from Ashby with their IDs, titles, department, location, and status.

Use this to discover what positions exist before looking at candidates.
Returns a paginated list — pass the next_cursor value to fetch more results.
The status filter is applied client-side since the Ashby API returns all jobs.

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

        const filtered =
          status === "All"
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
    `Get full details for a specific job including its interview plan stages.

Use this after ashby_list_jobs to understand a position's requirements and hiring pipeline.
Fetches the job, then resolves its interview plan stages automatically.

Response: job (id, title, status, hiringTeam, customFields, locationId, departmentId), interview_stages[] (id, title, type, order).`,
    {
      job_id: z.string().describe("The job ID (UUID) to fetch details for."),
    },
    async ({ job_id }) => {
      try {
        const job = await client.request<Job>("job.info", { id: job_id });

        // Fetch stages for the job's interview plan(s)
        const planIds = job.interviewPlanIds ?? (job.defaultInterviewPlanId ? [job.defaultInterviewPlanId] : []);
        const stageResults = await Promise.all(
          planIds.map((planId) =>
            client
              .requestList<InterviewStage>("interviewStage.list", { interviewPlanId: planId })
              .then((r) => r.results)
              .catch(() => [] as InterviewStage[])
          )
        );
        const stages = stageResults.flat();

        return json({
          job: {
            id: job.id,
            title: job.title,
            status: job.status,
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
                .catch(() => null)
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
            .catch(() => ({ results: [] as ApplicationHistoryEntry[], moreDataAvailable: false })),
          client
            .requestList<CriteriaEvaluation>("application.listCriteriaEvaluations", { applicationId: application_id })
            .catch(() => ({ results: [] as CriteriaEvaluation[], moreDataAvailable: false })),
          client
            .requestList<ApplicationFeedback>("applicationFeedback.list", { applicationId: application_id })
            .catch(() => ({ results: [] as ApplicationFeedback[], moreDataAvailable: false })),
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
              .catch(() => ({ results: [] as InterviewStage[], moreDataAvailable: false }));

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

  // ── 12. ashby_add_candidate_tag ─────────────────────────────────────────

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

  return server;
}
