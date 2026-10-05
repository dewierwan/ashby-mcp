import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import type { Application, Job } from "../types.js";
import { error, json } from "../tool-helpers.js";
import { createArchiver, describeError, runPool, withBackoff } from "../archive.js";

const CONCURRENCY = 5;
const SAMPLES_PER_JOB = 10;
const PAGE_SIZE = 100;

type SkipReason = "hired" | "already_archived" | "excluded_candidate" | "excluded_application";

interface JobSummary {
  job_id: string;
  job_title: string;
  matched: number;
  to_archive: number;
  archived: number;
  failed: number;
  skipped: number;
  sample_names?: string[];
}

interface Failure {
  application_id: string;
  candidate_name: string;
  job_title: string;
  error: string;
}

/** Page through an Ashby list endpoint until it is exhausted. */
async function listAll<T>(client: AshbyClient, endpoint: string, params: Record<string, unknown>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await withBackoff(() =>
      client.requestList<T>(endpoint, { ...params, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    );
    all.push(...page.results);
    cursor = page.moreDataAvailable ? page.nextCursor : undefined;
  } while (cursor);
  return all;
}

function parseDate(value: string, name: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`${name} is not a valid ISO date: ${value}`);
  return ms;
}

export function registerArchiveByFilterTools(server: McpServer, client: AshbyClient): void {
  // ── ashby_archive_by_filter ──────────────────────────────────────────

  server.tool(
    "ashby_archive_by_filter",
    `Find and archive every application matching a set of filters in one call. Use this for bulk cleanups instead of ashby_bulk_archive.

SAFE WORKFLOW: always call with dry_run=true first (the default), check the counts and samples, then repeat with dry_run=false.

Filters are combined with AND, and at least one is required:
- job_ids: specific jobs.
- job_status: e.g. ["Closed","Archived"], resolved via job.list.
- job_closed_before: ISO date. Ashby has no closed-at field, so this uses the job's updatedAt as a proxy (any later edit to the job makes it look more recently closed). Without job_status, only Closed and Archived jobs are considered.
- application_status: "Active" and/or "Lead".
- stage_titles: current stage title, case-insensitive exact match (e.g. ["New Lead","Reached Out"]).
- created_before: ISO date; applications created before it.

Never touched: Hired applications, already-archived applications, and anything in exclude_candidate_ids or exclude_application_ids.

Safety cap: if more than max_applications (default 500) would be archived, a real run refuses and reports the count. Raise max_applications explicitly to proceed. A dry run reports the overage instead.

Response (compact): totals (matched, to_archive, archived, skipped by reason, failed), per-job breakdown (with up to 10 sample names per job in dry runs), and the full list of failures. Archived IDs are not echoed.`,
    {
      job_ids: z.array(z.string()).optional().describe("Only applications on these jobs (UUIDs)."),
      job_status: z
        .array(z.enum(["Open", "Closed", "Archived", "Draft"]))
        .optional()
        .describe('Only applications on jobs with these statuses, e.g. ["Closed","Archived"].'),
      job_closed_before: z
        .string()
        .optional()
        .describe("ISO date. Only jobs whose updatedAt (proxy for closed date) is before this. Defaults to Closed/Archived jobs unless job_status is set."),
      application_status: z
        .array(z.enum(["Active", "Lead"]))
        .optional()
        .describe('Only applications with these statuses, e.g. ["Lead"].'),
      stage_titles: z
        .array(z.string())
        .optional()
        .describe('Only applications whose current stage title is one of these (case-insensitive), e.g. ["New Lead","Reached Out"].'),
      created_before: z.string().optional().describe("ISO date. Only applications created before this."),
      exclude_candidate_ids: z.array(z.string()).optional().describe("Keep-list: never archive applications for these candidates."),
      exclude_application_ids: z.array(z.string()).optional().describe("Keep-list: never archive these applications."),
      archive_reason_id: z
        .string()
        .optional()
        .describe("Archive reason ID from ashby_list_archive_reasons. Required when dry_run is false."),
      send_email: z.boolean().default(false).describe("Send rejection emails. Requires email_template_id. Defaults to false."),
      email_template_id: z
        .string()
        .optional()
        .describe("Communication template ID from ashby_list_email_templates. Required when send_email is true."),
      dry_run: z.boolean().default(true).describe("When true (the default), archive nothing and report what would be archived."),
      max_applications: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(500)
        .describe("Safety cap. A real run refuses if more applications than this would be archived. Defaults to 500."),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        const {
          job_ids,
          job_status,
          job_closed_before,
          application_status,
          stage_titles,
          created_before,
          exclude_candidate_ids,
          exclude_application_ids,
          archive_reason_id,
          send_email,
          email_template_id,
          dry_run,
          max_applications,
        } = args;

        // ── Validate ──
        const hasFilter =
          !!job_ids?.length ||
          !!job_status?.length ||
          !!job_closed_before ||
          !!application_status?.length ||
          !!stage_titles?.length ||
          !!created_before;
        if (!hasFilter) {
          return json("At least one filter is required.", {
            error:
              "At least one filter is required (job_ids, job_status, job_closed_before, application_status, stage_titles or created_before). Exclude lists do not count.",
          });
        }
        if (!dry_run && !archive_reason_id) {
          return json("archive_reason_id is required when dry_run is false.", {
            error: "archive_reason_id is required when dry_run is false. Use ashby_list_archive_reasons to find one.",
          });
        }
        if (send_email && !email_template_id) {
          return json("email_template_id is required when send_email is true.", {
            error: "email_template_id is required when send_email is true. Use ashby_list_email_templates to find available templates.",
          });
        }
        const closedBeforeMs = job_closed_before ? parseDate(job_closed_before, "job_closed_before") : undefined;
        const createdBeforeMs = created_before ? parseDate(created_before, "created_before") : undefined;

        // ── Resolve jobs ──
        // undefined = no job filter, so list applications across all jobs.
        let jobs: Array<{ id: string; title?: string }> | undefined;
        if (job_status?.length || closedBeforeMs !== undefined) {
          const statuses = job_status?.length ? job_status : ["Closed", "Archived"];
          let listed = await listAll<Job>(client, "job.list", { status: statuses });
          if (closedBeforeMs !== undefined) {
            listed = listed.filter((j) => new Date(j.updatedAt).getTime() < closedBeforeMs);
          }
          if (job_ids?.length) {
            const wanted = new Set(job_ids);
            listed = listed.filter((j) => wanted.has(j.id));
          }
          jobs = listed.map((j) => ({ id: j.id, title: j.title }));
        } else if (job_ids?.length) {
          jobs = [...new Set(job_ids)].map((id) => ({ id }));
        }

        // ── Collect applications ──
        // Ashby filters status server-side only for a single value.
        const serverParams: Record<string, unknown> = {};
        if (application_status?.length === 1) serverParams.status = application_status[0];

        let apps: Application[];
        if (jobs) {
          const perJob = await runPool(jobs, CONCURRENCY, (job) =>
            listAll<Application>(client, "application.list", { ...serverParams, jobId: job.id })
          );
          apps = perJob.flat();
        } else {
          apps = await listAll<Application>(client, "application.list", serverParams);
        }

        // ── Filter, then sort into skip reasons and the archive list ──
        const statusSet = application_status?.length ? new Set<string>(application_status) : undefined;
        const stageSet = stage_titles?.length ? new Set(stage_titles.map((t) => t.trim().toLowerCase())) : undefined;
        const keepCandidates = new Set(exclude_candidate_ids ?? []);
        const keepApplications = new Set(exclude_application_ids ?? []);
        const jobTitles = new Map((jobs ?? []).filter((j) => j.title).map((j) => [j.id, j.title as string]));

        const byJob = new Map<string, JobSummary>();
        const skipped: Record<SkipReason, number> = {
          hired: 0,
          already_archived: 0,
          excluded_candidate: 0,
          excluded_application: 0,
        };
        const toArchive: Application[] = [];

        for (const app of apps) {
          if (statusSet && !statusSet.has(app.status)) continue;
          if (stageSet && !stageSet.has((app.currentInterviewStage?.title ?? "").trim().toLowerCase())) continue;
          if (createdBeforeMs !== undefined && !(new Date(app.createdAt).getTime() < createdBeforeMs)) continue;

          let summary = byJob.get(app.job.id);
          if (!summary) {
            summary = {
              job_id: app.job.id,
              job_title: jobTitles.get(app.job.id) ?? app.job.title,
              matched: 0,
              to_archive: 0,
              archived: 0,
              failed: 0,
              skipped: 0,
            };
            byJob.set(app.job.id, summary);
          }
          summary.matched++;

          let reason: SkipReason | undefined;
          if (app.status === "Hired") reason = "hired";
          else if (app.status === "Archived" || app.currentInterviewStage?.type === "Archived") reason = "already_archived";
          else if (keepApplications.has(app.id)) reason = "excluded_application";
          else if (keepCandidates.has(app.candidate.id)) reason = "excluded_candidate";

          if (reason) {
            skipped[reason]++;
            summary.skipped++;
            continue;
          }
          summary.to_archive++;
          toArchive.push(app);
        }

        const matched = [...byJob.values()].reduce((n, j) => n + j.matched, 0);
        const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
        const overCap = toArchive.length > max_applications;
        const capMessage = `${toArchive.length} applications would be archived, which exceeds max_applications (${max_applications}). Narrow the filters or raise max_applications explicitly.`;

        const totals = {
          matched,
          to_archive: toArchive.length,
          archived: 0,
          skipped: skippedTotal,
          skipped_by_reason: skipped,
          failed: 0,
        };

        // ── Dry run: report only ──
        if (dry_run) {
          for (const app of toArchive) {
            const summary = byJob.get(app.job.id)!;
            summary.sample_names ??= [];
            if (summary.sample_names.length < SAMPLES_PER_JOB) summary.sample_names.push(app.candidate.name);
          }
          const jobsOut = [...byJob.values()].map(({ archived: _a, failed: _f, ...rest }) => rest);
          return json(
            `Dry run: ${toArchive.length} of ${matched} matched application(s) would be archived across ${byJob.size} job(s); ${skippedTotal} skipped. Nothing was changed.${overCap ? ` WARNING: ${capMessage}` : ""}`,
            {
              dry_run: true,
              ...(overCap ? { cap_exceeded: true, max_applications, message: capMessage } : {}),
              totals,
              jobs: jobsOut,
            }
          );
        }

        // ── Cap refusal ──
        if (overCap) {
          const jobsOut = [...byJob.values()].map(({ job_id, job_title, matched: m, to_archive }) => ({
            job_id,
            job_title,
            matched: m,
            to_archive,
          }));
          return json(`Refused: ${capMessage}`, {
            dry_run: false,
            refused: true,
            max_applications,
            message: capMessage,
            totals,
            jobs: jobsOut,
          });
        }

        // ── Archive ──
        const archiver = createArchiver(client, {
          archiveReasonId: archive_reason_id,
          emailTemplateId: send_email ? email_template_id : undefined,
        });
        const failures: Failure[] = [];
        await runPool(toArchive, CONCURRENCY, async (app) => {
          const summary = byJob.get(app.job.id)!;
          try {
            await withBackoff(() => archiver.archive(app));
            summary.archived++;
          } catch (e) {
            summary.failed++;
            failures.push({
              application_id: app.id,
              candidate_name: app.candidate.name,
              job_title: summary.job_title,
              error: describeError(e),
            });
          }
        });

        totals.archived = toArchive.length - failures.length;
        totals.failed = failures.length;

        return json(
          `Archived ${totals.archived} of ${toArchive.length} application(s) across ${byJob.size} job(s); ${failures.length} failed, ${skippedTotal} skipped.${send_email ? " Rejection emails queued." : ""}`,
          {
            dry_run: false,
            totals,
            jobs: [...byJob.values()],
            failures,
          }
        );
      } catch (e) {
        return error(e);
      }
    }
  );
}
