import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

const FIRST_ESTIMATE = 80

type Entry = { px: number; row: NativeChatMessage; state: object; layout: string }

function sameState(a: object, b: object): boolean {
  const before = Object.entries(a)
  const after = new Map(Object.entries(b))
  return before.length === after.size && before.every(([name, value]) => after.get(name) === value)
}

/** Row heights as drawn. One holds while the row would draw the same: the same row object (unchanged
 *  rows keep theirs across a re-fold), the same row state and the same layout. A stale one keeps
 *  standing in for its row until it is measured again, so going stale never moves anything. */
export class MobileNativeChatPageHeights {
  private entries = new Map<string, Entry>()
  private sum = 0

  px(key: string | undefined): number | undefined {
    return key === undefined ? undefined : this.entries.get(key)?.px
  }

  /** For rows never drawn, which only ever sit below the reader. */
  estimate(): number {
    return this.entries.size > 0 ? this.sum / this.entries.size : FIRST_ESTIMATE
  }

  valid(key: string, row: NativeChatMessage, state: object, layout: string): boolean {
    const entry = this.entries.get(key)
    return (
      entry !== undefined &&
      entry.row === row &&
      entry.layout === layout &&
      sameState(entry.state, state)
    )
  }

  remember(key: string, px: number, row: NativeChatMessage, state: object, layout: string): void {
    this.sum += px - (this.entries.get(key)?.px ?? 0)
    this.entries.set(key, { px, row, state, layout })
  }

  clear(): void {
    this.entries.clear()
    this.sum = 0
  }
}
