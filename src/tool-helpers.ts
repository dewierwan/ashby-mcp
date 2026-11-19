import { AshbyApiError } from "./ashby-client.js";
import { enhanceError } from "./enhance-error.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function error(e: unknown): ToolResult {
  if (e instanceof AshbyApiError) {
    const enhanced = enhanceError(e);
    return { content: [{ type: "text" as const, text: enhanced }] };
  }
  const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
  return { content: [{ type: "text" as const, text: msg }] };
}

export function json(summary: string, data: unknown): ToolResult {
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

/** A request refused before any API call, with instructions for the caller to fix it. */
export function rejected(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
