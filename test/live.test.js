// Живой тест: настоящий браузер. Запускается только с LIVE=1.
//   LIVE=1 npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { BrowserSession } from "../src/browser.js"

const LIVE = process.env.LIVE === "1"
const skip = LIVE ? false : "set LIVE=1 to run the browser test"

test("браузер открывает страницу, читает текст и собирает ссылки", { skip }, async () => {
  const s = new BrowserSession()
  try {
    const r = await s.navigate("https://example.com/", { timeoutMs: 30000 })
    assert.equal(r.challenged, false)
    assert.equal(r.status, 200)
    assert.ok(r.title.length > 0)
    const text = await s.text({ maxChars: 500 })
    assert.ok(text.length > 0)
    const links = await s.links({ max: 5 })
    assert.ok(Array.isArray(links))
  } finally {
    await s.close()
  }
})

test("защитный экран: страница-заглушка распознаётся как вызов", { skip }, async () => {
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    res.writeHead(403, { "content-type": "text/html" })
    res.end("<html><head><title>Just a moment...</title></head><body><div class='cf-browser-verification'>Checking your browser</div></body></html>")
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${server.address().port}/`
  const s = new BrowserSession()
  try {
    const r = await s.navigate(url, { timeoutMs: 15000 })
    assert.equal(r.challenged, true)
    assert.equal(r.via, "blocked")
  } finally {
    await s.close()
    server.close()
  }
})
