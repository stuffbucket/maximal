import { Component, type ErrorInfo, type ReactNode } from "react"

interface ErrorBoundaryProps {
  /** Rendered in place of the subtree when a descendant throws. */
  fallback: ReactNode
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Catches render/lifecycle errors in its subtree and shows `fallback`
 * instead of letting React unmount the whole root to an empty node.
 *
 * Without a boundary, a single throw inside an island — e.g. reading a
 * diagnostics field the running sidecar (an older version) never sent —
 * crashes the entire React root to a blank `<div>`. The user perceives
 * that as the content flickering in and then vanishing, with no error
 * anywhere they can see. A boundary turns that silent blank into a
 * visible, recoverable message.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("island render error:", error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}
