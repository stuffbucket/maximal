import { useEffect, useState } from "react"

/**
 * Track the user's `prefers-reduced-motion` setting reactively. Reduced motion
 * is a literal contract (design principle 5): components use this to turn OFF
 * pulses/tweens entirely, not merely soften them. Defaults to `false` where
 * `matchMedia` is unavailable (the test runner).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const mq = matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  return reduced
}
