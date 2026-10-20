/**
 * agent-browser-mcp — ядро: браузерная сессия и обход защитных экранов.
 *
 * Логика простая и честная:
 *   1. открываем страницу в настоящем браузере (Playwright + установленный Brave/Chromium);
 *   2. проверяем, не встретил ли нас защитный экран (Cloudflare, капча);
 *   3. если встретили — пробуем локальный FlareSolverr, потом платного решателя
 *      (только для доменов из allowlist), иначе просто ждём, пока JS-челленджей
 *      разрешится сам;
 *   4. возвращаем страницу и честно говорим, каким путём она получена.
 *
 * Чего здесь нет: обхода paywall и авторизации, массового обхода чужих WAF.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** Признаки защитного экрана. */
export const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "cf-browser-verification",
  "cf_chl_opt",
  "__cf_chl",
  "challenge-platform",
  "attention required! | cloudflare",
  "enable javascript and cookies to continue",
  "ddos protection by",
  "px-captcha",
  "g-recaptcha",
  "grecaptcha",
  "hcaptcha",
  "cf-turnstile",
  "just a moment...",
]

/** Похоже, что страница отдаёт вызов защиты. */
export function looksLikeChallenge(content) {
  const text = String(content ?? "").toLowerCase()
  if (!text) return false
  return CHALLENGE_MARKERS.some((m) => text.includes(m))
}

/** Домен разрешён для платного решателя? */
export function domainAllowed(url, allowlist) {
  if (!allowlist || allowlist.length === 0) return false
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowlist.some((d) => {
    const rule = String(d).trim().toLowerCase()
    if (!rule) return false
    if (rule.startsWith("*.")) return host.endsWith(rule.slice(1))
    return host === rule || host.endsWith("." + rule)
  })
}

