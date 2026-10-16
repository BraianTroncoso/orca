import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageHeights } from './mobile-native-chat-page-heights'
import { MobileNativeChatPageMotion } from './mobile-native-chat-page-motion'
import { coverMobileNativeChatWindow } from './mobile-native-chat-page-window-coverage'

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

type RowState = (index: number, row: NativeChatMessage) => object
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

function isElement(node: unknown): node is Element {
  return typeof Element !== 'undefined' && node instanceof Element
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
  const store = useRef({ version: 0, notify: () => {} })
  const subscribe = useCallback((notify: () => void) => {
    store.current.notify = notify
    return () => {
      store.current.notify = () => {}
    }
  }, [])
  useSyncExternalStore(subscribe, () => store.current.version)
  const render = useCallback(() => {
    store.current.version += 1
    store.current.notify()
  }, [])
  const [heights] = useState(() => new MobileNativeChatPageHeights())
  const w = useRef<Win | null>(null)
  const drawn = useRef<Drawn | null>(null)
  const settle = useRef(false)
  const anchor = useRef<{ key: string; top: number } | null>(null)
  const anchorStale = useRef(false)
  const width = useRef(0)
  const viewport = useRef(globalThis.innerHeight || 800)
  const lastScan = useRef(0)
  const rescan = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const observer = useRef<ResizeObserver | null>(null)
  const nodes = useRef(new Map<string, Element>())
  const nodeKeys = useRef(new WeakMap<Element, string>())
  const refs = useRef(new Map<string, (node: unknown) => void>())
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
    const scope = rowKeys.scope
    return { scope, first: keys[first] ?? '', firstAt: first, last: null, lastAt: n - 1, slack: 0, measure: null }
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
  let mid = 0
  for (let i = m1; i < start; i += 1) {
    mid += heights.px(keys[i]) ?? 0
  }
  let first = m0
  let above = slack
  for (let px = heights.px(keys[first - 1]); first > 0 && px !== undefined; ) {
    above += px
    first -= 1
    px = heights.px(keys[first - 1])
  }
  let bottom = 0
  for (let i = end; i < n; i += 1) {
    bottom += heights.px(keys[i]) ?? heights.estimate()
  }
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

  const takeAnchor = useCallback((s: MobileNativeChatWindowScroller) => {
    const at = drawn.current
    const view = s.getBoundingClientRect().top
    let [low, high] = [at?.start ?? 0, at?.end ?? 0]
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      const node = nodes.current.get(at!.keys[middle]!)
      if (!node || node.getBoundingClientRect().bottom <= view) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const key = at?.keys[low]
    const node = key === undefined ? undefined : nodes.current.get(key)
    anchor.current = key && node ? { key, top: node.getBoundingClientRect().top - view } : null
  }, [])

  const cover = useCallback(
    (s: MobileNativeChatWindowScroller) => {
      const [at, cur] = [drawn.current, w.current]
      const firstNode = at && nodes.current.get(at.keys[at.start] ?? '')
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
        const moved = { first: at.keys[next.start]!, firstAt: next.start, last, lastAt: next.end - 1 }
        w.current = { ...cur, ...moved, measure }
        render()
      }
    },
    [heights, render]
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
    const shape = `${at.layoutKey}:${width.current}`
    const valid = (i: number): boolean =>
      heights.valid(at.keys[i]!, at.rows[i]!, at.rowState(i, at.rows[i]!), shape)
    let [i, distance] = [at.start - 1, 0]
    for (; i >= 0 && valid(i); i -= 1) {
      distance += heights.px(at.keys[i]) ?? 0
    }
    let measure: Group | null = null
    if (i >= 0 && (at.following || distance <= MEASURE_REACH * viewport.current)) {
      let from = i
      while (from > 0 && i - from + 1 < MEASURE_ROWS && !valid(from - 1)) {
        from -= 1
      }
      measure = { from: at.keys[from]!, fromAt: from, to: at.keys[i]!, toAt: i }
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
      anchor.current = null
    }
    const last = end >= n ? null : keys[end - 1]!
    const measure = m0 < m1 ? { from: keys[m0]!, fromAt: m0, to: keys[m1 - 1]!, toAt: m1 - 1 } : null
    w.current = { ...win, first: keys[start] ?? '', firstAt: start, last, lastAt: end - 1, slack, measure }
    const sourceHead = rowKeys.sourceHead
    drawn.current = { keys, rows, indexOf, rowState, start, end, first, sourceHead, following, layoutKey }
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
    const scrolled = () => {
      if (s) {
        motion.scrolled(s.scrollTop)
        takeAnchor(s)
        cover(s)
      }
    }
    const listeners = [
      ['touchstart', () => motion.touch(true)],
      ['touchend', () => motion.touch(false)],
      ['touchcancel', () => motion.touch(false)],
      ['scroll', scrolled]
    ] as const
    listeners.forEach(([type, listener]) => s?.addEventListener(type, listener, { passive: true }))
    return () => {
      listeners.forEach(([type, listener]) => s?.removeEventListener(type, listener))
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
      const shape = `${at.layoutKey}:${width.current}`
      for (const entry of entries) {
        const key = nodeKeys.current.get(entry.target)
        const i = at.indexOf(key)
        if (key !== undefined && i !== undefined) {
          const row = at.rows[i]!
          heights.remember(key, entry.contentRect.height, row, at.rowState(i, row), shape)
        }
      }
      const held = anchor.current && nodes.current.get(anchor.current.key)
      if (!at.following && motion.settled() && anchor.current && held) {
        const view = s.getBoundingClientRect().top
        write(s, s.scrollTop + held.getBoundingClientRect().top - view - anchor.current.top)
      }
      cover(s)
      motion.poke()
    },
    [scroller, heights, motion, write, cover]
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

  const observeWith = useCallback((next: ResizeObserver | null) => {
    observer.current = next
    nodes.current.forEach((node) => next?.observe(node))
  }, [])

  const rowRef = useCallback((key: string) => {
    let ref = refs.current.get(key)
    if (!ref) {
      ref = (node: unknown) => {
        const was = nodes.current.get(key)
        if (was) {
          observer.current?.unobserve(was)
          nodes.current.delete(key)
        }
        if (isElement(node)) {
          nodes.current.set(key, node)
          nodeKeys.current.set(node, key)
          observer.current?.observe(node)
        } else {
          refs.current.delete(key)
        }
      }
      refs.current.set(key, ref)
    }
    return ref
  }, [])

  const settled = useCallback(() => motion.whenSettled(), [motion])
  const wrote = useCallback((target: number) => motion.wrote(target), [motion])

  return {
    view: { m0, m1, start, end, above, mid, bottom, measuring },
    rowRef,
    list: { afterResize, keepInPlace, observeWith, settled, wrote }
  }
}
