import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AshbyClient } from "../ashby-client.js";
import type { Application, Candidate, CandidateNote } from "../types.js";
import { extractPdfText } from "../pdf.js";
import { error, json } from "../tool-helpers.js";
import { logger } from "../logger.js";

export function registerCandidateTools(server: McpServer, client: AshbyClient): void {
  // ── ashby_get_candidate ──────────────────────────────────────────────

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

        const data = {
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
        };

        return json(
          `${candidate.name} — ${applications.length} application(s).`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_candidate_notes ────────────────────────────────────────

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

        const data = {
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
        };

        return json(
          `${page.results.length} note(s) found.`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_search_candidates ──────────────────────────────────────────

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

        const data = {
          candidates: results.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.primaryEmailAddress?.value ?? null,
            phone: c.primaryPhoneNumber?.value ?? null,
          })),
        };

        return json(
          `${results.length} candidate(s) matching "${query}"${email ? ` and email "${email}"` : ""}.`,
          data
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_add_candidate_note ─────────────────────────────────────────

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

        return json(
          `Note added to candidate ${candidate_id}.`,
          { note_id: result.id, message: `Note added to candidate ${candidate_id}.` }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_add_candidate_tag ──────────────────────────────────────────

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

        return json(
          `Tag added to candidate ${candidate_id}.`,
          { message: `Tag ${tag_id} added to candidate ${candidate_id}.` }
        );
      } catch (e) {
        return error(e);
      }
    }
  );

  // ── ashby_get_resume ─────────────────────────────────────────────────

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
          return json("No download URL returned by Ashby.", { error: "No download URL returned by Ashby." });
        }

        // Download the file (60s timeout for large files)
        const response = await fetch(url, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          return json(
            `Failed to download file: HTTP ${response.status}`,
            { error: `Failed to download file: HTTP ${response.status}`, url }
          );
        }

        const contentType = response.headers.get("content-type") ?? "";
        const name = file_name ?? "unknown";
        const ext = name.split(".").pop()?.toLowerCase() ?? "";

        // For plain text files, return content directly
        if (contentType.includes("text/") || ["txt", "md", "csv"].includes(ext)) {
          const text = await response.text();
          return json(`Extracted text from ${name}.`, { filename: name, content: text });
        }

        // For PDFs, extract text from the binary
        if (contentType.includes("pdf") || ext === "pdf") {
          const buffer = Buffer.from(await response.arrayBuffer());
          const text = extractPdfText(buffer);

          if (text.length > 0) {
            return json(`Extracted text from PDF ${name}.`, { filename: name, format: "pdf", content: text });
          }

          return json(
            `Could not extract text from PDF ${name} (may be scanned/image-only).`,
            {
              filename: name,
              format: "pdf",
              content: "(Could not extract text — PDF may be scanned/image-only. Use the URL to view it directly.)",
              url,
            }
          );
        }

        // For other formats, just return the URL
        return json(
          `Unsupported format for text extraction. Download URL provided.`,
          {
            filename: name,
            format: ext || contentType,
            content: "(Unsupported format for text extraction. Use the URL to view it directly.)",
            url,
          }
        );
      } catch (e) {
        return error(e);
      }
    }
  );
}
