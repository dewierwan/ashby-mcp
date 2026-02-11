/**
 * Smoke test — makes direct Ashby API calls to verify
 * the API key and connectivity before testing through MCP.
 *
 * Usage:  npm run test-api
 *         (requires ASHBY_API_KEY env var)
 */

const BASE_URL = "https://api.ashbyhq.com";

async function main() {
  const apiKey = process.env.ASHBY_API_KEY;
  if (!apiKey) {
    console.error("Set ASHBY_API_KEY environment variable first.");
    process.exit(1);
  }

  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: auth,
  };

  async function call(endpoint: string, body: Record<string, unknown> = {}) {
    console.log(`\n-> POST ${endpoint}`);
    const res = await fetch(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) {
      console.error("  FAIL:", data.errorInfo?.message ?? data.errorInfo?.code ?? data.errors);
      return null;
    }
    return data;
  }

  // 1. List jobs (no status filter — API rejects it)
  console.log("=== job.list ===");
  const jobs = await call("job.list", { limit: 5 });
  if (jobs) {
    console.log(`  OK: ${jobs.results.length} jobs, moreDataAvailable: ${jobs.moreDataAvailable}`);
    for (const j of jobs.results.slice(0, 3)) {
      console.log(`    - [${j.status}] ${j.title} (${j.id})`);
    }
  }

  // 2. Job info (uses "id", not "jobId")
  const jobId = jobs?.results?.[0]?.id;
  if (jobId) {
    console.log("\n=== job.info ===");
    const job = await call("job.info", { id: jobId });
    if (job) console.log(`  OK: ${job.results.title} (${job.results.status})`);
  }

  // 3. Interview stages (requires interviewPlanId)
  const planId = jobs?.results?.[0]?.defaultInterviewPlanId;
  if (planId) {
    console.log("\n=== interviewStage.list ===");
    const stages = await call("interviewStage.list", { interviewPlanId: planId });
    if (stages) {
      console.log(`  OK: ${stages.results.length} stages`);
      for (const s of stages.results.slice(0, 5)) {
        console.log(`    - ${s.title} (type: ${s.type})`);
      }
    }
  }

  // 4. Candidate search
  console.log("\n=== candidate.search ===");
  const candidates = await call("candidate.search", { name: "test", limit: 3 });
  if (candidates) {
    console.log(`  OK: ${candidates.results.length} candidates`);
    for (const c of candidates.results) {
      console.log(`    - ${c.name} (${c.primaryEmailAddress?.value ?? "no email"})`);
    }
  }

  // 5. Candidate info (uses "id", not "candidateId")
  const candId = candidates?.results?.[0]?.id;
  if (candId) {
    console.log("\n=== candidate.info ===");
    const cand = await call("candidate.info", { id: candId });
    if (cand) console.log(`  OK: ${cand.results.name}, apps: ${cand.results.applicationIds?.length ?? 0}`);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
