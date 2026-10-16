import { spawnProcess } from '@orca/process-host'
import { describe, expect, it, vi } from 'vitest'
import { readAgentProcess } from '../../shared/agent-process-presence-probe'
import type { LinuxStatEvidence } from '../daemon/daemon-incarnation-evidence-types'
import { killAndAwaitExit, waitForProcessExit } from './orcad-daemon-teardown-fixture'

const ZOMBIE_PARENT = `
import os, select, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
try:
    print(pid, flush=True)
    select.select([sys.stdin], [], [], 25)
finally:
    os.waitpid(pid, 0)
`

describe('daemon teardown exit proof', () => {
  it.skipIf(process.platform !== 'linux')(
    'accepts an unreaped zombie while its owned parent remains alive, then reaps it',
    async () => {
      const parent = spawnProcess({
        program: process.env.PYTHON || 'python3',
        args: ['-c', ZOMBIE_PARENT],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: null
      })
      let stdout = ''
      let stderr = ''
      parent.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      parent.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const closed = new Promise<number | null>((resolve, reject) => {
        parent.once('error', reject)
        parent.once('close', resolve)
      })
      let zombiePid = 0
      try {
        await vi.waitFor(
          async () => {
            zombiePid = Number(stdout.trim())
            expect(Number.isSafeInteger(zombiePid) && zombiePid > 0).toBe(true)
            expect(await readAgentProcess(zombiePid)).toMatchObject({
              verdict: 'live',
              zombie: true
            })
          },
          { timeout: 5_000, interval: 25 }
        )
        expect(() => process.kill(zombiePid, 0)).not.toThrow()
        await waitForProcessExit([zombiePid])
        await killAndAwaitExit([zombiePid])
        expect(parent.exitCode).toBeNull()
        expect(() => process.kill(zombiePid, 0)).not.toThrow()
        expect(await readAgentProcess(zombiePid)).toMatchObject({ verdict: 'live', zombie: true })
      } finally {
        // EOF releases waitpid even when an assertion fails; never orphan the zombie.
        parent.stdin.end()
        expect(await closed).toBe(0)
        expect(stderr).toBe('')
        if (zombiePid > 0) {
          expect(() => process.kill(zombiePid, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' })
          )
        }
      }
    },
    20_000
  )

  it('still rejects a live process at the unchanged ten-second deadline', async () => {
    vi.useFakeTimers()
    try {
      const rejected = expect(waitForProcessExit([process.pid])).rejects.toThrow(
        `Processes did not exit: ${process.pid}`
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  const zombieStat = `42 (daemon) Z ${Array(18).fill('0').join(' ')} 100`
  it.each<[string, LinuxStatEvidence]>([
    ['missing proc entry after occupied signal', { status: 'missing' }],
    ['unavailable proc entry', { status: 'unavailable' }],
    ['truncated zombie entry', { status: 'present', value: '42 (daemon) Z' }],
    ['malformed start ticks', { status: 'present', value: zombieStat.replace(/100$/, 'bad') }],
    ['different pid', { status: 'present', value: zombieStat.replace(/^42/, '43') }],
    ['live proc entry', { status: 'present', value: zombieStat.replace(') Z', ') S') }]
  ])('does not accept %s as exit proof', async (_name, stat) => {
    vi.useFakeTimers()
    try {
      const rejected = expect(
        waitForProcessExit([42], {
          platform: 'linux',
          signalProcess: () => {},
          readStat: async () => stat
        })
      ).rejects.toThrow('Processes did not exit: 42')
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stalled proc read without treating timeout as exit', async () => {
    vi.useFakeTimers()
    try {
      const rejected = expect(
        waitForProcessExit([42], {
          platform: 'linux',
          signalProcess: () => {},
          readStat: () => new Promise(() => {})
        })
      ).rejects.toThrow('Processes did not exit: 42')
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['EPERM', 'EACCES'])(
    'keeps signal %s pending without accepting proc evidence',
    async (code) => {
      vi.useFakeTimers()
      const readStat = vi.fn(async (): Promise<LinuxStatEvidence> => ({
        status: 'present',
        value: zombieStat
      }))
      try {
        const rejected = expect(
          waitForProcessExit([42], {
            platform: 'linux',
            signalProcess: () => {
              throw Object.assign(new Error(code), { code })
            },
            readStat
          })
        ).rejects.toThrow('Processes did not exit: 42')
        await vi.advanceTimersByTimeAsync(10_000)
        await rejected
        expect(readStat).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('preserves ESRCH exit proof without requiring proc evidence', async () => {
    const readStat = vi.fn()
    await waitForProcessExit([42], {
      platform: 'linux',
      signalProcess: () => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      },
      readStat
    })
    expect(readStat).not.toHaveBeenCalled()
  })

  it.each<NodeJS.Platform>(['darwin', 'win32'])(
    'keeps occupied %s processes pending',
    async (platform) => {
      vi.useFakeTimers()
      const readStat = vi.fn(async (): Promise<LinuxStatEvidence> => ({
        status: 'present',
        value: zombieStat
      }))
      try {
        const rejected = expect(
          waitForProcessExit([42], { platform, signalProcess: () => {}, readStat })
        ).rejects.toThrow('Processes did not exit: 42')
        await vi.advanceTimersByTimeAsync(10_000)
        await rejected
        expect(readStat).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
