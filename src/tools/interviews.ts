import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import type { Application, InterviewStage, InterviewPlan } from "../types.js";
import { error, json } from "../tool-helpers.js";
import { logger } from "../logger.js";

export function registerInterviewTools(server: McpServer, client: AshbyClient): void {
  // ── ashby_list_interview_stages ──────────────────────────────────────

  server.tool(
    "ashby_list_interview_stages",
    `List all interview stages across all interview plans.

Use this to understand the hiring pipeline and get stage IDs for ashby_move_application_stage.
Fetches all interview plans, then resolves stages for each.

Response: plans[] (plan_id, plan_title, stages[] (id, title, type, order)).`,
    {},
    { readOnlyHint: true },
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

        const totalStages = plansWithStages.reduce((sum, p) => sum + p.stages.length, 0);
        return json(
          `${plansWithStages.length} interview plan(s) with ${totalStages} total stage(s).`,
          { plans: plansWithStages }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_list_upcoming_interviews ───────────────────────────────────

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
    { readOnlyHint: true },
    async ({ start_after, start_before, status, limit }) => {
      try {
        const startAfterTime = start_after ?? new Date().toISOString();
        const includeStatuses = status === "All"
          ? new Set(["Scheduled", "NeedsScheduling"])
          : new Set([status]);

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

            if (schedule.interviewEvents.length > 0) {
              const hasMatchingEvent = schedule.interviewEvents.some((e) => {
                if (e.startTime < startAfterTime) return false;
                if (start_before && e.startTime > start_before) return false;
                return true;
              });
              if (!hasMatchingEvent) continue;
            }

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

        return json(
          `${items.length} interview schedule(s) found.`,
          { items }
        );
      } catch (e) {
        return error(e);
      }
    }
  );
}
