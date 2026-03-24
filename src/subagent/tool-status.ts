/**
 * Tool lifecycle formatting — OpenCode-aligned.
 *
 * Start:     `Read` `/relative/path.ts`
 * Completed: `Read` `/relative/path.ts` `23ms`
 * Error:     `Read:erro` `error message`
 * Bash:      `Bash` `$ echo hello`
 * Bash done: `Bash` `$ echo hello` `53ms`
 */

const WORKSPACE_PREFIX = "/workspace/";

/** Display names for tools — capitalized like OpenCode */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  run_command: "Bash",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  question: "Question",
  skill: "Skill",
  playwright_browser_snapshot: "Snapshot",
  playwright_browser_click: "Click",
  playwright_browser_navigate: "Navigate",
  playwright_browser_type: "Type",
  playwright_browser_take_screenshot: "Screenshot",
  playwright_browser_evaluate: "Evaluate",
  playwright_browser_run_code: "RunCode",
  rick_rick_search: "Search",
  rick_rick_memory: "Memory",
  rick_rick_save_memory: "SaveMemory",
  rick_rick_delete_memory: "DeleteMemory",
};

function displayName(raw: string): string {
  const lower = raw.toLowerCase();
  if (TOOL_DISPLAY_NAMES[lower]) return TOOL_DISPLAY_NAMES[lower];
  // Playwright tools: strip prefix
  if (lower.startsWith("playwright_browser_")) {
    const suffix = raw.slice("playwright_browser_".length);
    return suffix.charAt(0).toUpperCase() + suffix.slice(1);
  }
  // rick_ tools: strip prefix
  if (lower.startsWith("rick_rick_")) {
    const suffix = raw.slice("rick_rick_".length);
    return suffix.charAt(0).toUpperCase() + suffix.slice(1);
  }
  if (lower.startsWith("rick_")) {
    const suffix = raw.slice("rick_".length);
    return suffix.charAt(0).toUpperCase() + suffix.slice(1);
  }
  // Fallback: capitalize first letter
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Strip /workspace/project-name/ prefix to show relative path */
function relativePath(p: string): string {
  if (!p) return p;
  if (p.startsWith(WORKSPACE_PREFIX)) {
    const rest = p.slice(WORKSPACE_PREFIX.length);
    // Strip the project directory name (first segment)
    const slashIdx = rest.indexOf("/");
    return slashIdx >= 0 ? rest.slice(slashIdx + 1) : rest;
  }
  return p;
}

function firstStringValue(obj: Record<string, unknown>): string | null {
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function formatShellCommand(inp: Record<string, unknown>): string | null {
  if (typeof inp.commandLine === "string" && inp.commandLine.trim()) {
    return inp.commandLine.trim();
  }
  const command = typeof inp.command === "string" ? inp.command.trim() : "";
  const args = Array.isArray(inp.args)
    ? inp.args.map((a) => String(a)).filter((a) => a.trim().length > 0)
    : [];
  if (!command) return null;
  if (command === "bash" && args[0] === "-lc" && typeof args[1] === "string" && args[1].trim()) {
    return args[1].trim();
  }
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function compactToolError(name: string, message: string): string {
  let raw = String(message || "erro").trim();
  if (name === "run_command" || name === "bash") {
    raw = raw.replace(/^Sa[ií]da\s+\d+:\s*/i, "").trim();
    const stderrMarker = raw.lastIndexOf("STDERR:");
    if (stderrMarker >= 0) {
      raw = raw.slice(stderrMarker + 7).trim();
    } else {
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const preferred = [...lines].reverse().find((l) => /\berror\b|\bfatal\b|pathspec|not found|permission denied|acesso negado/i.test(l));
      raw = preferred || lines[lines.length - 1] || raw;
    }
  }
  return raw.replace(/\s+/g, " ").trim() || "erro";
}

/**
 * Build a tool start line.
 *
 * Examples:
 *   `Read` `src/index.ts`
 *   `Bash` `$ git status`
 *   `Glob` `**\/*.ts` `src/`
 *   `TodoWrite` `4 itens`
 *   `Task` `Explore the codebase`
 */
export function buildToolUseLine(toolName: string, input?: Record<string, unknown>): string {
  const inp = input ?? {};
  const name = displayName(toolName);
  let arg = "";

  const shell = formatShellCommand(inp);
  if (shell) {
    arg = `$ ${shell}`;
  } else if (typeof inp.filePath === "string" || typeof inp.file_path === "string") {
    arg = relativePath(String(inp.filePath ?? inp.file_path));
  } else if (typeof inp.notebook_path === "string") {
    arg = relativePath(String(inp.notebook_path));
  } else if (typeof inp.pattern === "string") {
    const location = (inp.path ?? inp.glob ?? inp.include) as string | undefined;
    const locRel = location ? relativePath(location) : "";
    arg = locRel ? `"${inp.pattern}" in ${locRel}` : `"${inp.pattern}"`;
  } else if (typeof inp.url === "string") {
    arg = String(inp.url);
  } else if (Array.isArray(inp.todos)) {
    arg = `${inp.todos.length} ${inp.todos.length === 1 ? "item" : "itens"}`;
  } else if (typeof inp.description === "string") {
    arg = String(inp.description);
  } else if (typeof inp.prompt === "string") {
    arg = inp.prompt.length > 80 ? inp.prompt.slice(0, 77) + "..." : String(inp.prompt);
  } else {
    const first = firstStringValue(inp);
    if (first && first.length <= 120) {
      arg = first;
    } else if (first) {
      arg = first.slice(0, 117) + "...";
    }
  }

  return arg ? `\n\`${name}\` \`${arg}\`\n` : `\n\`${name}\`\n`;
}

/**
 * Normalize runtime status text into compact format.
 */
export function normalizeStatusToolLine(text: string): string {
  const m = text.match(/^Executando:\s*(\S+)(?:\s+\((.+)\)|\s+(.+))?\s*$/);
  if (!m) return text;
  const tool = m[1];
  const arg = (m[2] ?? m[3] ?? "").trim();
  if (!arg) return buildToolUseLine(tool, {});
  if (/^(bash|run_command)$/i.test(tool)) {
    return buildToolUseLine(tool, { command: arg });
  }
  if (/^https?:\/\//i.test(arg)) {
    return buildToolUseLine(tool, { url: arg });
  }
  return buildToolUseLine(tool, { filePath: arg });
}

/**
 * Format a tool lifecycle event.
 *
 * Start:     `Read` `src/file.ts`
 * Completed: `Read` `src/file.ts` `23ms`
 * Error:     `Read:erro` `error message`
 */
export function formatToolLifecycleLine(input: {
  event: "start" | "completed" | "error";
  name: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  outputPreview?: string;
  message?: string;
}): string {
  const rawName = input.name || "tool";
  const name = displayName(rawName);

  if (input.event === "start") {
    return buildToolUseLine(rawName, input.args ?? {});
  }

  if (input.event === "completed") {
    const duration = typeof input.durationMs === "number" && input.durationMs >= 0
      ? `${Math.round(input.durationMs)}ms`
      : "";

    // Re-build the arg string from the original input for the completed line
    // This way the completed line has the SAME content as the start line + duration
    const inp = input.args ?? {};
    let arg = "";
    const shell = formatShellCommand(inp);
    if (shell) {
      arg = `$ ${shell}`;
    } else if (typeof inp.filePath === "string" || typeof inp.file_path === "string") {
      arg = relativePath(String(inp.filePath ?? inp.file_path));
    } else if (typeof inp.notebook_path === "string") {
      arg = relativePath(String(inp.notebook_path));
    } else if (typeof inp.pattern === "string") {
      const location = (inp.path ?? inp.glob ?? inp.include) as string | undefined;
      const locRel = location ? relativePath(location) : "";
      arg = locRel ? `"${inp.pattern}" in ${locRel}` : `"${inp.pattern}"`;
    } else if (typeof inp.url === "string") {
      arg = String(inp.url);
    } else if (Array.isArray(inp.todos)) {
      arg = `${inp.todos.length} ${inp.todos.length === 1 ? "item" : "itens"}`;
    } else if (typeof inp.description === "string") {
      arg = String(inp.description);
    } else if (typeof inp.prompt === "string") {
      arg = inp.prompt.length > 80 ? inp.prompt.slice(0, 77) + "..." : String(inp.prompt);
    } else {
      const first = firstStringValue(inp);
      if (first && first.length <= 120) {
        arg = first;
      } else if (first) {
        arg = first.slice(0, 117) + "...";
      }
    }

    const parts = [`\`${name}:ok\``];
    if (arg) parts.push(`\`${arg}\``);
    if (duration) parts.push(`\`${duration}\``);
    return "\n" + parts.join(" ") + "\n";
  }

  // Error
  const raw = compactToolError(rawName, String(input.message || "erro"));
  const short = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
  return `\n\`${name}:erro\` \`${short || "erro"}\`\n`;
}
