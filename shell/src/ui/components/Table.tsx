// vendored: thin wrappers over <table>/<thead>/<tbody>/<tr>/<th>/<td>.
import type { HTMLAttributes, ThHTMLAttributes } from "react";

export function Table(p: HTMLAttributes<HTMLTableElement>): JSX.Element {
  return <table {...p} />;
}

export function Thead(p: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <thead {...p} />;
}

export function Tbody(p: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <tbody {...p} />;
}

export function Tr(p: HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return <tr {...p} />;
}

export function Th(
  p: ThHTMLAttributes<HTMLTableCellElement> & { scope?: "col" | "row" },
): JSX.Element {
  return <th {...p} />;
}

export function Td(p: HTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <td {...p} />;
}
