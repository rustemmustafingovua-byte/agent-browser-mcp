#!/usr/bin/env node
/**
 * agent-browser-mcp — MCP-сервер: настоящий браузер для агента.
 *
 *   agent-browser-mcp                 # stdio-режим (для OpenCode / Claude Code)
 *
 * Инструменты:
 *   browser_navigate   открыть страницу и пройти защитный экран (если получится)
 *   browser_read       текст текущей страницы
 *   browser_links      ссылки страницы
 *   browser_click      клик по селектору
 *   browser_type       ввод текста
 *   browser_wait_for   ждать элемент
 *   browser_screenshot скриншот
 *   browser_close      закрыть браузер
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { BrowserSession } from "../src/browser.js"

const VERSION = "0.1.0"
const HELP = `agent-browser-mcp — настоящий браузер для агента (MCP, stdio).

USAGE
  agent-browser-mcp

ENVIRONMENT
  AGENT_BROWSER_HEADLESS=false      показать окно браузера
  AGENT_BROWSER_PATH=…              свой Chromium/Brave (иначе ищется сам)
  AGENT_BROWSER_LOCALE=ru-RU        язык страницы
  FLARESOLVERR_URL=…                локальный решатель Cloudflare-челленджей
  CAPSOLVER_KEY=…                   платный решатель (только для доменов из allowlist)
  AGENT_BROWSER_ALLOWLIST=a.com,*.b.com   кому можно платить
  AGENT_BROWSER_SOLVER_BUDGET=5     сколько платных решений в час
  AGENT_BROWSER_CHALLENGE_WAIT=12000  сколько ждать JS-челленджей, мс

MIT · https://github.com/rustemmustafingovua-byte/agent-browser-mcp`

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION)
  process.exit(0)
}

const session = new BrowserSession()

const tools = [
  {
    name: "browser_navigate",
    description:
      "Open a URL in a real browser. If a Cloudflare or captcha screen appears, the server tries a local FlareSolverr, then a paid solver for allow-listed domains, then waits for the JavaScript challenge to resolve itself. Returns the URL, title, and which path worked.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page URL" },
        timeout_ms: { type: "number", description: "Navigation timeout (default 30000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_read",
    description: "Read the text of the current page (or of one element). Use it after browser_navigate.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (default body)" },
        max_chars: { type: "number", description: "Trim output (default 20000)" },
      },
    },
  },
  {
    name: "browser_links",
    description: "List the links of the current page with their anchor text.",
    inputSchema: {
      type: "object",
      properties: { max: { type: "number", description: "Maximum links (default 50)" } },
    },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector and wait for the page to settle.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector" } },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into an element (optionally pressing Enter afterwards).",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        text: { type: "string", description: "Text to type" },
        submit: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait until an element appears on the current page.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector" } },
      required: ["selector"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Screenshot of the current page. Returns a file path when a path is given, otherwise base64 PNG.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to save the PNG" },
        full_page: { type: "boolean", description: "Full page instead of the viewport" },
      },
    },
  },
  {
    name: "browser_close",
    description: "Close the browser and release the session.",
    inputSchema: { type: "object", properties: {} },
  },
]

const server = new Server(
  { name: "agent-browser-mcp", version: VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = args ?? {}
  const ok = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] })
  const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true })
  try {
    switch (name) {
      case "browser_navigate": {
        const r = await session.navigate(a.url, { timeoutMs: a.timeout_ms ?? 30000 })
        const text = await session.text({ maxChars: 6000 })
        return ok({ ...r, text })
      }
      case "browser_read":
        return ok(await session.text({ selector: a.selector, maxChars: a.max_chars ?? 20000 }))
      case "browser_links":
        return ok(await session.links({ max: a.max ?? 50 }))
      case "browser_click":
        return ok(await session.click(a.selector))
      case "browser_type":
        return ok(await session.type(a.selector, a.text ?? "", { submit: a.submit }))
      case "browser_wait_for":
        return ok(await session.waitFor(a.selector))
      case "browser_screenshot":
        return ok(await session.screenshot({ path: a.path, fullPage: a.full_page }))
      case "browser_close":
        await session.close()
        return ok("браузер закрыт")
      default:
        return fail(`unknown tool: ${name}`)
    }
  } catch (e) {
    return fail(`[agent-browser-mcp] ${e?.message ?? e}`)
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[agent-browser-mcp] ready (${VERSION})\n`)
