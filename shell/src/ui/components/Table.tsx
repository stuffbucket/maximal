// vendored: thin wrappers over <table>/<thead>/<tbody>/<tr>/<th>/<td>.
import type { ReactElement, HTMLAttributes, ThHTMLAttributes } from "react"

export function Table(p: HTMLAttributes<HTMLTableElement>): ReactElement {
  return <table {...p} />
}

export function Thead(
  p: HTMLAttributes<HTMLTableSectionElement>,
): ReactElement {
  return <thead {...p} />
}

export function Tbody(
  p: HTMLAttributes<HTMLTableSectionElement>,
): ReactElement {
  return <tbody {...p} />
}

export function Tr(p: HTMLAttributes<HTMLTableRowElement>): ReactElement {
  return <tr {...p} />
}

export function Th(
  p: ThHTMLAttributes<HTMLTableCellElement> & { scope?: "col" | "row" },
): ReactElement {
  return <th {...p} />
}

export function Td(p: HTMLAttributes<HTMLTableCellElement>): ReactElement {
  return <td {...p} />
}
