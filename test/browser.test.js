import { test } from "node:test"
import assert from "node:assert/strict"
import {
  looksLikeChallenge,
  domainAllowed,
  findBrowserExecutable,
  loadPolicy,
  CHALLENGE_MARKERS,
} from "../src/browser.js"

test("защитный экран Cloudflare распознаётся", () => {
  const page = `<html><head><title>Just a moment...</title></head><body>
    <div class="cf-browser-verification">Checking your browser before accessing</div>
    <script>window._cf_chl_opt={}</script></body></html>`
  assert.equal(looksLikeChallenge(page), true)
})

test("обычная страница не считается защитой", () => {
  assert.equal(looksLikeChallenge("<html><body>Привет, мир</body></html>"), false)
  assert.equal(looksLikeChallenge(""), false)
  assert.equal(looksLikeChallenge(null), false)
})

test("капчи распознаются по маркерам", () => {
  for (const marker of CHALLENGE_MARKERS) {
    assert.equal(looksLikeChallenge(`<div>${marker}</div>`), true, `маркер ${marker}`)
  }
})

test("allowlist: точный домен, поддомены, wildcard", () => {
  assert.equal(domainAllowed("https://example.com/x", ["example.com"]), true)
  assert.equal(domainAllowed("https://api.example.com/x", ["example.com"]), true)
  assert.equal(domainAllowed("https://sub.example.com/x", ["*.example.com"]), true)
  assert.equal(domainAllowed("https://evil.com/x", ["example.com"]), false)
  assert.equal(domainAllowed("https://notexample.com/x", ["example.com"]), false)
  assert.equal(domainAllowed("https://example.com/x", []), false)
  assert.equal(domainAllowed("не url", ["example.com"]), false)
})

test("политика читается из окружения и имеет безопасные значения по умолчанию", () => {
  const p = loadPolicy({})
  assert.deepEqual(p.allowlist, [])
  assert.equal(p.maxSolverCallsPerHour, 5)
  assert.equal(p.headless, true)
  assert.equal(p.solverKey, "")
  assert.equal(p.flaresolverrUrl, "")
})

test("политика читает allowlist и бюджет из окружения", () => {
  const p = loadPolicy({
    AGENT_BROWSER_ALLOWLIST: "a.com, *.b.com ,",
    AGENT_BROWSER_SOLVER_BUDGET: "3",
    AGENT_BROWSER_HEADLESS: "false",
  })
  assert.deepEqual(p.allowlist, ["a.com", "*.b.com"])
  assert.equal(p.maxSolverCallsPerHour, 3)
  assert.equal(p.headless, false)
})

test("браузер ищется среди установленных", () => {
  const exe = findBrowserExecutable()
  assert.ok(exe === null || typeof exe === "string")
  if (exe) assert.ok(exe.includes("Brave") || exe.includes("Chrome") || exe.includes("Chromium") || exe.includes("Edge"))
})
