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

  search(query: string): Promise<SearchResult> {
    this.searchCalls.push(query)
    return Promise.resolve({
      ok: true,
      items: [
        { url: "https://example.com/a", title: "A", page_age: null },
        { url: "https://example.com/b", title: "B", page_age: null },
      ],
    })
  }

  fetch(url: string): Promise<FetchResult> {
    this.fetchCalls.push(url)
    return Promise.resolve({ ok: true, markdown: `body of ${url}` })
  }
}
