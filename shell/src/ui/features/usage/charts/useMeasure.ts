import { useEffect, useRef, useState } from "react"

/**
 * Measure an element's content width with a ResizeObserver, degrading to a fixed
 * fallback where the observer is unavailable (the happy-dom test runner). The
 * SVG charts are responsive to width and take a fixed height, so width is all we
 * need. Returns a ref to attach and the current measured width.
 */
export function useMeasure(
  fallbackWidth = 640,
): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallbackWidth)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    // No ResizeObserver (tests / very old runtimes): keep the fallback width.
    if (typeof ResizeObserver === "undefined") {
      const measured = node.clientWidth
      if (measured > 0) setWidth(measured)
      return
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = entry.contentRect.width
        if (next > 0) setWidth(next)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
