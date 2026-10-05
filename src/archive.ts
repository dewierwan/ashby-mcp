import type { AshbyClient } from "./ashby-client.js";
import { AshbyApiError } from "./ashby-client.js";
import type { Application, InterviewStage, Job } from "./types.js";

/** The fields of an application needed to archive it. */
export type ArchivableApplication = Pick<Application, "id" | "job" | "currentInterviewStage">;

export interface ArchiveOptions {
  archiveReasonId?: string;
  /** When set, Ashby sends this rejection email template on archive. */
  emailTemplateId?: string;
}

/** One-line, human-readable message for a failed per-application call. */
export function describeError(e: unknown): string {
  if (e instanceof AshbyApiError) {
    return `Ashby API error: ${e.message}${e.code ? ` (${e.code})` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Map over items with at most `concurrency` calls in flight. Preserves order. */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isRetryable(e: unknown): boolean {
  return e instanceof AshbyApiError && e.httpStatus !== undefined && (e.httpStatus === 429 || e.httpStatus >= 500);
}

/**
 * Retry on 429/5xx with a longer backoff than the client's own retries.
 * Long bulk runs can exhaust the client's short retry window under rate limiting.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  { retries = 2, baseDelayMs = 5_000 }: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
}

/**
 * Build an archiver that moves applications to their job's Archived stage.
 * Caches the job → interview plan and plan → Archived stage lookups, sharing
 * in-flight lookups so concurrent archives on the same job make one call.
 */
export function createArchiver(client: AshbyClient, options: ArchiveOptions) {
  const planByJob = new Map<string, Promise<string | undefined>>();
  const archivedStageByPlan = new Map<string, Promise<string | undefined>>();

  function planForJob(jobId: string): Promise<string | undefined> {
    let p = planByJob.get(jobId);
    if (!p) {
      p = client
        .request<Job>("job.info", { id: jobId })
        .then((job) => (job.interviewPlanIds ?? [])[0] ?? job.defaultInterviewPlanId);
      p.catch(() => planByJob.delete(jobId));
      planByJob.set(jobId, p);
    }
    return p;
  }

  function archivedStageForPlan(planId: string): Promise<string | undefined> {
    let p = archivedStageByPlan.get(planId);
    if (!p) {
      p = client
        .requestList<InterviewStage>("interviewStage.list", { interviewPlanId: planId })
        .then((page) => page.results.find((s) => s.type === "Archived")?.id);
      p.catch(() => archivedStageByPlan.delete(planId));
      archivedStageByPlan.set(planId, p);
    }
    return p;
  }

  /** Archive one application. Throws on failure so callers can collect errors. */
  async function archive(app: ArchivableApplication): Promise<void> {
    const planId = app.currentInterviewStage?.interviewPlanId ?? (await planForJob(app.job.id));
    if (!planId) throw new Error("Could not determine interview plan.");

    const archivedStageId = await archivedStageForPlan(planId);
    if (!archivedStageId) throw new Error(`No archived stage in plan ${planId}.`);

    const params: Record<string, unknown> = {
      applicationId: app.id,
      interviewStageId: archivedStageId,
    };
    if (options.archiveReasonId) params.archiveReasonId = options.archiveReasonId;
    if (options.emailTemplateId) {
      params.archiveEmail = { communicationTemplateId: options.emailTemplateId };
    }
    await client.request<Application>("application.changeStage", params);
  }

  return { archive };
}
