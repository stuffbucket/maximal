import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { fetchPiCatalog } from "~/apps/pi/catalog"
import { syncPiModels } from "~/apps/pi/sync"
import { resolveBudgetDisplay } from "~/lib/budget/units"
import { getConfig } from "~/lib/config/config"

const { values } = parseArgs({
  options: {
    write: { type: "boolean", default: false },
    file: { type: "string" },
    "account-type": { type: "string", default: "individual" },
  },
})
const filePath = values.file ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "models.json")
const catalog = await fetchPiCatalog(values["account-type"])
const result = await syncPiModels({
  filePath,
  catalog: catalog.data,
  write: values.write,
  creditUsd: resolveBudgetDisplay(getConfig().budget).creditUsd,
})
console.log(`${result.models.length} chat models, ${result.models.filter(model => model.cost).length} with Copilot prices`)
console.log(`Added: ${result.added.join(", ") || "none"}`)
console.log(`Removed: ${result.removed.join(", ") || "none"}`)
if (result.written) {
  console.log(`Updated ${filePath}`)
  console.log(`Backup: ${result.backup}`)
} else if (result.changed) {
  console.log("Preview only. Pass --write to update the existing Maximal provider.")
} else {
  console.log("Already current.")
}
