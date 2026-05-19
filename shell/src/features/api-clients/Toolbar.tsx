import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";

export interface ToolbarProps {
  selectMode: boolean;
  selectedCount: number;
  onSelectModeChange: (next: boolean) => void;
  onDeleteRequest: () => void;
}

/**
 * Bottom-right toolbar inside the .data-table chrome. Always shows
 * the "Select keys" switch; surfaces a destructive "Delete (n)"
 * button to the LEFT of the switch when select mode is on AND ≥1
 * row is selected. The actual confirmation modal lives in the
 * parent — this component only fires `onDeleteRequest`.
 */
export function Toolbar({
  selectMode,
  selectedCount,
  onSelectModeChange,
  onDeleteRequest,
}: ToolbarProps): JSX.Element {
  return (
    <div className="data-table__toolbar">
      {selectMode && selectedCount > 0 && (
        <Button
          variant="destructive"
          size="sm"
          className="api-keys__delete-btn"
          onClick={onDeleteRequest}
        >
          Delete ({selectedCount})
        </Button>
      )}
      <Switch
        checked={selectMode}
        onCheckedChange={onSelectModeChange}
        label="Select keys"
      />
    </div>
  );
}
