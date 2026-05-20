import { Checkbox } from "../../ui/Checkbox";
import { Td } from "../../ui/Table";
import { cx } from "../../ui/cx";

interface SelectCellProps {
  /** Whether the Select column is currently visible. */
  selectMode: boolean;
  /**
   * Whether THIS row supports selection. Wildcard and the blank
   * new-row pass `false` so the cell renders empty instead of a
   * disabled-but-visible checkbox (which historically read as
   * "selected by default" to users).
   */
  selectable: boolean;
  /** Selection state of this row. Ignored when `selectable === false`. */
  selected?: boolean;
  /** Toggle callback. Required when `selectable === true`. */
  onToggle?: (next: boolean) => void;
  /** Accessible label for the checkbox when selectable. */
  ariaLabel?: string;
}

/**
 * The single source of truth for the API-clients table's leading
 * "Select" column. Three row types (Wildcard, Key, NewKey) all render
 * a cell here; without this primitive each had a copy of the same
 * className composition + visibility logic, which is what made bug 1
 * possible in the first place (wildcard had a disabled checkbox,
 * users had an invisible one — opposite of the intent).
 *
 * Rules:
 *  - `selectMode === false` → cell exists but has `display: none`
 *    (toggle is class-driven so the table grid doesn't reflow).
 *  - `selectMode === true, selectable === false` → cell is rendered
 *    empty. Semantic signal: "this row cannot be selected." No
 *    disabled checkbox.
 *  - `selectMode === true, selectable === true` → checkbox.
 */
export function SelectCell({
  selectMode,
  selectable,
  selected,
  onToggle,
  ariaLabel,
}: SelectCellProps): JSX.Element {
  return (
    <Td
      className={cx(
        "api-keys__select-col",
        !selectMode && "api-keys__select-col--hidden",
      )}
    >
      {selectable && onToggle ? (
        <Checkbox
          checked={selected ?? false}
          onCheckedChange={onToggle}
          aria-label={ariaLabel}
        />
      ) : null}
    </Td>
  );
}
