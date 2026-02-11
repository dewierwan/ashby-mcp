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
   - `candidatesWrite` — add notes, tags, and move application stages

### 2. Install

#### Option A: npx (recommended — no clone needed)

Just add the config below and it works immediately.

#### Option B: From source

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

## Tools

### Read tools

| Tool | Description |
|------|-------------|
| `ashby_list_jobs` | List open jobs with IDs, titles, department, location, status |
| `ashby_get_job_details` | Full job details including interview plan stages |
| `ashby_list_candidates_for_job` | List candidates/applications for a job with stage and status |
| `ashby_get_candidate` | Comprehensive candidate profile with all applications |
| `ashby_get_application_details` | Full application with stage history, feedback, evaluations |
| `ashby_get_candidate_notes` | All notes on a candidate |
| `ashby_search_candidates` | Search candidates by name or email |
| `ashby_list_interview_stages` | List all interview stages (pipeline reference) |
| `ashby_get_feedback` | Submitted feedback/scorecards for an application |
| `ashby_get_resume` | Download and extract text from a candidate's resume (PDF, text) |
| `ashby_list_applications` | List applications across all jobs with date, status, stage, and source filters |
| `ashby_get_pipeline_summary` | Pipeline overview with candidate counts per stage, per job |

### Write tools

| Tool | Description |
|------|-------------|
| `ashby_add_candidate_note` | Add an evaluation note to a candidate |
| `ashby_move_application_stage` | Move an application to a different interview stage |
| `ashby_add_candidate_tag` | Tag a candidate (e.g. "Strong Hire") |

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
