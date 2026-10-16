// Opening editor, browser and agent-session tabs: the tab and its content record in one apply.

import type { EditorTabView } from '../editor-tab-view-types'
import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import { admitsInitialSurface } from './workspace-layout-initial-surface'
import type { LayoutContentTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { placeContentTab } from './workspace-layout-tab-commands'

function contentTab(
  context: LayoutContext,
  fields: Pick<LayoutContentTab, 'kind' | 'entityId'> & Partial<LayoutContentTab>
): LayoutContentTab {
  return {
    id: context.mintId(),
    createdAt: context.now(),
    customTitle: null,
    color: null,
    ...fields
  }
}

/** An open tab for the same file is returned instead of a second one. */
export function openEditorTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openEditorTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  const existing = model.workspaces[key]?.tabs.find(
    (tab) => tab.entityId === command.fileId && tab.kind === command.contentType
  )
  if (existing) {
    return applied(withEditorView(model, key, existing.id, command.view), { tabId: existing.id })
  }
  const tab = contentTab(context, {
    kind: command.contentType,
    entityId: command.fileId,
    ...(command.preview ? { isPreview: true } : {})
  })
  const placed = placeContentTab(model, key, tab, command, context)
  let next = placed.model
  const file = command.file
  if (file) {
    const workspace = next.workspaces[key]!
    const files = (workspace.editorFiles ?? []).filter((entry) => entry.filePath !== file.filePath)
    next = withWorkspace(next, key, { ...workspace, editorFiles: [...files, file] })
  }
  return applied(withEditorView(next, key, tab.id, command.view), {
    tabId: tab.id,
    refused: placed.refused
  })
}

function withEditorView(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string,
  view: EditorTabView | undefined
): WorkspaceLayoutModel {
  if (!view) {
    return model
  }
  const workspace = model.workspaces[key]!
  return withWorkspace(model, key, {
    ...workspace,
    editorViews: { ...workspace.editorViews, [tabId]: view }
  })
}

export function openBrowserTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openBrowserTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  // A host's tab is named by its page; a window names its tab-bar entry and record itself.
  const browserTabId = command.browserTabId ?? command.pageId ?? context.mintId()
  const tabId = command.tabId ?? browserTabId
  const pageId = command.pageId ?? context.mintId()
  // Only a window's open names its record; a host's is checked against its saved pages first.
  const taken = command.browserTabId
    ? takenBrowserTabIds(model, key, { tabId, browserTabId, pageId })
    : null
  if (taken) {
    return taken
  }
  const tab = contentTab(context, {
    kind: 'browser',
    id: tabId,
    entityId: browserTabId
  })
  const next = placeContentTab(model, key, tab, command, context).model
  const workspace = next.workspaces[key]!
  const browserTab = {
    id: browserTabId,
    sessionProfileId: command.profileId ?? null,
    ...(command.sessionPartition ? { sessionPartition: command.sessionPartition } : {}),
    pageIds: [pageId],
    createdAt: tab.createdAt
  }
  return applied(
    withWorkspace(next, key, {
      ...workspace,
      browserTabs: [...(workspace.browserTabs ?? []), browserTab]
    }),
    { tabId: tab.id, pageId }
  )
}

/**
 * The same open again (a window's create resent) changes nothing; an id another tab or page holds
 * refuses it. Null when every id is free.
 */
function takenBrowserTabIds(
  model: WorkspaceLayoutModel,
  key: string,
  ids: { tabId: string; browserTabId: string; pageId: string }
): Applied | null {
  const own = model.workspaces[key]
  const record = own?.browserTabs?.find((entry) => entry.id === ids.browserTabId)
  if (
    record?.pageIds?.includes(ids.pageId) &&
    own?.tabs.some((tab) => tab.id === ids.tabId && tab.entityId === ids.browserTabId)
  ) {
    return applied(model, { tabId: ids.tabId, pageId: ids.pageId })
  }
  const workspaces = Object.values(model.workspaces)
  if (
    workspaces.some((workspace) =>
      workspace.tabs.some((tab) =>
        [tab.id, tab.entityId].some((id) => id === ids.tabId || id === ids.browserTabId)
      )
    )
  ) {
    return refuse('tab_exists')
  }
  return holdsBrowserPage(model, ids.pageId) ? refuse('page_exists') : null
}

export function holdsBrowserPage(model: WorkspaceLayoutModel, pageId: string): boolean {
  return Object.values(model.workspaces).some((workspace) =>
    workspace.browserTabs?.some((entry) => entry.pageIds?.includes(pageId))
  )
}

export function openAgentSessionTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openAgentSessionTab'>,
  context: LayoutContext
): Applied {
  if (command.initial && !admitsInitialSurface(model, command.workspace, command.initial)) {
    return applied(model)
  }
  const tab = contentTab(context, {
    ...(command.tabId ? { id: command.tabId } : {}),
    kind: 'agent-session',
    entityId: command.sessionId,
    agentSessionAgent: command.agent
  })
  return applied(placeContentTab(model, command.workspace, tab, command, context).model, {
    tabId: tab.id
  })
}
