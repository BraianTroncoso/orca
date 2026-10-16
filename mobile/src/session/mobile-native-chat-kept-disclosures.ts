import { createContext, useCallback, useContext, useState } from 'react'

/** Show more on a tool run: what the reader asked for, and the lines older calls added above. */
export type MobileNativeChatReveal = { requested: number; before: number; first?: string }

/** What the reader opened in one chat, by disclosure key. Plain maps: only the row that owns a key
 *  writes it, and it re-renders from its own state. */
export type MobileNativeChatKept = {
  open: Map<string, boolean>
  reveal: Map<string, MobileNativeChatReveal>
}

/** Provided where rows unmount once scrolled past (the phone page's window); elsewhere rows keep
 *  their own state as before. */
export const MobileNativeChatKeptContext = createContext<MobileNativeChatKept | null>(null)

/** Bounded: a chat read for a day shouldn't carry every disclosure it ever opened. */
const MAX_KEPT = 512

export function newMobileNativeChatKept(): MobileNativeChatKept {
  return { open: new Map(), reveal: new Map() }
}

/** A row's own disclosure state that outlives the row: under windowing a row unmounts once it is
 *  scrolled past, and a reset would silently close what the reader opened (and change its height). */
export function useMobileNativeChatKept<T>(
  pick: (kept: MobileNativeChatKept) => Map<string, T>,
  key: string | undefined,
  initial: T
): [T, (next: (current: T) => T) => void] {
  const kept = useContext(MobileNativeChatKeptContext)
  const map = kept && key !== undefined ? pick(kept) : undefined
  const [value, setValue] = useState<T>(() =>
    key === undefined ? initial : (map?.get(key) ?? initial)
  )
  const set = useCallback(
    (next: (current: T) => T) =>
      setValue((current) => {
        const updated = next(current)
        if (map && key !== undefined) {
          map.delete(key)
          map.set(key, updated)
          const oldest = map.size > MAX_KEPT ? map.keys().next().value : undefined
          if (oldest !== undefined) {
            map.delete(oldest)
          }
        }
        return updated
      }),
    [map, key]
  )
  return [value, set]
}
