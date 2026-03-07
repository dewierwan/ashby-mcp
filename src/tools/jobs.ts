import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import type { Job, InterviewStage, Application } from "../types.js";
import { error, json } from "../tool-helpers.js";
import { logger } from "../logger.js";

export function registerJobTools(server: McpServer, client: AshbyClient): void {
  // ── ashby_list_jobs ──────────────────────────────────────────────────

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
    { readOnlyHint: true },
    async ({ status, limit, cursor }) => {
      try {
        const params: Record<string, unknown> = { limit };
        if (cursor) params.cursor = cursor;

        const page = await client.requestList<Job>("job.list", params);
        const filtered = status === "All"
          ? page.results
          : page.results.filter((j) => j.status === status);

        const items = filtered.map((j) => ({
          id: j.id,
          title: j.title,
          status: j.status,
          locationId: j.locationId ?? null,
          departmentId: j.departmentId ?? null,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
        }));

        return json(
          `Found ${items.length} job(s)${status !== "All" ? ` with status "${status}"` : ""}.`,
          { items, has_more: page.moreDataAvailable, next_cursor: page.nextCursor ?? null }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_job_details ────────────────────────────────────────────

  server.tool(
    "ashby_get_job_details",
    `Get full details for a specific job including its description and interview plan stages.

Use this after ashby_list_jobs to understand a position's requirements and hiring pipeline.
Fetches the job, resolves the job posting description, and interview plan stages automatically.

Response: job (id, title, status, description, hiringTeam, customFields, locationId, departmentId), interview_stages[] (id, title, type, order).`,
    {
      job_id: z.string().describe("The job ID (UUID) to fetch details for."),
    },
    { readOnlyHint: true },
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

        const data = {
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
        };

        return json(
          `Job "${job.title}" (${job.status}) with ${stages.length} interview stage(s).`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_pipeline_summary ───────────────────────────────────────

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
    { readOnlyHint: true },
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

        const data = {
          jobs,
          totals: { active: totalActive, archived: totalArchived, leads: totalLeads },
        };

        return json(
          `Pipeline across ${jobs.length} job(s): ${totalActive} active, ${totalArchived} archived, ${totalLeads} lead(s).`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );
}
