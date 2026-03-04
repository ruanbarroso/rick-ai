/**
 * tool-declarations.mjs — Shared tool schemas for sub-agent containers
 *
 * Single source of truth for the 5 core tool declarations used by
 * OpenAI and Gemini providers. Agent-specific tools (web_fetch, rick_memory,
 * rick_search) are added by agent.mjs on top of these.
 */

export const coreToolDeclarations = [
  {
    name: "read_file",
    description: "Lê o conteúdo de um arquivo do workspace",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo a /workspace ou absoluto" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Escreve conteúdo em um arquivo (cria se não existir)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Substitui uma string exata em um arquivo (primeira ocorrência)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "String exata a ser substituída" },
        new_string: { type: "string", description: "String de substituição" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "Lista arquivos do workspace recursivamente",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Diretório a listar (padrão: /workspace)" },
      },
    },
  },
  {
    name: "run_command",
    description: "Executa um comando no workspace (ex: git clone, npm install, npx tsc)",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
  },
];
