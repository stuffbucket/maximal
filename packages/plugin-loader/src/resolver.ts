import { PluginInventoryError } from "./errors"
import {
  MAX_EXPANDED_PLUGINS,
  MAX_GROUP_DEPTH,
  MAX_GROUP_GRAPH_WORK,
  type InventoryDocumentSource,
  type InventoryMember,
  type PluginCatalog,
  type PluginCompatibility,
  type PluginDefinition,
  type PluginDescriptor,
  type PluginGroupDefinition,
  type PluginInstallation,
  type ResolvedPlugin,
  type ResolvedPluginInventory,
} from "./types"

interface Located<T> {
  readonly value: T
  readonly source: string
}
// eslint-disable-next-line max-params
function duplicate(
  kind: "group" | "plugin",
  id: string,
  source: string,
  previous: string,
): never {
  throw new PluginInventoryError(
    kind === "plugin" ? "duplicate-plugin" : "duplicate-group",
    `${kind} ${JSON.stringify(id)} is defined in both ${previous} and ${source}.`,
    { source, member: id },
  )
}
function catalogMap<T extends { readonly id: string }>(
  values: ReadonlyArray<T>,
  kind: "descriptor" | "installation",
): ReadonlyMap<string, T> {
  const result = new Map<string, T>()
  for (const value of values) {
    if (result.has(value.id))
      throw new PluginInventoryError(
        kind === "descriptor" ?
          "duplicate-descriptor"
        : "duplicate-installation",
        `Trusted catalog has duplicate ${kind} ${JSON.stringify(value.id)}.`,
        { member: value.id },
      )
    result.set(value.id, value)
  }
  return result
}
function cloneCompatibility(
  value: PluginCompatibility | undefined,
): PluginCompatibility | undefined {
  if (value === undefined) return undefined
  return Object.freeze({
    ...(value.maximal === undefined ? {} : { maximal: value.maximal }),
    ...(value.pluginApi === undefined ? {} : { pluginApi: value.pluginApi }),
    ...(value.runtime === undefined ? {} : { runtime: value.runtime }),
    ...(value.platforms === undefined ?
      {}
    : { platforms: Object.freeze([...value.platforms]) }),
    ...(value.architectures === undefined ?
      {}
    : { architectures: Object.freeze([...value.architectures]) }),
  })
}
function cloneDescriptor(value: PluginDescriptor): PluginDescriptor {
  const common = {
    id: value.id,
    module: Object.freeze({
      moduleId: value.module.moduleId,
      ...(value.module.export === undefined ?
        {}
      : { export: value.module.export }),
    }),
    ...(value.compatibility === undefined ?
      {}
    : { compatibility: cloneCompatibility(value.compatibility) }),
    ...(value.services === undefined ?
      {}
    : {
        services: Object.freeze({
          ...(value.services.provides === undefined ?
            {}
          : { provides: Object.freeze([...value.services.provides]) }),
          ...(value.services.requires === undefined ?
            {}
          : { requires: Object.freeze([...value.services.requires]) }),
        }),
      }),
  }
  return value.provenance === "built-in" ?
      Object.freeze({ ...common, provenance: "built-in" })
    : Object.freeze({ ...common, provenance: "external" })
}
function cloneInstallation(value: PluginInstallation): PluginInstallation {
  return Object.freeze({
    id: value.id,
    descriptorId: value.descriptorId,
    package: Object.freeze({
      name: value.package.name,
      ...(value.package.version === undefined ?
        {}
      : { version: value.package.version }),
      location: value.package.location,
    }),
  })
}
function orderedSources(
  entry: string,
  documents: ReadonlyMap<string, InventoryDocumentSource>,
): ReadonlyArray<string> {
  const done = new Set<string>()
  const active: Array<string> = []
  const ordered: Array<string> = []
  const visit = (source: string): void => {
    const at = active.indexOf(source)
    if (at !== -1) {
      const cycle = Object.freeze([...active.slice(at), source])
      throw new PluginInventoryError(
        "include-cycle",
        `Inventory include cycle: ${cycle.join(" -> ")}.`,
        { source, cycle },
      )
    }
    if (done.has(source)) return
    const item = documents.get(source)
    if (item === undefined)
      throw new PluginInventoryError(
        "missing-include",
        `Missing opened include ${JSON.stringify(source)}.`,
        { source },
      )
    if ((item.document.includes?.length ?? 0) !== item.includeSources.length)
      throw new PluginInventoryError(
        "invalid-document",
        `${source}: opened include identities do not match include references.`,
        { source, path: "includes" },
      )
    active.push(source)
    for (const include of item.includeSources) visit(include)
    active.pop()
    done.add(source)
    ordered.push(source)
  }
  visit(entry)
  return ordered
}