/** Браузер, который можно использовать без загрузки chromium. */
export function findBrowserExecutable() {
  const candidates = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]
  for (const p of candidates) if (existsSync(p)) return p
  // playwright-core скачанные браузеры
  const cache = join(homedir(), "Library/Caches/ms-playwright")
  if (existsSync(cache)) {
    const { readdirSync } = require("node:fs")
    for (const dir of readdirSync(cache)) {
      for (const rel of [
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/headless_shell",
      ]) {
        const p = join(cache, dir, rel)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

/** Политика: сколько тратить и на каких доменах. */
export function loadPolicy(env = process.env) {
  const allowlist = (env.FREE_WEB_ALLOWLIST ?? env.AGENT_BROWSER_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    allowlist,
    maxSolverCallsPerHour: Number(env.AGENT_BROWSER_SOLVER_BUDGET ?? "5"),
    challengeWaitMs: Number(env.AGENT_BROWSER_CHALLENGE_WAIT ?? "12000"),
    solverKey: env.CAPSOLVER_KEY ?? env.AGENT_BROWSER_SOLVER_KEY ?? "",
    flaresolverrUrl: env.FLARESOLVERR_URL ?? "",
    headless: env.AGENT_BROWSER_HEADLESS !== "false",
    userAgent:
      env.AGENT_BROWSER_UA ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    locale: env.AGENT_BROWSER_LOCALE ?? "en-US",
    executablePath: env.AGENT_BROWSER_PATH ?? findBrowserExecutable(),
  }
}

/** FlareSolverr: локальный решатель Cloudflare-челленджей. */
export async function flareSolverr(url, { endpoint, timeoutMs = 60000 } = {}) {
  const base = String(endpoint).replace(/\/$/, "")
  const res = await fetch(`${base}/v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout: timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36" },
    }),
    signal: AbortSignal.timeout(timeoutMs + 10000),
  })
  if (!res.ok) throw new Error(`flaresolverr: HTTP ${res.status}`)
  const json = await res.json()
  if (json.status !== "ok") throw new Error(`flaresolverr: ${json.message ?? json.status}`)
  return { status: json.solution?.status ?? 200, body: json.solution?.response ?? "", cookies: json.solution?.cookies ?? [] }
}

/** CapSolver: платный решатель (нужен ключ и разрешённый домен). */
export async function capSolver(url, { key, type = "turnstile" } = {}) {
  const create = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey: key, task: { type, websiteURL: url } }),
  })
  const task = await create.json()
  if (task.errorId) throw new Error(`capsolver: ${task.errorDescription ?? task.errorCode}`)
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const poll = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: key, taskId: task.taskId }),
    })
    const res = await poll.json()
    if (res.errorId) throw new Error(`capsolver: ${res.errorDescription ?? res.errorCode}`)
    if (res.data?.solution) {
      return {
        token: res.data.solution.token ?? res.data.solution.gRecaptchaResponse ?? "",
        type: res.data.solution.type,
      }
    }
  }
  throw new Error("capsolver: таймаут ожидания решения")
}

/** Браузерная сессия: один браузер, много вкладок, переиспользование cookies. */
export class BrowserSession {
  constructor(options = {}) {
    this.policy = { ...loadPolicy(), ...(options.policy ?? {}) }
    this.options = options
    this.browser = null
    this.context = null
    this.page = null
    this.solverCalls = []
    this.spentThisHour = 0
    this.hourStarted = Date.now()
  }

  /** Поднять браузер (лениво — при первом действии). */
  async start() {
    if (this.browser) return
    const { chromium } = await import("playwright-core")
    const launchOptions = {
      headless: this.policy.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    }
    if (this.policy.executablePath) launchOptions.executablePath = this.policy.executablePath
    this.browser = await chromium.launch(launchOptions)
    this.context = await this.browser.newContext({
      userAgent: this.policy.userAgent,
      locale: this.policy.locale,
      viewport: { width: 1440, height: 900 },
      timezoneId: "Europe/Moscow",
      extraHTTPHeaders: { "accept-language": `${this.policy.locale},en;q=0.9` },
    })
    // прячем самый заметный признак автоматизации
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined })
    })
    this.page = await this.context.newPage()
  }

  async close() {
    try {
      await this.context?.close()
      await this.browser?.close()
    } catch {
      /* уже закрыт */
    }
    this.browser = null
    this.context = null
    this.page = null
  }

  /** Можно ли сейчас тратить на платного решателя. */
  canSpend() {
    if (Date.now() - this.hourStarted > 3600_000) {
      this.hourStarted = Date.now()
      this.solverCalls = []
    }
    return this.solverCalls.length < this.policy.maxSolverCallsPerHour
  }

  noteSolverCall(kind) {
    this.solverCalls.push({ kind, at: Date.now() })
  }

  /**
   * Открыть страницу и разобраться с защитой.
   * Возвращает { url, title, via, challenged, text }.
   */
  async navigate(url, { timeoutMs = 30000 } = {}) {
    await this.start()
    if (!/^https?:\/\//i.test(url)) throw new Error("a full http(s) URL is required")

    const response = await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    })
    await this.page.waitForTimeout(600)

    let body = await this.safeBody()
    if (!looksLikeChallenge(body)) {
      return { ...(await this.describe(response)), via: "direct", challenged: false }
    }

    // 1) локальный FlareSolverr
    if (this.policy.flaresolverrUrl) {
      try {
        const solved = await flareSolverr(url, { endpoint: this.policy.flaresolverrUrl })
        if (solved.cookies?.length) {
          await this.context.addCookies(
            solved.cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || "/",
              httpOnly: c.httpOnly ?? false,
              secure: c.secure ?? true,
              sameSite: c.sameSite ?? "Lax",
            })),
          )
        }
        await this.page.reload({ waitUntil: "domcontentloaded" })
        await this.page.waitForTimeout(600)
        body = await this.safeBody()
        if (!looksLikeChallenge(body)) {
          return { ...(await this.describe(response)), via: "flaresolverr", challenged: false }
        }
      } catch (e) {
        return { ...(await this.describe(response)), via: "blocked", challenged: true, error: `flaresolverr: ${e.message}` }
      }
    }

    // 2) платный решатель — только для разрешённых доменов и в пределах бюджета
    if (this.policy.solverKey && domainAllowed(url, this.policy.allowlist) && this.canSpend()) {
      try {
        const solved = await capSolver(url, { key: this.policy.solverKey })
        this.noteSolverCall("capsolver")
        if (solved.token) {
          await this.page.evaluate((token) => {
            const el = document.querySelector('input[name="cf-turnstile-response"]')
            if (el) {
              el.value = token
              el.dispatchEvent(new Event("change", { bubbles: true }))
            }
          }, solved.token)
          await this.page.waitForTimeout(2500)
          await this.page.reload({ waitUntil: "domcontentloaded" })
          body = await this.safeBody()
          if (!looksLikeChallenge(body)) {
            return { ...(await this.describe(response)), via: "capsolver", challenged: false }
          }
        }
      } catch (e) {
        return { ...(await this.describe(response)), via: "blocked", challenged: true, error: `capsolver: ${e.message}` }
      }
    }

    // 3) просто ждём: JS-челленджей в настоящем браузере решается сам
    const deadline = Date.now() + this.policy.challengeWaitMs
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1500)
      body = await this.safeBody()
      if (!looksLikeChallenge(body)) {
        return { ...(await this.describe(response)), via: "waited", challenged: false }
      }
    }
    return { ...(await this.describe(response)), via: "blocked", challenged: true }
  }

  async safeBody() {
    try {
      return (await this.page.content()) ?? ""
    } catch {
      return ""
    }
  }

  async describe(response) {
    const title = await this.page.title().catch(() => "")
    return {
      url: this.page.url(),
      title,
      status: response?.status() ?? null,
    }
  }

  /** Текст страницы (для агента). */
  async text({ maxChars = 20000, selector = "body" } = {}) {
    await this.start()
    const raw = await this.page
      .locator(selector)
      .first()
      .innerText()
      .catch(() => "")
    return raw.replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars)
  }

  /** Ссылки страницы с текстом. */
  async links({ max = 50 } = {}) {
    await this.start()
    return this.page
      .evaluate((limit) => {
        const out = []
        const seen = new Set()
        for (const a of [...document.querySelectorAll("a[href]")]) {
          const text = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim()
          const href = a.href
          if (!href || !text || text.length < 3) continue
          if (seen.has(href)) continue
          seen.add(href)
          out.push({ url: href, text: text.slice(0, 160) })
          if (out.length >= limit) break
        }
        return out
      }, max)
  }

  /** Клик по селектору. */
  async click(selector, { timeoutMs = 15000 } = {}) {
    await this.start()
    await this.page.click(selector, { timeout: timeoutMs })
    await this.page.waitForTimeout(400)
    return this.describe(null)
  }

  /** Ввод текста. */
  async type(selector, text, { timeoutMs = 15000, submit = false } = {}) {
    await this.start()
    await this.page.fill(selector, text, { timeout: timeoutMs })
    if (submit) await this.page.press(selector, "Enter")
    return this.describe(null)
  }

  /** Скриншот (в файл или base64). */
  async screenshot({ path, fullPage = false } = {}) {
    await this.start()
    if (path) {
      await this.page.screenshot({ path, fullPage })
      return { path }
    }
    const buffer = await this.page.screenshot({ fullPage })
    return { base64: buffer.toString("base64") }
  }

  /** Дождаться появления элемента. */
  async waitFor(selector, { timeoutMs = 20000 } = {}) {
    await this.start()
    await this.page.waitForSelector(selector, { timeout: timeoutMs })
    return this.describe(null)
  }
}
