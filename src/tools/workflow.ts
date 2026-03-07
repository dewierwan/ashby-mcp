import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import type { Application, ApplicationFeedback, ArchiveReason, CommunicationTemplate } from "../types.js";
import { error, json } from "../tool-helpers.js";

export function registerWorkflowTools(server: McpServer, client: AshbyClient): void {
  // ── ashby_move_application_stage ─────────────────────────────────────

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
    { destructiveHint: true },
    async ({ application_id, stage_id }) => {
      try {
        const result = await client.request<Application>(
          "application.changeStage",
          { applicationId: application_id, interviewStageId: stage_id }
        );

        const newStage = result.currentInterviewStage?.title ?? stage_id;
        return json(
          `Application moved to stage "${newStage}".`,
          {
            application_id: result.id,
            new_stage: result.currentInterviewStage
              ? {
                  id: result.currentInterviewStage.id,
                  title: result.currentInterviewStage.title,
                  type: result.currentInterviewStage.type,
                }
              : null,
            status: result.status,
            message: `Application moved to stage "${newStage}".`,
          }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_feedback ───────────────────────────────────────────────

  server.tool(
    "ashby_get_feedback",
    `Get submitted feedback/scorecards for an application.

Use this to review interviewer evaluations and scores.

Response: feedback[] (form definition with sections/fields, submitted values).`,
    {
      application_id: z.string().describe("The application ID (UUID) to fetch feedback for."),
    },
    { readOnlyHint: true },
    async ({ application_id }) => {
      try {
        const page = await client.requestList<ApplicationFeedback>(
          "applicationFeedback.list",
          { applicationId: application_id }
        );

        return json(
          `${page.results.length} feedback submission(s) found.`,
          {
            feedback: page.results,
            has_more: page.moreDataAvailable,
            next_cursor: page.nextCursor ?? null,
          }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_list_archive_reasons ───────────────────────────────────────

  server.tool(
    "ashby_list_archive_reasons",
    `List available archive/rejection reasons.

Use this as the first step when archiving a candidate. Returns reasons you can pass to ashby_archive_application.
Requires the "hiringProcessMetadataRead" API key permission.

Response: reasons[] (id, text, reasonType).`,
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const page = await client.requestList<ArchiveReason>("archiveReason.list", {});

        const reasons = page.results
          .filter((r) => !r.isArchived)
          .map((r) => ({
            id: r.id,
            text: r.text,
            reasonType: r.reasonType,
          }));

        return json(
          `${reasons.length} active archive reason(s).`,
          { reasons }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_list_email_templates ───────────────────────────────────────

  server.tool(
    "ashby_list_email_templates",
    `List available email templates for rejection/archive emails.

Use this to find the template ID to pass to ashby_archive_application when sending a rejection email.
Requires the "hiringProcessMetadataRead" API key permission.

Response: templates[] (id, name, and any other fields returned by the API).`,
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const page = await client.requestList<CommunicationTemplate>("communicationTemplate.list", {});

        const templates = page.results.map((t) => {
          const { id, name, ...rest } = t;
          return { id, name, ...rest };
        });

        return json(
          `${templates.length} email template(s).`,
          { templates }
        );
      } catch (e) {
        return error(e);
      }
    }
  );
}
