# ashby-mcp

MCP server for [Ashby](https://www.ashbyhq.com/) ATS — designed for candidate evaluation workflows.

This server exposes Ashby's recruiting data through the [Model Context Protocol](https://modelcontextprotocol.io/), letting AI agents review candidates, read application details, and write evaluation notes.

## Setup

### 1. Get an Ashby API Key

1. Go to your Ashby admin settings → Integrations → API Keys
2. Create a new API key with these permissions:
   - `candidatesRead` — read candidate profiles, applications, notes, feedback
   - `jobsRead` — read job listings and details
   - `interviewsRead` — read interview stages and plans
   - `candidatesWrite` — add notes, tags, move application stages, archive applications
   - `hiringProcessMetadataRead` — list archive reasons and email templates

### 2. Install

#### Option A: npx (recommended — no clone needed)

Just add the config below and it works immediately.

#### Option B: Docker

```bash
docker build -t ashby-mcp .
```

#### Option C: From source

```bash
git clone https://github.com/dewierwan/ashby-mcp.git && cd ashby-mcp
npm install
npm run build
```

### 3. Configure

#### Claude Code

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "ashby": {
      "command": "npx",
      "args": ["-y", "ashby-mcp"],
      "env": {
        "ASHBY_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ashby": {
      "command": "npx",
      "args": ["-y", "ashby-mcp"],
      "env": {
        "ASHBY_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Docker

```json
{
  "mcpServers": {
    "ashby": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "ASHBY_API_KEY", "ashby-mcp"],
      "env": {
        "ASHBY_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Tools

All tools return dual-format responses: a human-readable summary followed by structured JSON.

### Jobs

#### `ashby_list_jobs`

List open jobs with IDs, titles, department, location, and status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | `"Open" \| "Closed" \| "Archived" \| "Draft" \| "All"` | `"Open"` | Filter by job status |
| `limit` | `number` (1-100) | `25` | Max results per page |
| `cursor` | `string` | — | Pagination cursor from previous response |

#### `ashby_get_job_details`

Full job details including description and interview plan stages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | `string` | Yes | Job ID (UUID) |

#### `ashby_get_pipeline_summary`

Pipeline overview with candidate counts per stage, per job.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `job_id` | `string` | — | Summary for one job. Omit for all jobs. |
| `status` | `"Open" \| "Closed" \| "All"` | `"Open"` | Which jobs to include |

### Candidates

#### `ashby_get_candidate`

Comprehensive candidate profile with all applications resolved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `candidate_id` | `string` | Yes | Candidate ID (UUID) |

#### `ashby_get_candidate_notes`

All notes on a candidate.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `candidate_id` | `string` | Yes | Candidate ID (UUID) |

#### `ashby_search_candidates`

Search candidates by name or email.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | — | Candidate name to search for (required) |
| `email` | `string` | — | Optional email (AND logic with name) |
| `limit` | `number` (1-100) | `25` | Max results |

#### `ashby_add_candidate_note`

Add an evaluation note to a candidate. Visible to the hiring team.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `candidate_id` | `string` | Yes | Candidate ID (UUID) |
| `note` | `string` | Yes | Note content (plain text) |

#### `ashby_add_candidate_tag`

Tag a candidate (e.g. "Strong Hire", "Needs Review").

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `candidate_id` | `string` | Yes | Candidate ID (UUID) |
| `tag_id` | `string` | Yes | Tag ID (UUID) from Ashby admin settings |

#### `ashby_get_resume`

Download and extract text from a candidate's resume (PDF, text).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_handle` | `string` | Yes | File handle from candidate's `fileHandles` array |
| `file_name` | `string` | No | Original filename (helps determine format) |

### Applications

#### `ashby_list_candidates_for_job`

List candidates/applications for a specific job with stage and status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `job_id` | `string` | — | Job ID (UUID) (required) |
| `limit` | `number` (1-100) | `25` | Max results per page |
| `cursor` | `string` | — | Pagination cursor |

#### `ashby_get_application_details`

Full application with stage history, feedback, and criteria evaluations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `application_id` | `string` | Yes | Application ID (UUID) |

#### `ashby_get_application_form_submission`

Candidate's submitted application form responses (screening questions, cover letter, etc).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `application_id` | `string` | Yes | Application ID (UUID) |

#### `ashby_list_applications`

List applications across all jobs with date, status, stage, and source filters.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `created_after` | `string` (ISO datetime) | — | Only applications after this time |
| `created_before` | `string` (ISO datetime) | — | Only applications before this time |
| `job_id` | `string` | — | Filter to a specific job |
| `status` | `"Active" \| "Archived" \| "Hired" \| "Lead" \| "All"` | `"All"` | Filter by status |
| `stage_type` | `"Lead" \| "PreInterviewScreen" \| "Interview" \| "Offer" \| "All"` | — | Filter by stage type |
| `stage_name` | `string` | — | Filter by exact stage name |
| `source` | `string` | — | Filter by source (case-insensitive substring) |
| `limit` | `number` (1-100) | `25` | Max results |
| `cursor` | `string` | — | Pagination cursor |

#### `ashby_archive_application`

Archive an application with reason and optional rejection email.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `application_id` | `string` | — | Application ID (UUID) (required) |
| `archive_reason_id` | `string` | — | Reason ID from `ashby_list_archive_reasons` |
| `send_email` | `boolean` | `false` | Send rejection email (requires `email_template_id`) |
| `email_template_id` | `string` | — | Template ID from `ashby_list_email_templates` |

#### `ashby_bulk_archive`

Archive multiple applications at once (max 25).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `application_ids` | `string[]` (1-25) | — | Application IDs (required) |
| `archive_reason_id` | `string` | — | Reason ID, applied to all |
| `send_email` | `boolean` | `false` | Send rejection emails |
| `email_template_id` | `string` | — | Template ID for rejection emails |

### Interviews

#### `ashby_list_interview_stages`

List all interview stages across all interview plans. No parameters.

#### `ashby_list_upcoming_interviews`

List upcoming and pending interview schedules.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_after` | `string` (ISO datetime) | now | Only interviews after this time |
| `start_before` | `string` (ISO datetime) | — | Only interviews before this time |
| `status` | `"Scheduled" \| "NeedsScheduling" \| "Complete" \| "Cancelled" \| "All"` | `"All"` | Filter by status |
| `limit` | `number` (1-100) | `25` | Max results |

### Workflow

#### `ashby_move_application_stage`

Move an application to a different interview stage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `application_id` | `string` | Yes | Application ID (UUID) |
| `stage_id` | `string` | Yes | Target stage ID from `ashby_list_interview_stages` |

#### `ashby_get_feedback`

Submitted feedback/scorecards for an application.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `application_id` | `string` | Yes | Application ID (UUID) |

#### `ashby_list_archive_reasons`

List available archive/rejection reasons. No parameters.

#### `ashby_list_email_templates`

List email templates for rejection emails. No parameters.

## Example Prompts

```
Show me all open engineering jobs.

List the candidates for the Senior Backend Engineer role and summarize where each one is in the pipeline.

Pull up the full profile for candidate Jane Smith — I want to see her resume info, application history, and any existing notes.

Review the feedback submitted for application abc-123 and summarize the interviewer evaluations.

Add a note to candidate xyz-456: "Strong technical skills demonstrated in system design round. Recommend advancing to final interview."

Move application abc-123 to the "Final Interview" stage.

Read the resume for candidate Jane Smith and summarize her experience.

How many people applied this week?

What does our pipeline look like for the Community Lead role?

Show me all candidates currently in the Work test stage.

Archive John Smith's application for the Senior Engineer role with reason "Not enough experience" and send the standard rejection email.

Show me the available archive reasons and rejection email templates.

Bulk archive all candidates in Application Review for the closed Designer role.
```

## Testing

### Verify API connectivity

```bash
ASHBY_API_KEY=your-key npm run test-api
```

### Test with MCP Inspector

```bash
ASHBY_API_KEY=your-key npx @modelcontextprotocol/inspector node dist/index.js
```

### Run directly

```bash
ASHBY_API_KEY=your-key node dist/index.js
```

The server communicates over stdio — it will start silently and wait for MCP protocol messages.

## Development

```bash
npm install
npm run build    # compile TypeScript to dist/
npm test         # run tests
npm start        # run the built server
```
