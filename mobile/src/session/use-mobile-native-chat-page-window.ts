import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageHeights } from './mobile-native-chat-page-heights'
import { MobileNativeChatPageMotion } from './mobile-native-chat-page-motion'
import { MobileNativeChatPageRows } from './mobile-native-chat-page-rows'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'
import { coverMobileNativeChatWindow } from './mobile-native-chat-page-window-coverage'
import { useMobileNativeChatPageRender } from './use-mobile-native-chat-page-render'

/** Rows measured in one settled moment: few enough not to drop a frame. */
const MEASURE_ROWS = 24
/** A parked reader's unmeasured rows are measured only within this many screens above them. */
const MEASURE_REACH = 3
/** Without anything else owed, rows that may have changed are checked at most this often. */
const STALE_SCAN_MS = 200

type Box = { top: number; bottom: number }
type Measured = { getBoundingClientRect: () => Box }

export type MobileNativeChatWindowScroller = Measured & {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  clientWidth: number
  addEventListener: (type: string, listener: () => void, options: { passive: true }) => void
  removeEventListener: (type: string, listener: () => void) => void
}

type RowState = (index: number, row: NativeChatMessage) => MobileNativeChatTurnRow
type Group = { from: string; fromAt: number; to: string; toAt: number }

/** Where the window stands, by key, so landings and trims never change which rows are drawn. */
type Win = {
  scope: string
  first: string
  firstAt: number
  last: string | null
  lastAt: number
  /** Measured rows trimmed from above a parked reader: their height stays until settled. */
  slack: number
  /** Rows drawn in place above the window only so they get measured. */
  measure: Group | null
}

type Drawn = {
  keys: readonly string[]
  rows: readonly NativeChatMessage[]
  indexOf: (key: string | undefined) => number | undefined
  rowState: RowState
  start: number
  end: number
  /** The first row in the document: rows above it were never measured. */
  first: number
  sourceHead: string | undefined
  following: boolean
  layoutKey: string
}

/** The page's rows near the screen, keyed. Above the window the spacer stands only for measured rows:
 *  rows never measured are left out, and are measured in place only while nothing can move the
 *  reader (following, or settled), because iOS stops momentum on any scroll write. */
