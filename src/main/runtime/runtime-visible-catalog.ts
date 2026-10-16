/**
 * The projects a client may list: the same rows the desktop sidebar shows. A converted SSH host's
 * source rows and a WSL host's moved rows stay in the store for a downgrade, but the server that
 * now owns them lists them. Internal callers (routing, selectors, migration) keep the full store.
 */
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  visibleFolderWorkspaces,
  visibleProjectGroups,
  visibleRepos
} from '../ssh/orcad-retained-source'
import type { RuntimeStore } from './runtime-store-contract'

type CatalogSource = Pick<
  RuntimeStore,
  'getRepos' | 'getProjectGroups' | 'getFolderWorkspaces' | 'getSshTargets'
>

// Headless orcad has no SSH targets, so nothing of its own is ever a retained source.
function catalogStore(store: CatalogSource) {
  return {
    getRepos: () => store.getRepos(),
    getProjectGroups: () => store.getProjectGroups?.() ?? [],
    getFolderWorkspaces: () => store.getFolderWorkspaces?.() ?? [],
    getSshTargets: () => store.getSshTargets?.() ?? []
  }
}

export function runtimeVisibleRepos(store: CatalogSource | null): Repo[] {
  return store ? visibleRepos(catalogStore(store)) : []
}

export function runtimeVisibleProjectGroups(store: CatalogSource | null): ProjectGroup[] {
  return store ? visibleProjectGroups(catalogStore(store)) : []
}

export function runtimeVisibleFolderWorkspaces(store: CatalogSource | null): FolderWorkspace[] {
  return store ? visibleFolderWorkspaces(catalogStore(store)) : []
}

/** Repo rows clients must not see, by (repo id, host): the same id often lives on another host. */
export type RuntimeHiddenRepos = {
  readonly size: number
  has(repoId: string, hostId: string | null | undefined): boolean
}

const NO_HIDDEN_REPOS: RuntimeHiddenRepos = { size: 0, has: () => false }

function repoHostKey(repoId: string, hostId: string): string {
  return `${hostId}\0${repoId}`
}

/**
 * Empty in the common case of nothing hidden. A row without a host is this machine's, as a repo
 * row with no host fields is; a WSL move hides the local row while the host's same-id row stays.
 */
export function runtimeHiddenRepos(store: CatalogSource | null): RuntimeHiddenRepos {
  if (!store) {
    return NO_HIDDEN_REPOS
  }
  const all = store.getRepos()
  const visible = runtimeVisibleRepos(store)
  if (visible.length === all.length) {
    return NO_HIDDEN_REPOS
  }
  const keyOf = (repo: Repo): string => repoHostKey(repo.id, getRepoExecutionHostId(repo))
  const visibleKeys = new Set(visible.map(keyOf))
  const hidden = new Set(all.map(keyOf).filter((key) => !visibleKeys.has(key)))
  return {
    size: hidden.size,
    has: (repoId, hostId) => hidden.has(repoHostKey(repoId, hostId || LOCAL_EXECUTION_HOST_ID))
  }
}

function folderHostId(folder: FolderWorkspace): ExecutionHostId | null {
  if (folder.executionHostId) {
    return folder.executionHostId
  }
  return folder.connectionId ? toSshExecutionHostId(folder.connectionId) : null
}

/**
 * Hosts known only through hidden rows. A client listing must not name them as "not covered":
 * that would send a user or agent to list a host whose rows are hidden on purpose.
 */
export function runtimeHiddenHostIds(store: CatalogSource | null): ReadonlySet<ExecutionHostId> {
  const hiddenRepos = runtimeHiddenRepos(store)
  if (!store) {
    return new Set()
  }
  const folders = store.getFolderWorkspaces?.() ?? []
  const visibleFolders = runtimeVisibleFolderWorkspaces(store)
  if (hiddenRepos.size === 0 && visibleFolders.length === folders.length) {
    return new Set()
  }
  const visibleFolderIds = new Set(visibleFolders.map((folder) => folder.id))
  const hidden = new Set<ExecutionHostId>()
  const shown = new Set<ExecutionHostId>()
  const note = (hostId: ExecutionHostId | null, isHidden: boolean): void => {
    if (hostId && isHidden) {
      hidden.add(hostId)
    } else if (hostId) {
      shown.add(hostId)
    }
  }
  for (const repo of store.getRepos()) {
    const hostId = getRepoExecutionHostId(repo)
    note(hostId, hiddenRepos.has(repo.id, hostId))
  }
  for (const folder of folders) {
    note(folderHostId(folder), !visibleFolderIds.has(folder.id))
  }
  // This machine always stays listed, even if a WSL move took every local project.
  return new Set(
    [...hidden].filter((hostId) => !shown.has(hostId) && hostId !== LOCAL_EXECUTION_HOST_ID)
  )
}

export function withoutHiddenHosts(
  hostIds: Iterable<ExecutionHostId>,
  hidden: ReadonlySet<ExecutionHostId>
): ExecutionHostId[] {
  return [...hostIds].filter((hostId) => !hidden.has(hostId))
}
