import type { ReactElement } from 'react'

// Tiny local icon set for the dashboard's "on this page" nav. Not exported
// from ../workspace/Workspace.tsx (they're module-private there), and small
// enough that duplicating the couple of lines of shared SVG props is
// cheaper than reaching into a module this feature must not edit.

interface IconProps {
  size?: number
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
  }
}

export function TotalsIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 12.5V8M8 12.5V3.5M13 12.5V6" />
    </svg>
  )
}

export function ProjectsIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 4.2a1 1 0 0 1 1-1h2.7l1.3 1.6H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
    </svg>
  )
}

export function FinishedIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="m5.5 8.2 1.8 1.8 3.2-3.7" />
    </svg>
  )
}
