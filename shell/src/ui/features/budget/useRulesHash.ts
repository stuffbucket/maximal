import { useCallback, useEffect, useState } from "react";

import { type RulesHash, parseRulesHash } from "./modelRules";

/**
 * What the Rules window's address asks of it: `#rules/model/<id>` (from the
 * Models list) filters the rules to those that apply to that model. It follows
 * the address, so following such a link while Rules is open, or the back button,
 * changes the list; `clear` goes back to plain `#rules`.
 */
export function useRulesHash(): RulesHash & { clear: () => void } {
  const [hash, setHash] = useState<RulesHash>(() => parseRulesHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setHash(parseRulesHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    // A section is mounted before its link is followed; read what is there now.
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const clear = useCallback(() => {
    // A hashchange the window's router also sees, so the address bar and history stay honest.
    window.location.hash = "rules";
  }, []);

  return { ...hash, clear };
}