export function useMobileNativeChatPageWindow(args: {
  rows: readonly NativeChatMessage[]
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'sourceHead' | 'keyOf' | 'current'>
  rowState: RowState
  following: boolean
  layoutKey: string
  scroller: () => MobileNativeChatWindowScroller | null | undefined
}) {
  const { rows, rowKeys, rowState, following, layoutKey, scroller } = args
  const render = useMobileNativeChatPageRender()
  const [heights] = useState(() => new MobileNativeChatPageHeights())
  const w = useRef<Win | null>(null)
  const drawn = useRef<Drawn | null>(null)
  const settle = useRef(false)
  const [drawnRows] = useState(() => new MobileNativeChatPageRows())
  const anchorStale = useRef(false)
  const width = useRef(0)
  const viewport = useRef(globalThis.innerHeight || 800)
  const lastScan = useRef(0)
  const rescan = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onSettled = useRef(() => {})
  const [motion] = useState(() => new MobileNativeChatPageMotion(() => onSettled.current()))
  const keys = useMemo(() => rows.map(rowKeys.keyOf), [rows, rowKeys.keyOf])
  const indexOf = useMemo(() => {
    let map: Map<string, number> | undefined
    return (key: string | undefined) =>
      key === undefined ? undefined : (map ??= new Map(keys.map((k, at) => [k, at]))).get(key)
  }, [keys])
  const n = keys.length
  const at = (key: string, fallback: number): number =>
    keys[fallback] === key
      ? fallback
      : (indexOf(rowKeys.current(key)) ?? Math.max(0, Math.min(fallback, n - 1)))
  const seatAtEnd = (): Win => {
    let first = n
    for (let filled = 0; first > 0 && filled < viewport.current; first -= 1) {
      filled += heights.px(keys[first - 1]) ?? heights.estimate()
    }
    const seat = { first: keys[first] ?? '', firstAt: first, last: null, lastAt: n - 1 }
    return { scope: rowKeys.scope, ...seat, slack: 0, measure: null }
  }

  const kept = w.current?.scope === rowKeys.scope && w.current.first !== '' ? w.current : null
  let win = kept ?? seatAtEnd()
  let end = win.last === null ? n : at(win.last, win.lastAt) + 1
  if (following && win.last !== null) {
    win = end >= n ? { ...win, last: null } : seatAtEnd()
    end = n
  }
  const start = Math.min(at(win.first, win.firstAt), Math.max(0, end - 1))
  end = Math.min(n, Math.max(end, start + 1))

  const d = drawn.current
  const sourceChanged = d !== null && d.sourceHead !== rowKeys.sourceHead
  let slack = following || !kept || settle.current ? 0 : win.slack
  if (d && sourceChanged && !following && kept && d.keys !== keys) {
    // A cap trim takes rows from the top; what was drawn of them stays as space until settled.
    for (let i = d.first; i < d.end && indexOf(rowKeys.current(d.keys[i]!)) === undefined; i += 1) {
      slack += heights.px(d.keys[i]) ?? 0
    }
  }
  // A source change keeps no measuring rows: the place-hold owns that commit's correction.
  let [m0, m1] = [start, start]
  const group = sourceChanged || !win.measure ? null : win.measure
  if (group) {
    const [from, to] = [at(group.from, group.fromAt), at(group.to, group.toAt) + 1]
    if (from < to && to <= start) {
      ;[m0, m1] = [from, to]
    }
  }
  const { first, above, mid, bottom } = heights.spacers(keys, [m0, m1], [start, end], slack)
  const measuring = n > 0 && Math.min(m0, start) > 0 && heights.px(keys[0]) === undefined

  const write = useCallback(
    (s: MobileNativeChatWindowScroller, to: number) => {
      const target = Math.max(0, Math.min(to, s.scrollHeight - s.clientHeight))
      if (Math.abs(target - s.scrollTop) >= 0.5) {
        motion.wrote(target)
        s.scrollTop = target
      }
    },
    [motion]
  )

  const takeAnchor = useCallback(
    (s: MobileNativeChatWindowScroller) => {
      const at = drawn.current
      drawnRows.takeAnchor(s, at?.keys ?? [], at?.start ?? 0, at?.end ?? 0)
    },
    [drawnRows]
  )

  const cover = useCallback(
    (s: MobileNativeChatWindowScroller) => {
      const [at, cur] = [drawn.current, w.current]
      const firstNode = at && drawnRows.node(at.keys[at.start])
      if (!at || !cur || !firstNode) {
        return
      }
      const next = coverMobileNativeChatWindow(
        {
          n: at.keys.length,
          start: at.start,
          end: at.end,
          following: at.following,
          windowTop:
            firstNode.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop,
          scrollTop: s.scrollTop,
          viewport: s.clientHeight
        },
        (i) => heights.px(at.keys[i]),
        heights.estimate()
      )
      if (next) {
        const last = next.end >= at.keys.length ? null : at.keys[next.end - 1]!
        const measure = next.start === at.start ? cur.measure : null
        const moved = { first: at.keys[next.start]!, firstAt: next.start, last }
        w.current = { ...cur, ...moved, lastAt: next.end - 1, measure }
        render()
      }
    },
    [heights, render, drawnRows]
  )

  // Owed work that can move rows above the reader, done only while settled: measure the nearest rows
  // that are unmeasured or may have changed, and give back trimmed space.
  const measureOwed = useCallback(() => {
    const [at, cur] = [drawn.current, w.current]
    if (!at || !cur || at.keys.length === 0) {
      return
    }
    const unmeasured = at.first > 0 || cur.measure !== null
    const since = Date.now() - lastScan.current
    if (!unmeasured && cur.slack === 0 && since < STALE_SCAN_MS) {
      rescan.current ??= setTimeout(() => {
        rescan.current = undefined
        motion.poke()
      }, STALE_SCAN_MS - since)
      return
    }
    lastScan.current = Date.now()
    const reach = at.following ? Infinity : MEASURE_REACH * viewport.current
    const run = heights.nearestStale(at, `${at.layoutKey}:${width.current}`, reach, MEASURE_ROWS)
    const measure: Group | null = run && {
      from: at.keys[run[0]]!,
      fromAt: run[0],
      to: at.keys[run[1]]!,
      toAt: run[1]
    }
    if (measure || cur.slack > 0 || cur.measure) {
      w.current = { ...cur, measure }
      settle.current = true
      render()
    }
  }, [heights, motion, render])

  useLayoutEffect(() => {
    onSettled.current = measureOwed
    if (w.current && w.current.scope !== rowKeys.scope) {
      heights.clear()
      motion.release()
      drawnRows.forgetAnchor()
    }
    const last = end >= n ? null : keys[end - 1]!
    const m = m0 < m1 ? { from: keys[m0]!, fromAt: m0, to: keys[m1 - 1]!, toAt: m1 - 1 } : null
    const seat = { first: keys[start] ?? '', firstAt: start, last, lastAt: end - 1 }
    w.current = { ...win, ...seat, slack, measure: m }
    const fresh = { keys, rows, indexOf, rowState, start, end, first, following, layoutKey }
    drawn.current = { ...fresh, sourceHead: rowKeys.sourceHead }
    settle.current = false
    const s = scroller()
    if (s && anchorStale.current) {
      anchorStale.current = false
      takeAnchor(s)
    }
    if (n > 0) {
      motion.poke()
    }
  })

  useLayoutEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    const scrolled = () => {
      motion.scrolled(s.scrollTop)
      takeAnchor(s)
      cover(s)
    }
    const down = () => motion.touch(true)
    const up = () => motion.touch(false)
    s.addEventListener('touchstart', down, { passive: true })
    s.addEventListener('touchend', up, { passive: true })
    s.addEventListener('touchcancel', up, { passive: true })
    s.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      s.removeEventListener('touchstart', down)
      s.removeEventListener('touchend', up)
      s.removeEventListener('touchcancel', up)
      s.removeEventListener('scroll', scrolled)
      clearTimeout(rescan.current)
      motion.release()
    }
  }, [scroller, motion, takeAnchor, cover])

  /** The one observer's entries: rows measured, then, for a settled parked reader, whatever moved the
   *  row they were reading goes back (a measured row, the header, given-back space). */
  const afterResize = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      const [s, at] = [scroller(), drawn.current]
      if (!s || !at) {
        return
      }
      viewport.current = s.clientHeight
      width.current = s.clientWidth
      const layout = `${at.layoutKey}:${width.current}`
      for (const entry of entries) {
        const key = drawnRows.keyOf(entry.target)
        const i = at.indexOf(key)
        if (key !== undefined && i !== undefined) {
          const row = at.rows[i]!
          heights.remember(key, entry.contentRect.height, row, at.rowState(i, row), layout)
        }
      }
      const drift = !at.following && motion.settled() ? drawnRows.anchorDrift(s) : null
      if (drift !== null) {
        write(s, s.scrollTop + drift)
      }
      cover(s)
      motion.poke()
    },
    [scroller, heights, motion, write, cover, drawnRows]
  )

  /** The place-hold's correction: written only while settled. Mid-motion the reader already saw the
   *  move, and putting it back at rest would be a second jump. */
  const keepInPlace = useCallback(
    (drift: number) => {
      const s = scroller()
      if (s && !drawn.current?.following && motion.settled()) {
        write(s, s.scrollTop + drift)
        anchorStale.current = true
      }
    },
    [scroller, motion, write]
  )

  // Stable, so the list's handle (and with it the one observer) is made once.
  const list = useMemo(
    () => ({
      afterResize,
      keepInPlace,
      observeWith: drawnRows.observeWith,
      settled: () => motion.whenSettled(),
      wrote: (target: number) => motion.wrote(target)
    }),
    [afterResize, keepInPlace, drawnRows, motion]
  )

  return {
    view: { m0, m1, start, end, above, mid, bottom, measuring },
    rowRef: drawnRows.ref,
    list
  }
}
