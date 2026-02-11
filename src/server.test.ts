import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AshbyApiError } from "./ashby-client.js";

// Mock the AshbyClient module before any imports that use it
const mockRequest = vi.fn();
const mockRequestList = vi.fn();

vi.mock("./ashby-client.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./ashby-client.js")>();
  return {
    ...orig,
    AshbyClient: vi.fn().mockImplementation(() => ({
      request: mockRequest,
      requestList: mockRequestList,
    })),
  };
});

// Mock fetch for the resume tool (file downloads)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createServer } from "./server.js";

// Helper: connect a test client to the server and return the client
async function setupClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

// Helper: extract parsed JSON from a callTool result
function getJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result as { content: { type: string; text: string }[] }).content[0]?.text;
  return JSON.parse(text);
}

describe("createServer", () => {
  beforeEach(() => {
    process.env.ASHBY_API_KEY = "test-key";
    mockRequest.mockReset();
    mockRequestList.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.ASHBY_API_KEY;
  });

  it("registers all 15 tools", async () => {
    const client = await setupClient();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(15);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ashby_add_candidate_note",
      "ashby_add_candidate_tag",
      "ashby_get_application_details",
      "ashby_get_candidate",
      "ashby_get_candidate_notes",
      "ashby_get_feedback",
      "ashby_get_job_details",
      "ashby_get_pipeline_summary",
      "ashby_get_resume",
      "ashby_list_applications",
      "ashby_list_candidates_for_job",
      "ashby_list_interview_stages",
      "ashby_list_jobs",
      "ashby_move_application_stage",
      "ashby_search_candidates",
    ]);
  });

  describe("ashby_list_jobs", () => {
    it("maps response fields correctly", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [
          {
            id: "job-1",
            title: "Engineer",
            status: "Open",
            locationId: "loc-1",
            departmentId: "dep-1",
            createdAt: "2024-01-01",
            updatedAt: "2024-01-02",
          },
        ],
        moreDataAvailable: false,
        nextCursor: undefined,
      });

      const client = await setupClient();
      const result = await client.callTool({ name: "ashby_list_jobs", arguments: {} });
      const data = getJson(result) as { items: unknown[]; has_more: boolean; next_cursor: unknown };

      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toEqual({
        id: "job-1",
        title: "Engineer",
        status: "Open",
        locationId: "loc-1",
        departmentId: "dep-1",
        createdAt: "2024-01-01",
        updatedAt: "2024-01-02",
      });
      expect(data.has_more).toBe(false);
      expect(data.next_cursor).toBeNull();
    });

    it("passes status filter to the API (not All)", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      await client.callTool({
        name: "ashby_list_jobs",
        arguments: { status: "Closed" },
      });

      expect(mockRequestList).toHaveBeenCalledWith("job.list", { limit: 25, status: "Closed" });
    });

    it("omits status param when filtering by All", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      await client.callTool({
        name: "ashby_list_jobs",
        arguments: { status: "All" },
      });

      expect(mockRequestList).toHaveBeenCalledWith("job.list", { limit: 25 });
    });

    it("returns error ToolResult on API failure", async () => {
      mockRequestList.mockRejectedValueOnce(new AshbyApiError("Rate limited", 429, "rate_limit"));

      const client = await setupClient();
      const result = await client.callTool({ name: "ashby_list_jobs", arguments: {} });
      const text = (result as { content: { type: string; text: string }[] }).content[0].text;

      expect(text).toContain("Ashby API error");
      expect(text).toContain("Rate limited");
    });
  });

  describe("ashby_get_candidate", () => {
    it("resolves applicationIds concurrently", async () => {
      mockRequest.mockImplementation(
        (endpoint: string, params: Record<string, unknown>) => {
          if (endpoint === "candidate.info") {
            return Promise.resolve({
              id: "cand-1",
              name: "Jane Doe",
              primaryEmailAddress: { value: "jane@example.com" },
              applicationIds: ["app-1", "app-2"],
              tags: [],
              socialLinks: [],
              fileHandles: [],
            });
          }
          if (endpoint === "application.info") {
            return Promise.resolve({
              id: params.applicationId,
              status: "Active",
              candidate: { id: "cand-1", name: "Jane Doe" },
              job: { id: "job-1", title: "Engineer" },
              currentInterviewStage: {
                id: "stage-1",
                title: "Phone Screen",
                type: "PhoneScreen",
                orderInInterviewPlan: 1,
              },
              hiringTeam: [],
              createdAt: "2024-01-01",
            });
          }
          return Promise.reject(new Error(`unexpected: ${endpoint}`));
        }
      );

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_candidate",
        arguments: { candidate_id: "cand-1" },
      });
      const data = getJson(result) as {
        candidate: { id: string; name: string };
        applications: { id: string }[];
      };

      expect(data.candidate.name).toBe("Jane Doe");
      expect(data.applications).toHaveLength(2);
      // Both application.info calls should have been made
      expect(mockRequest).toHaveBeenCalledWith("application.info", { applicationId: "app-1" });
      expect(mockRequest).toHaveBeenCalledWith("application.info", { applicationId: "app-2" });
    });

    it("handles partial application failures gracefully", async () => {
      mockRequest.mockImplementation(
        (endpoint: string, params: Record<string, unknown>) => {
          if (endpoint === "candidate.info") {
            return Promise.resolve({
              id: "cand-1",
              name: "Jane Doe",
              applicationIds: ["app-1", "app-2"],
              tags: [],
              socialLinks: [],
              fileHandles: [],
            });
          }
          if (endpoint === "application.info") {
            if (params.applicationId === "app-1") {
              return Promise.resolve({
                id: "app-1",
                status: "Active",
                candidate: { id: "cand-1", name: "Jane Doe" },
                job: { id: "job-1", title: "Engineer" },
                hiringTeam: [],
                createdAt: "2024-01-01",
              });
            }
            // app-2 fails
            return Promise.reject(new Error("not found"));
          }
          return Promise.reject(new Error(`unexpected: ${endpoint}`));
        }
      );

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_candidate",
        arguments: { candidate_id: "cand-1" },
      });
      const data = getJson(result) as { applications: { id: string }[] };

      // Only app-1 should be in results; app-2 was filtered out
      expect(data.applications).toHaveLength(1);
      expect(data.applications[0].id).toBe("app-1");
    });
  });

  describe("ashby_get_application_details", () => {
    it("fires 4 concurrent API calls and returns combined result", async () => {
      mockRequest.mockResolvedValueOnce({
        id: "app-1",
        status: "Active",
        candidate: { id: "cand-1", name: "Jane Doe" },
        job: { id: "job-1", title: "Engineer" },
        currentInterviewStage: {
          id: "stage-1",
          title: "On-site",
          type: "Interview",
          orderInInterviewPlan: 2,
        },
        hiringTeam: [
          { userId: "u1", firstName: "Bob", lastName: "Smith", email: "bob@co.com", role: "Hiring Manager" },
        ],
        customFields: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-02",
      });
      mockRequestList
        .mockResolvedValueOnce({ results: [{ id: "h1", stageId: "s1", title: "Applied", enteredStageAt: "2024-01-01", stageNumber: 1 }], moreDataAvailable: false })
        .mockResolvedValueOnce({ results: [{ rating: 4, evaluator: "Bob" }], moreDataAvailable: false })
        .mockResolvedValueOnce({ results: [{ formId: "f1", values: {} }], moreDataAvailable: false });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_application_details",
        arguments: { application_id: "app-1" },
      });
      const data = getJson(result) as {
        application: { id: string; hiringTeam: { name: string }[] };
        stage_history: unknown[];
        criteria_evaluations: unknown[];
        feedback: unknown[];
      };

      expect(data.application.id).toBe("app-1");
      expect(data.application.hiringTeam[0].name).toBe("Bob Smith");
      expect(data.stage_history).toHaveLength(1);
      expect(data.criteria_evaluations).toHaveLength(1);
      expect(data.feedback).toHaveLength(1);

      // Verify the right endpoints were called
      expect(mockRequest).toHaveBeenCalledWith("application.info", { applicationId: "app-1" });
      expect(mockRequestList).toHaveBeenCalledWith("application.listHistory", { applicationId: "app-1" });
      expect(mockRequestList).toHaveBeenCalledWith("application.listCriteriaEvaluations", { applicationId: "app-1" });
      expect(mockRequestList).toHaveBeenCalledWith("applicationFeedback.list", { applicationId: "app-1" });
    });
  });

  describe("ashby_search_candidates", () => {
    it("passes name and email params correctly", async () => {
      mockRequest.mockResolvedValueOnce([
        { id: "c1", name: "Alice", primaryEmailAddress: { value: "alice@co.com" } },
      ]);

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_search_candidates",
        arguments: { query: "Alice", email: "alice@co.com" },
      });
      const data = getJson(result) as { candidates: { id: string; name: string }[] };

      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0].name).toBe("Alice");
      expect(mockRequest).toHaveBeenCalledWith("candidate.search", {
        name: "Alice",
        email: "alice@co.com",
        limit: 25,
      });
    });
  });

  describe("ashby_add_candidate_note", () => {
    it("creates a note and returns confirmation", async () => {
      mockRequest.mockResolvedValueOnce({ id: "note-1" });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_add_candidate_note",
        arguments: { candidate_id: "cand-1", note: "Strong candidate" },
      });
      const data = getJson(result) as { note_id: string; message: string };

      expect(data.note_id).toBe("note-1");
      expect(data.message).toContain("cand-1");
      expect(mockRequest).toHaveBeenCalledWith("candidate.createNote", {
        candidateId: "cand-1",
        note: "Strong candidate",
      });
    });
  });

  describe("ashby_move_application_stage", () => {
    it("moves application and returns new stage", async () => {
      mockRequest.mockResolvedValueOnce({
        id: "app-1",
        status: "Active",
        currentInterviewStage: { id: "stage-2", title: "On-site", type: "Interview" },
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_move_application_stage",
        arguments: { application_id: "app-1", stage_id: "stage-2" },
      });
      const data = getJson(result) as { application_id: string; new_stage: { title: string } };

      expect(data.application_id).toBe("app-1");
      expect(data.new_stage.title).toBe("On-site");
    });
  });

  describe("ashby_get_resume", () => {
    it("extracts text from a PDF file", async () => {
      // Mock file.info to return a download URL
      mockRequest.mockResolvedValueOnce({ url: "https://example.com/resume.pdf" });

      // Mock fetch to return a minimal PDF with text
      const pdfContent = "%PDF-1.4\n<< /Length 22 >>\nstream\nBT (Hello World) Tj ET\nendstream\n%%EOF";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(Buffer.from(pdfContent, "latin1").buffer),
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_resume",
        arguments: { file_handle: "fh-1", file_name: "resume.pdf" },
      });
      const data = getJson(result) as { filename: string; format: string; content: string };

      expect(data.format).toBe("pdf");
      expect(data.content).toContain("Hello World");
    });

    it("returns plain text for text files", async () => {
      mockRequest.mockResolvedValueOnce({ url: "https://example.com/resume.txt" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve("My resume content"),
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_resume",
        arguments: { file_handle: "fh-2", file_name: "resume.txt" },
      });
      const data = getJson(result) as { filename: string; content: string };

      expect(data.content).toBe("My resume content");
    });

    it("returns error on download failure", async () => {
      mockRequest.mockResolvedValueOnce({ url: "https://example.com/bad.pdf" });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_resume",
        arguments: { file_handle: "fh-3", file_name: "bad.pdf" },
      });
      const data = getJson(result) as { error: string };

      expect(data.error).toContain("404");
    });
  });

  describe("ashby_list_applications", () => {
    it("passes date and status filters to the API", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [
          {
            id: "app-1",
            status: "Active",
            candidate: { id: "c1", name: "Alice", primaryEmailAddress: { value: "a@co.com" } },
            job: { id: "j1", title: "Engineer" },
            currentInterviewStage: { id: "s1", title: "Phone Screen", type: "Interview" },
            source: { title: "Applied" },
            createdAt: "2024-06-15T10:00:00Z",
          },
        ],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_list_applications",
        arguments: { created_after: "2024-06-01T00:00:00Z", status: "Active" },
      });
      const data = getJson(result) as { items: { application_id: string; job_title: string }[] };

      expect(data.items).toHaveLength(1);
      expect(data.items[0].application_id).toBe("app-1");
      expect(data.items[0].job_title).toBe("Engineer");

      // Verify server-side filters were passed
      expect(mockRequestList).toHaveBeenCalledWith("application.list", expect.objectContaining({
        createdAfter: new Date("2024-06-01T00:00:00Z").getTime(),
        status: "Active",
      }));
    });

    it("applies client-side stage_type filter", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [
          {
            id: "app-1",
            status: "Active",
            candidate: { id: "c1", name: "Alice" },
            job: { id: "j1", title: "Engineer" },
            currentInterviewStage: { id: "s1", title: "Phone Screen", type: "Interview" },
            createdAt: "2024-06-15",
          },
          {
            id: "app-2",
            status: "Lead",
            candidate: { id: "c2", name: "Bob" },
            job: { id: "j1", title: "Engineer" },
            currentInterviewStage: { id: "s2", title: "New Lead", type: "Lead" },
            createdAt: "2024-06-15",
          },
        ],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_list_applications",
        arguments: { stage_type: "Interview" },
      });
      const data = getJson(result) as { items: { application_id: string }[] };

      expect(data.items).toHaveLength(1);
      expect(data.items[0].application_id).toBe("app-1");
    });

    it("applies client-side source filter (case-insensitive substring)", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [
          {
            id: "app-1",
            status: "Active",
            candidate: { id: "c1", name: "Alice" },
            job: { id: "j1", title: "Engineer" },
            source: { title: "Ashby Chrome Extension" },
            createdAt: "2024-06-15",
          },
          {
            id: "app-2",
            status: "Active",
            candidate: { id: "c2", name: "Bob" },
            job: { id: "j1", title: "Engineer" },
            source: { title: "Applied" },
            createdAt: "2024-06-15",
          },
        ],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_list_applications",
        arguments: { source: "chrome" },
      });
      const data = getJson(result) as { items: { application_id: string }[] };

      expect(data.items).toHaveLength(1);
      expect(data.items[0].application_id).toBe("app-1");
    });

    it("applies client-side created_before filter", async () => {
      mockRequestList.mockResolvedValueOnce({
        results: [
          {
            id: "app-old",
            status: "Active",
            candidate: { id: "c1", name: "Alice" },
            job: { id: "j1", title: "Engineer" },
            createdAt: "2024-01-01T00:00:00Z",
          },
          {
            id: "app-new",
            status: "Active",
            candidate: { id: "c2", name: "Bob" },
            job: { id: "j1", title: "Engineer" },
            createdAt: "2024-12-01T00:00:00Z",
          },
        ],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_list_applications",
        arguments: { created_before: "2024-06-01T00:00:00Z" },
      });
      const data = getJson(result) as { items: { application_id: string }[] };

      expect(data.items).toHaveLength(1);
      expect(data.items[0].application_id).toBe("app-old");
    });
  });

  describe("ashby_get_pipeline_summary", () => {
    it("aggregates counts per stage for a single job", async () => {
      mockRequest.mockResolvedValueOnce({ id: "j1", title: "Engineer" });
      mockRequestList.mockResolvedValueOnce({
        results: [
          { id: "a1", status: "Active", currentInterviewStage: { title: "Phone Screen", type: "Interview" }, candidate: { id: "c1" }, job: { id: "j1" } },
          { id: "a2", status: "Active", currentInterviewStage: { title: "Phone Screen", type: "Interview" }, candidate: { id: "c2" }, job: { id: "j1" } },
          { id: "a3", status: "Active", currentInterviewStage: { title: "On-site", type: "Interview" }, candidate: { id: "c3" }, job: { id: "j1" } },
          { id: "a4", status: "Archived", currentInterviewStage: { title: "Archived", type: "Archived" }, candidate: { id: "c4" }, job: { id: "j1" } },
        ],
        moreDataAvailable: false,
      });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_pipeline_summary",
        arguments: { job_id: "j1" },
      });
      const data = getJson(result) as {
        jobs: { job_title: string; total_active: number; total_archived: number; stages: { title: string; count: number }[] }[];
        totals: { active: number; archived: number };
      };

      expect(data.jobs).toHaveLength(1);
      expect(data.jobs[0].job_title).toBe("Engineer");
      expect(data.jobs[0].total_active).toBe(3);
      expect(data.jobs[0].total_archived).toBe(1);

      const phoneScreen = data.jobs[0].stages.find((s) => s.title === "Phone Screen");
      expect(phoneScreen?.count).toBe(2);

      expect(data.totals.active).toBe(3);
      expect(data.totals.archived).toBe(1);
    });

    it("summarizes all open jobs when no job_id provided", async () => {
      // First call: job.list
      mockRequestList
        .mockResolvedValueOnce({
          results: [
            { id: "j1", title: "Engineer" },
            { id: "j2", title: "Designer" },
          ],
          moreDataAvailable: false,
        })
        // Second call: application.list for j1
        .mockResolvedValueOnce({
          results: [
            { id: "a1", status: "Active", currentInterviewStage: { title: "Applied", type: "PreInterviewScreen" }, candidate: { id: "c1" }, job: { id: "j1" } },
          ],
          moreDataAvailable: false,
        })
        // Third call: application.list for j2
        .mockResolvedValueOnce({
          results: [
            { id: "a2", status: "Lead", currentInterviewStage: { title: "New Lead", type: "Lead" }, candidate: { id: "c2" }, job: { id: "j2" } },
          ],
          moreDataAvailable: false,
        });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_pipeline_summary",
        arguments: {},
      });
      const data = getJson(result) as {
        jobs: { job_title: string }[];
        totals: { active: number; leads: number };
      };

      expect(data.jobs).toHaveLength(2);
      expect(data.totals.active).toBe(2);
      expect(data.totals.leads).toBe(1);
    });

    it("paginates internally to fetch all applications", async () => {
      mockRequest.mockResolvedValueOnce({ id: "j1", title: "Engineer" });
      mockRequestList
        // First page
        .mockResolvedValueOnce({
          results: [
            { id: "a1", status: "Active", currentInterviewStage: { title: "Applied", type: "PreInterviewScreen" }, candidate: { id: "c1" }, job: { id: "j1" } },
          ],
          moreDataAvailable: true,
          nextCursor: "page2",
        })
        // Second page
        .mockResolvedValueOnce({
          results: [
            { id: "a2", status: "Active", currentInterviewStage: { title: "Applied", type: "PreInterviewScreen" }, candidate: { id: "c2" }, job: { id: "j1" } },
          ],
          moreDataAvailable: false,
        });

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_pipeline_summary",
        arguments: { job_id: "j1" },
      });
      const data = getJson(result) as {
        jobs: { total_active: number; stages: { title: string; count: number }[] }[];
      };

      expect(data.jobs[0].total_active).toBe(2);
      expect(data.jobs[0].stages[0].count).toBe(2);
      // Verify it fetched both pages
      expect(mockRequestList).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("returns error ToolResult for AshbyApiError (not throw)", async () => {
      mockRequest.mockRejectedValueOnce(
        new AshbyApiError("Not found", 404, "not_found")
      );

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_candidate",
        arguments: { candidate_id: "bad-id" },
      });

      // Should NOT throw — should return a text content with error message
      const text = (result as { content: { type: string; text: string }[] }).content[0].text;
      expect(text).toContain("Ashby API error");
      expect(text).toContain("Not found");
      expect(text).toContain("not_found");
    });

    it("returns error ToolResult for generic errors", async () => {
      mockRequest.mockRejectedValueOnce(new Error("Network timeout"));

      const client = await setupClient();
      const result = await client.callTool({
        name: "ashby_get_candidate",
        arguments: { candidate_id: "bad-id" },
      });

      const text = (result as { content: { type: string; text: string }[] }).content[0].text;
      expect(text).toContain("Error:");
      expect(text).toContain("Network timeout");
    });
  });
});
