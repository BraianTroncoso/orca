import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  assertInlineImagePixels,
  assertKittyPlaceholderPixels,
  enableInlineImages,
  inlineImagePayload
} from './helpers/terminal-inline-image-proof'
import { getFirstWslDistro, useWslRuntimeForActiveProject } from './helpers/wsl-golden-stub-agent'
import { nodeTerminalCommand } from './terminal-node-command'
import { proveWindowsKittyFileImage } from './helpers/terminal-kitty-file-image-proof'

test.skip(process.platform !== 'win32', 'Native Windows and WSL PTY coverage')

for (const runtime of ['native', 'wsl'] as const) {
  for (const acceleration of ['off', 'on'] as const) {
    test(`@headful ${runtime}, ${acceleration}: PTY images and Kitty placeholders render on Windows`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await orcaPage.evaluate(async (policy) => {
        await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
      }, acceleration)
      if (runtime === 'wsl') {
        const distro = await getFirstWslDistro(orcaPage)
        expect(distro, 'This Windows verification requires an installed WSL distro').not.toBeNull()
        if (!distro) {
          throw new Error('No WSL distro available')
        }
        await useWslRuntimeForActiveProject(orcaPage, distro)
      } else {
        await orcaPage.evaluate(async () => {
          await window
            .__store!.getState()
            .updateSettings({ terminalWindowsShell: 'powershell.exe' })
        })
      }
      const tabId = await orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        const worktreeId = state.activeWorktreeId
        if (!worktreeId) {
          throw new Error('Missing verification worktree')
        }
        const tab = state.createTab(worktreeId)
        window.__store!.getState().setActiveTab(tab.id)
        window.__store!.getState().setActiveTabType('terminal', worktreeId)
        return tab.id
      })
      await expect(
        orcaPage.locator(`[data-tab-id="${tabId}"] [data-shell-icon]`).first()
      ).toHaveAttribute('data-shell-icon', runtime === 'wsl' ? 'wsl.exe' : 'powershell.exe')
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await enableInlineImages(orcaPage)
      await expect
        .poll(() =>
          orcaPage.evaluate(() => {
            const tab = window.__store!.getState().activeTabId
            const manager = tab && window.__paneManagers?.get(tab)
            const pane = manager && manager.getActivePane()
            return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
          })
        )
        .toBe(acceleration === 'on')
      const ptyId = await waitForActivePanePtyId(orcaPage)
      const marker = 'WINDOWS_INLINE_IMAGES_DONE'
      const rawPayload = `${inlineImagePayload(true)}${marker}\r\n`
      const payload = Buffer.from(rawPayload).toString('base64')
      // Why a file: this command is typed at PTY bind, before WSL bash reaches readline; a
      // ~25 KB line in the kernel's cooked mode loses everything past 4095 bytes.
      const payloadFile = `.orca-inline-images-${randomUUID()}.bin`
      if (runtime === 'wsl') {
        writeFileSync(path.join(testRepoPath, payloadFile), rawPayload)
      }
      const command =
        runtime === 'wsl'
          ? `cat ${payloadFile}; rm -f ${payloadFile}; printf 'WSL_IMAGE_PROTOCOL=%s\\n' "$ORCA_IMAGE_PROTOCOL"`
          : nodeTerminalCommand(['-e', `process.stdout.write(Buffer.from('${payload}', 'base64'))`])
      await execInTerminal(orcaPage, ptyId, command)
      await waitForTerminalOutput(orcaPage, marker, 30_000)
      if (runtime === 'wsl') {
        await waitForTerminalOutput(orcaPage, 'WSL_IMAGE_PROTOCOL=kitty', 30_000)
      }
      try {
        await assertInlineImagePixels(orcaPage, testInfo.outputPath('windows-inline-protocols.png'))
      } catch (error) {
        const dump = await orcaPage.evaluate(() => {
          const tab = window.__store!.getState().activeTabId
          const manager = tab ? window.__paneManagers?.get(tab) : undefined
          const term = manager?.getActivePane()?.terminal as any
          const core = term._core
          const addon = term._addonManager._addons.map((a: any) => a.instance).find((a: any) => a._storage)
          const storage = addon._storage
          const renderer = storage._renderer
          const layers = [...renderer._layers.entries()].map(([k, ctx]: any) => ({ k, w: ctx.canvas.width, h: ctx.canvas.height, cssW: ctx.canvas.style.width, inDom: ctx.canvas.isConnected }))
          const images = [...storage._images.entries()].map(([id, sp]: any) => ({ id, tiles: sp.tileCount, origW: sp.orig?.width, origH: sp.orig?.height, actW: sp.actual?.width, actH: sp.actual?.height, origCell: sp.origCellSize, actCell: sp.actualCellSize, layer: sp.layer, buf: sp.bufferType }))
          const buffer = core.buffer
          const rowsWithTiles: string[] = []
          for (let row = 0; row < term.rows; row++) {
            const line = buffer.lines.get(row + buffer.ydisp)
            if (!line) { rowsWithTiles.push(`${row}:noline`); continue }
            const ids: string[] = []
            for (let col = 0; col < term.cols; col++) {
              const e = line.getExtended(col)?.payload
              if (e && e.imageId !== undefined && e.imageId !== -1) ids.push(`${e.imageId}/${e.tileId}`)
            }
            if (ids.length) rowsWithTiles.push(`${row}:${ids[0]}..${ids[ids.length - 1]}(${ids.length})`)
          }
          const dims = core._renderService.dimensions
          const countBlue = () => {
            const ctx = renderer._layers.get('top')
            if (!ctx) return -1
            const d = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data
            let n = 0
            for (let p = 0; p < d.length; p += 4) if (d[p + 2] > 220 && d[p] < 60 && d[p + 1] < 60 && d[p + 3] > 200) n++
            return n
          }
          const before = countBlue()
          term.refresh(0, term.rows - 1)
          return { cols: term.cols, rows: term.rows, ydisp: buffer.ydisp, ybase: buffer.ybase, cell: dims.css.cell, canvas: dims.css.canvas, cellSize: renderer.cellSize, layers, images, rowsWithTiles, blueLayerPixelsBefore: before, fullyCleared: storage._fullyCleared, needsFullClear: storage._needsFullClear, renderer: core._renderService._renderer?.value?.constructor?.name, paused: core._renderService._isPaused }
        })
        console.log('REPAINT_DIAG', JSON.stringify(dump))
        await new Promise((r) => setTimeout(r, 500))
        await orcaPage.screenshot({ path: testInfo.outputPath('windows-inline-after-refresh.png') })
        throw error
      }
      await assertKittyPlaceholderPixels(
        orcaPage,
        testInfo.outputPath('windows-inline-placeholders.png')
      )
      await proveWindowsKittyFileImage(
        orcaPage,
        ptyId,
        runtime,
        testInfo.outputPath('windows-file-placeholders.png')
      )
    })
  }
}
