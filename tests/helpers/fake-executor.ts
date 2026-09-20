import type {
  Executor,
  FetchResult,
  SearchResult,
} from "~/routes/messages/web-tools/executor"

/** Test fake for the web-tools `Executor` surface. Records every call
 *  and returns deterministic shapes useful for assertion. */
export class FakeExecutor implements Executor {
  searchCalls: Array<string> = []
  fetchCalls: Array<string> = []
  /** When set, `search`/`fetch` wait this long before resolving. Lets tests
   *  hold the tool-execution gap open to observe keepalive pings. */
  delayMs = 0

  async search(query: string): Promise<SearchResult> {
    this.searchCalls.push(query)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    return {
      ok: true,
      items: [
        { url: "https://example.com/a", title: "A", page_age: null },
        { url: "https://example.com/b", title: "B", page_age: null },
      ],
    }
  }

  async fetch(url: string): Promise<FetchResult> {
    this.fetchCalls.push(url)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    return { ok: true, markdown: `body of ${url}` }
  }
}
