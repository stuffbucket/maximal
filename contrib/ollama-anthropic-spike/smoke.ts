/**
 * Smoke test for OllamaWebExecutor against the live ollama.com endpoints.
 * Run with: OLLAMA_API_KEY=... bun contrib/ollama-anthropic-spike/smoke.ts
 */

import { OllamaWebExecutor } from "../../vendor/copilot-api/src/routes/messages/web-tools-executor"

const apiKey = process.env.OLLAMA_API_KEY
if (!apiKey) {
  console.error("OLLAMA_API_KEY not set")
  process.exit(1)
}

const exec = new OllamaWebExecutor({ apiKey })

const t0 = Date.now()
const search = await exec.search("claude shannon birth date", { maxResults: 3 })
const t1 = Date.now()
console.log(`[search] ${t1 - t0}ms`)
if (!search.ok) {
  console.error("  FAILED:", search.code)
  process.exit(2)
}
console.log(`  items: ${search.items.length}`)
for (const h of search.items) console.log(`    - ${h.title}\n      ${h.url}`)

// fetch from cache (one of the search results)
const cachedUrl = search.items[0]?.url
if (cachedUrl) {
  const t2 = Date.now()
  const fetched = await exec.fetch(cachedUrl, { maxChars: 2000 })
  const t3 = Date.now()
  console.log(`[fetch cached] ${t3 - t2}ms (should be <5ms)`)
  if (fetched.ok) {
    console.log(`  title: ${fetched.title}`)
    console.log(`  markdown: ${fetched.markdown.length} chars`)
  } else {
    console.error("  FAILED:", fetched.code)
  }
}

// fetch fresh URL not in cache
const t4 = Date.now()
const fresh = await exec.fetch("https://example.com/", { maxChars: 1000 })
const t5 = Date.now()
console.log(`[fetch fresh] ${t5 - t4}ms`)
if (fresh.ok) {
  console.log(`  title: ${fresh.title}`)
  console.log(`  markdown: ${fresh.markdown.length} chars`)
  console.log(`  preview: ${fresh.markdown.slice(0, 80).replaceAll("\n", " ")}`)
} else {
  console.error("  FAILED:", fresh.code)
}
