function firstStringValue(obj: Record<string, unknown>): string | null {
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Build a standardized tool-use line for terminal blocks.
 * Format: `\n`[tool]` `arg`\n`
 */
export function buildToolUseLine(toolName: string, input?: Record<string, unknown>): string {
  const inp = input ?? {};
  let out = `\n\`[${toolName}]\` `;

  if (typeof inp.command === "string") {
    out += `\`$ ${inp.command}\`\n`;
  } else if (typeof inp.filePath === "string" || typeof inp.file_path === "string") {
    out += `\`${inp.filePath ?? inp.file_path}\`\n`;
  } else if (typeof inp.notebook_path === "string") {
    out += `\`${inp.notebook_path}\`\n`;
  } else if (typeof inp.pattern === "string") {
    const location = (inp.path ?? inp.glob ?? inp.include) as string | undefined;
    out += location ? `\`${inp.pattern}\` \`${location}\`\n` : `\`${inp.pattern}\`\n`;
  } else if (typeof inp.url === "string") {
    out += `\`${inp.url}\`\n`;
  } else if (Array.isArray(inp.todos)) {
    out += `\`${inp.todos.length} ${inp.todos.length === 1 ? "item" : "itens"}\`\n`;
  } else if (typeof inp.description === "string") {
    out += `\`${inp.description}\`\n`;
  } else if (typeof inp.prompt === "string") {
    const short = inp.prompt.length > 80 ? inp.prompt.slice(0, 77) + "..." : inp.prompt;
    out += `\`${short}\`\n`;
  } else {
    const first = firstStringValue(inp);
    if (first && first.length <= 120) {
      out += `\`${first}\`\n`;
    } else if (first) {
      out += `\`${first.slice(0, 117)}...\`\n`;
    } else {
      out += "\n";
    }
  }

  return out;
}

/**
 * Normalize runtime status text into a compact terminal-style format.
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