/** Resolve already-opened canonical documents against a host-owned executable catalog. */
// eslint-disable-next-line complexity, max-lines-per-function
export function resolvePluginInventory(options: {
  readonly entry: string
  readonly documents: ReadonlyArray<InventoryDocumentSource>
  readonly catalog: PluginCatalog
}): ResolvedPluginInventory {
  const documentMap = new Map(
    options.documents.map((item) => [item.source, item] as const),
  )
  if (documentMap.size !== options.documents.length)
    throw new PluginInventoryError(
      "invalid-document",
      "Document canonical identities must be unique.",
    )
  const sources = orderedSources(options.entry, documentMap)
  const plugins = new Map<string, Located<PluginDefinition>>()
  const groups = new Map<string, Located<PluginGroupDefinition>>()
  for (const source of sources) {
    const document = documentMap.get(source)?.document
    if (document === undefined) continue
    for (const value of document.plugins ?? []) {
      const old = plugins.get(value.id)
      if (old !== undefined) duplicate("plugin", value.id, source, old.source)
      plugins.set(value.id, { value, source })
    }
    for (const value of document.groups ?? []) {
      const old = groups.get(value.id)
      if (old !== undefined) duplicate("group", value.id, source, old.source)
      groups.set(value.id, { value, source })
    }
  }
  const descriptors = catalogMap(
    options.catalog.descriptors.map((value) => cloneDescriptor(value)),
    "descriptor",
  )
  const installations = catalogMap(
    options.catalog.installations.map((value) => cloneInstallation(value)),
    "installation",
  )
  for (const plugin of plugins.values()) {
    const descriptor = descriptors.get(plugin.value.descriptorId)
    if (descriptor === undefined)
      throw new PluginInventoryError(
        "missing-descriptor",
        `Plugin ${plugin.value.id} references an unapproved descriptor.`,
        { source: plugin.source, member: plugin.value.descriptorId },
      )
    if (descriptor.provenance === "built-in") {
      if (plugin.value.installationId !== undefined)
        throw new PluginInventoryError(
          "provenance-mismatch",
          `Built-in plugin ${plugin.value.id} cannot select an installation.`,
          { source: plugin.source, member: plugin.value.installationId },
        )
      continue
    }
    if (plugin.value.installationId === undefined)
      throw new PluginInventoryError(
        "provenance-mismatch",
        `External plugin ${plugin.value.id} must select an installation.`,
        { source: plugin.source, member: plugin.value.descriptorId },
      )
    const installation = installations.get(plugin.value.installationId)
    if (installation === undefined)
      throw new PluginInventoryError(
        "missing-installation",
        `Plugin ${plugin.value.id} references an unapproved installation.`,
        { source: plugin.source, member: plugin.value.installationId },
      )
    if (installation.descriptorId !== descriptor.id)
      throw new PluginInventoryError(
        "installation-mismatch",
        `Plugin ${plugin.value.id} cannot pair descriptor ${descriptor.id} with installation ${installation.id}.`,
        { source: plugin.source, member: installation.id },
      )
  }

  let groupWork = 0
  const groupMemo = new Map<string, ReadonlyArray<string>>()
  const activeGroups: Array<string> = []
  const activeGroupSet = new Set<string>()
  const chargeGroupWork = (source: string): void => {
    groupWork += 1
    if (groupWork > MAX_GROUP_GRAPH_WORK)
      throw new PluginInventoryError(
        "group-work-limit",
        `Group graph exceeds ${MAX_GROUP_GRAPH_WORK} nodes and edges.`,
        { source },
      )
  }
  const expandGroup = (
    groupId: string,
    source: string,
  ): ReadonlyArray<string> => {
    const cached = groupMemo.get(groupId)
    if (cached !== undefined) return cached
    const group = groups.get(groupId)
    if (group === undefined)
      throw new PluginInventoryError(
        "missing-member",
        `${source}: missing group ${groupId}.`,
        { source, member: groupId },
      )
    if (activeGroupSet.has(groupId)) {
      const at = activeGroups.indexOf(groupId)
      const cycle = Object.freeze([...activeGroups.slice(at), groupId])
      throw new PluginInventoryError(
        "group-cycle",
        `Plugin group cycle: ${cycle.join(" -> ")}.`,
        { source: group.source, member: groupId, cycle },
      )
    }
    if (activeGroups.length >= MAX_GROUP_DEPTH)
      throw new PluginInventoryError(
        "group-depth-limit",
        `Group graph exceeds depth ${MAX_GROUP_DEPTH}.`,
        { source: group.source, member: groupId },
      )
    chargeGroupWork(group.source)
    activeGroups.push(groupId)
    activeGroupSet.add(groupId)
    const result: Array<string> = []
    try {
      for (const child of group.value.members) {
        chargeGroupWork(group.source)
        if ("plugin" in child) {
          if (!plugins.has(child.plugin))
            throw new PluginInventoryError(
              "missing-member",
              `${group.source}: missing plugin ${child.plugin}.`,
              { source: group.source, member: child.plugin },
            )
          if (result.length >= MAX_EXPANDED_PLUGINS)
            throw new PluginInventoryError(
              "expansion-limit",
              `Inventory expansion exceeds ${MAX_EXPANDED_PLUGINS} leaves.`,
              { source: group.source },
            )
          result.push(child.plugin)
          continue
        }
        const childResult = expandGroup(child.group, group.source)
        if (result.length + childResult.length > MAX_EXPANDED_PLUGINS)
          throw new PluginInventoryError(
            "expansion-limit",
            `Inventory expansion exceeds ${MAX_EXPANDED_PLUGINS} leaves.`,
            { source: group.source },
          )
        for (const pluginId of childResult) result.push(pluginId)
      }
    } finally {
      activeGroups.pop()
      activeGroupSet.delete(groupId)
    }
    const frozen = Object.freeze(result)
    groupMemo.set(groupId, frozen)
    return frozen
  }
  for (const [groupId, located] of groups) expandGroup(groupId, located.source)

  let expanded = 0
  const expandMember = (
    member: InventoryMember,
    source: string,
  ): ReadonlyArray<string> => {
    let result: ReadonlyArray<string>
    if ("plugin" in member) {
      if (!plugins.has(member.plugin))
        throw new PluginInventoryError(
          "missing-member",
          `${source}: missing plugin ${member.plugin}.`,
          { source, member: member.plugin },
        )
      result = [member.plugin]
    } else result = expandGroup(member.group, source)
    expanded += result.length
    if (expanded > MAX_EXPANDED_PLUGINS)
      throw new PluginInventoryError(
        "expansion-limit",
        `Inventory expansion exceeds ${MAX_EXPANDED_PLUGINS} leaves.`,
        { source },
      )
    return result
  }
  const selected: Array<string> = []
  for (const source of sources) {
    const document = documentMap.get(source)?.document
    if (document === undefined) continue
    const roots =
      document.members
      ?? (document.plugins ?? []).map((value) => ({ plugin: value.id }))
    for (const root of roots)
      for (const pluginId of expandMember(root, source)) selected.push(pluginId)
  }
  expanded = 0
  const disabled = new Set<string>()
  for (const source of sources)
    for (const root of documentMap.get(source)?.document.disabled ?? [])
      for (const pluginId of expandMember(root, source)) disabled.add(pluginId)

  const seen = new Set<string>()
  const modules = new Map<string, string>()
  const result: Array<ResolvedPlugin> = []
  for (const id of selected) {
    if (seen.has(id) || disabled.has(id)) continue
    const plugin = plugins.get(id)
    if (plugin === undefined) continue
    const descriptor = descriptors.get(plugin.value.descriptorId)
    if (descriptor === undefined) continue
    const previous = modules.get(descriptor.module.moduleId)
    if (previous !== undefined)
      throw new PluginInventoryError(
        "duplicate-module",
        `Plugins ${previous} and ${id} resolve to singleton module ${descriptor.module.moduleId}.`,
        { source: plugin.source, member: descriptor.module.moduleId },
      )
    seen.add(id)
    modules.set(descriptor.module.moduleId, id)
    const common = {
      id: plugin.value.id,
      descriptorId: plugin.value.descriptorId,
      definedIn: plugin.source,
    }
    if (descriptor.provenance === "built-in")
      result.push(
        Object.freeze({
          ...common,
          provenance: "built-in",
          descriptor,
        }),
      )
    else {
      const installationId = plugin.value.installationId
      const installation =
        installationId === undefined ? undefined : (
          installations.get(installationId)
        )
      if (installationId !== undefined && installation !== undefined)
        result.push(
          Object.freeze({
            ...common,
            provenance: "external",
            installationId,
            descriptor,
            installation,
          }),
        )
    }
  }
  return Object.freeze({
    plugins: Object.freeze(result),
    sources: Object.freeze(sources),
  })
}
