// vendored: thin wrappers over <table>/<thead>/<tbody>/<tr>/<th>/<td>.
// The root bakes in the `.table` class (defined in styles.css) so callers
// get the shared styling without repeating `className="table"`; extra
// classes compose via cx().
import type { ReactElement, HTMLAttributes, ThHTMLAttributes } from "react"

import { cx } from "./cx"

export function Table({
  className,
  ...rest
}: HTMLAttributes<HTMLTableElement>): ReactElement {
  return <table className={cx("table", className)} {...rest} />
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
