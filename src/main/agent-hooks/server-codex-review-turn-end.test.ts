import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

// Captured from a completed Codex CLI 0.159.0 /review; session and turn IDs were replaced.
const reviewRecords = readFileSync(
  new URL('./__fixtures__/codex-review-child-0159.jsonl', import.meta.url),
  'utf8'
)
  .trimEnd()
  .split('\n')

describe('Codex review turn completion', () => {
  let server: AgentHookServer | undefined
  let directory: string | undefined

  afterEach(() => {
    server?.stop()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('settles the main agent from the review child rollout without Stop and leaves a newer turn working', async () => {
    directory = mkdtempSync(join(tmpdir(), 'codex-review-turn-'))
    const childPath = join(directory, 'review-child.jsonl')
    writeFileSync(childPath, `${reviewRecords[0]}\n`)
    server = new AgentHookServer()
    const published: (string | undefined)[] = []
    server.setListener((status) => published.push(status.hookEventName))
    await server.start({ env: 'production' })

    // Real review hooks carry the root session ID and child turn/path, with no agent_id or Stop.
    for (const hookEventName of [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PreToolUse',
      'PostToolUse'
    ] as const) {
      const response = await postHookEvent(
        server,
        buildBody({
          hook_event_name: hookEventName,
          session_id: 'root-session',
          transcript_path: childPath,
          turn_id: 'child-turn',
          ...(hookEventName === 'UserPromptSubmit' ? { prompt: 'Review current changes' } : {}),
          ...(hookEventName === 'UserPromptSubmit' ? {} : { tool_name: 'Bash' })
        }),
        '/hook/codex'
      )
      expect(response.status).toBe(204)
    }
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'working' },
      providerSession: { id: 'root-session', transcriptPath: childPath }
    })

    appendFileSync(childPath, `${reviewRecords[1]}\n`)
    await vi.waitFor(
      () => {
        expect(server?.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done' }
        })
      },
      { timeout: 3_000 }
    )
    // Desktops that predate host-owned turn verdicts still recognize a labelled Stop.
    expect(published.at(-1)).toBe('Stop')

    // A newer turn in the same rollout must not be settled by the review's recorded end.
    appendFileSync(
      childPath,
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"next-turn"}}\n'
    )
    const next = await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'root-session',
        transcript_path: childPath,
        turn_id: 'next-turn',
        prompt: 'Next task'
      }),
      '/hook/codex'
    )
    expect(next.status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'working' }
    })
  })

  it.each([
    ['in an earlier poll', true],
    ['in the same poll', false]
  ])('settles a failed turn without Stop after a child finished %s', async (_, separatePolls) => {
    directory = mkdtempSync(join(tmpdir(), 'codex-failed-turn-'))
    const day = join(directory, '2026', '10', '16')
    mkdirSync(day, { recursive: true })
    const rootPath = join(day, 'rollout-2026-10-16T00-00-00-root.jsonl')
    const childId = '0199aaaa-bbbb-cccc-dddd-eeeeffff0001'
    const childPath = join(day, `rollout-2026-10-16T00-00-01-${childId}.jsonl`)
    const event = (payload: object): string => `${JSON.stringify({ type: 'event_msg', payload })}\n`
    writeFileSync(rootPath, event({ type: 'task_started', turn_id: 'root-turn' }))
    server = new AgentHookServer()
    const published: (string | undefined)[] = []
    server.setListener((status) => published.push(status.hookEventName))
    await server.start({ env: 'production' })
    const hook = (hookEventName: string, extra: Record<string, unknown> = {}) =>
      postHookEvent(
        server!,
        buildBody({
          hook_event_name: hookEventName,
          session_id: 'root-session',
          transcript_path: rootPath,
          turn_id: 'root-turn',
          ...extra
        }),
        '/hook/codex'
      )

    expect((await hook('UserPromptSubmit', { prompt: 'Do the task' })).status).toBe(204)
    appendFileSync(
      rootPath,
      event({
        type: 'sub_agent_activity',
        agent_thread_id: childId,
        kind: 'started',
        occurred_at_ms: Date.now()
      })
    )
    writeFileSync(childPath, event({ type: 'task_started', turn_id: 'child-turn' }))
    expect((await hook('PostToolUse', { tool_name: 'spawn_agent' })).status).toBe(204)

    appendFileSync(childPath, event({ type: 'task_complete', turn_id: 'child-turn' }))
    if (separatePolls) {
      await new Promise((resolve) => setTimeout(resolve, 1_200))
    }
    appendFileSync(
      rootPath,
      event({ type: 'task_complete', turn_id: 'root-turn', error: { message: 'usage limit' } })
    )
    await vi.waitFor(
      () => {
        expect(server?.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000 }
    )
    // Desktops derive a labelled Stop's outcome as success, so a failure goes out unlabelled.
    expect(published.at(-1)).toBeUndefined()
  })
})
