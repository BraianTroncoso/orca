import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import { WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function storeWithTerminal(worktreeId: string): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-editor-apply-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(worktreeId, TAB, LEAF)
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

function editorOpen(worktreeId: string, tabId: string, path: string) {
  return {
    type: 'openEditorTab',
    workspace: worktreeId,
    tabId,
    fileId: path,
    contentType: 'editor',
    groupId: `group-${worktreeId}`,
    preview: true,
    file: { filePath: path, relativePath: path.slice(1), language: 'typescript' }
  } as const
}

describe.each([
  ['a git worktree', FIXTURE_GIT_WORKTREE_ID],
  ['a folder workspace', FIXTURE_FOLDER_WORKTREE_ID]
])('Store.applyLayoutCommand editor tabs in %s', (_name, worktreeId) => {
  it('saves a preview open, its replacement and a close durably, leaving the terminal', async () => {
    const { store, directory } = await storeWithTerminal(worktreeId)

    await expect(store.applyLayoutCommand(editorOpen(worktreeId, 'e1', '/a.ts'))).resolves.toEqual({
      ok: true,
      result: { tabId: 'e1', refused: [] }
    })
    const reopened = await reopenTopologyStore(store, directory)
    let session = reopened.getWorkspaceSession()
    expect(session.tabGroups?.[worktreeId]?.[0]?.tabOrder).toEqual([TAB, 'e1'])
    expect(session.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === 'e1')).toMatchObject({
      entityId: '/a.ts',
      contentType: 'editor',
      isPreview: true
    })
    expect(session.openFilesByWorktree?.[worktreeId]).toEqual([
      expect.objectContaining({ filePath: '/a.ts', isPreview: true })
    ])

    await reopened.applyLayoutCommand(editorOpen(worktreeId, 'e2', '/b.ts'))
    await reopened.applyLayoutCommand({ type: 'closeTabs', workspace: worktreeId, tabIds: ['e2'] })
    session = (await reopenTopologyStore(reopened, directory)).getWorkspaceSession()
    expect(session.tabGroups?.[worktreeId]?.[0]?.tabOrder).toEqual([TAB])
    expect(session.unifiedTabs?.[worktreeId]?.map((tab) => tab.id)).toEqual([TAB])
    expect(session.openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
    expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([TAB])
  })
})
