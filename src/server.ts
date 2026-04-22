import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { AshbyClient } from "./ashby-client.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerCandidateTools } from "./tools/candidates.js";
import { registerApplicationTools } from "./tools/applications.js";
import { registerInterviewTools } from "./tools/interviews.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerEscapeHatchTools } from "./tools/escape-hatch.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ashby",
    title: "Ashby",
    version,
    description: "Ashby ATS — candidate evaluation workflow",
    icons: [
      {
        src: "https://www.ashbyhq.com/favicon.png",
        mimeType: "image/png",
      },
    ],
  });

  const client = new AshbyClient();

  registerJobTools(server, client);
  registerCandidateTools(server, client);
  registerApplicationTools(server, client);
  registerInterviewTools(server, client);
  registerWorkflowTools(server, client);
  registerEscapeHatchTools(server, client);

  return server;
}
