/**
 * Reading JSON files a person may have edited. Notepad and Windows
 * PowerShell 5 (`Set-Content -Encoding utf8`) save UTF-8 with a byte order
 * mark, which `JSON.parse` rejects as an unexpected token.
 */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.replace(/^\ufeff/u, ""))
}
