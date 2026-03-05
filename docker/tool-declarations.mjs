/**
 * tool-declarations.mjs — Shared tool schemas for sub-agent containers
 *
 * Single source of truth for the core tool declarations used by
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
    description: "Executa comando no workspace. Use commandLine para shell completa (ex: \"git status && npm test\") ou command+args para argv separado.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        commandLine: { type: "string", description: "Comando completo para executar via bash -lc" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "batch_tools",
    description: "Executa multiplas ferramentas independentes em paralelo e retorna os resultados agregados. Use apenas quando uma chamada nao depende da outra.",
    parameters: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          description: "Lista de chamadas { name, input } para executar em paralelo",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Nome da ferramenta" },
              input: { type: "object", description: "Parametros da ferramenta" },
            },
            required: ["name"],
            additionalProperties: true,
          },
        },
      },
      required: ["calls"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Navega para uma URL no navegador headless",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL completa para abrir" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Captura estado atual da pagina (titulo, URL, texto e links)",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_click",
    description: "Clica em um elemento. Use o ref do snapshot (ex: 'e51') OU um seletor CSS (ex: 'button.submit'). NUNCA use formato button[ref='e51'] — passe apenas o ref como 'e51'.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Ref do snapshot (ex: 'e51') ou seletor CSS (ex: 'button.login')" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description: "Preenche texto em um campo. Use o ref do snapshot (ex: 'e12') OU um seletor CSS (ex: 'input[name=user]').",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Ref do snapshot (ex: 'e12') ou seletor CSS (ex: 'input#email')" },
        text: { type: "string", description: "Texto para preencher" },
        submit: { type: "boolean", description: "Pressiona Enter apos preencher" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_wait_for",
    description: "Espera por um tempo ou por texto aparecer/desaparecer",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number", description: "Tempo em segundos" },
        text: { type: "string", description: "Texto que deve aparecer" },
        textGone: { type: "string", description: "Texto que deve desaparecer" },
      },
    },
  },
  {
    name: "browser_scroll",
    description: "Rola a pagina para cima/baixo em passos para carregar conteudo incremental",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", description: "down ou up" },
        pixels: { type: "number", description: "Quantidade de pixels por passo" },
        steps: { type: "number", description: "Quantidade de passos de rolagem" },
        waitMs: { type: "number", description: "Pausa em ms entre passos" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "Tira screenshot da pagina atual e salva no workspace",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Nome do arquivo (ex: tela.png)" },
        fullPage: { type: "boolean", description: "Captura pagina inteira" },
        type: { type: "string", description: "png ou jpeg" },
      },
    },
  },
  {
    name: "browser_press_key",
    description: "Pressiona uma tecla no navegador (ex: Enter, Tab, Escape, ArrowDown)",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Nome da tecla (ex: 'Enter', 'Tab', 'Escape', 'ArrowDown')" },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_run_code",
    description: "Executa código Playwright arbitrário na página. Recebe uma função JS async com argumento `page`. Essencial para iframes (page.frameLocator), shadow DOM, interações complexas e qualquer coisa que as ferramentas browser_* padrão não conseguem fazer.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Função JavaScript async para executar. Ex: `async (page) => { const frame = page.frameLocator('iframe#main'); await frame.locator('input#user').fill('test'); return { ok: true }; }`",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "browser_evaluate",
    description: "Avalia expressão JavaScript na página ou em um elemento específico. Útil para extrair dados do DOM, verificar estado de elementos, ou executar JS simples.",
    parameters: {
      type: "object",
      properties: {
        function: {
          type: "string",
          description: "Função JS para avaliar. Ex: `() => document.title` ou `(element) => element.textContent` quando ref é fornecido",
        },
        ref: {
          type: "string",
          description: "Ref do elemento do snapshot (ex: 'e51'). Se fornecido, a função recebe o elemento como argumento.",
        },
      },
      required: ["function"],
    },
  },
  {
    name: "browser_close",
    description: "Fecha navegador e limpa a sessao atual",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];
