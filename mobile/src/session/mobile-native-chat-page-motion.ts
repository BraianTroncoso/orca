/** No touch and no scroll of the reader's for this long: a write any sooner can stop iOS momentum. */
const REST_MS = 150
/** A scroll this soon after the reader's input is theirs; without input it is layout's (a clamp,
 *  or iOS delivering an earlier scroll after rows changed). */
const INTENT_MS = 1_000

type Listened = {
  addEventListener: (type: string, listener: () => void, options: { passive: true }) => void
  removeEventListener: (type: string, listener: () => void) => void
}

/** Whether the reader is moving the page, told apart from the page's own writes. Work that can move
 *  rows above the reader (a landing, a measured row, a correction) waits until it settles. */
export class MobileNativeChatPageMotion {
  private touching = false
  private lastReaderScroll = 0
  private lastInput = 0
  /** Where the page's own writes put the scroller, until their scroll event arrives. */
  private own: number[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private waiters: (() => void)[] = []

  constructor(private readonly onSettled: () => void) {}

  /** Follows the reader's hand on the scroller; returns the detach. */
  attach(scroller: Listened): () => void {
    const down = () => this.touch(true)
    const up = () => this.touch(false)
    const input = () => {
      this.lastInput = Date.now()
    }
    scroller.addEventListener('touchstart', down, { passive: true })
    scroller.addEventListener('touchend', up, { passive: true })
    scroller.addEventListener('touchcancel', up, { passive: true })
    scroller.addEventListener('touchmove', input, { passive: true })
    scroller.addEventListener('wheel', input, { passive: true })
    scroller.addEventListener('pointerdown', input, { passive: true })
    scroller.addEventListener('keydown', input, { passive: true })
    return () => {
      scroller.removeEventListener('touchstart', down)
      scroller.removeEventListener('touchend', up)
      scroller.removeEventListener('touchcancel', up)
      scroller.removeEventListener('touchmove', input)
      scroller.removeEventListener('wheel', input)
      scroller.removeEventListener('pointerdown', input)
      scroller.removeEventListener('keydown', input)
    }
  }

  /** The reader's hand is on the list: touching, or input within the last second. */
  intent(): boolean {
    return this.touching || Date.now() - this.lastInput <= INTENT_MS
  }

  touch(down: boolean): void {
    this.touching = down
    this.lastInput = Date.now()
    if (down) {
      this.own = []
      clearTimeout(this.timer)
      this.timer = undefined
    } else {
      this.poke()
    }
  }

  /** True for the reader's scroll; false for the event of one of the page's own writes, or of the
   *  browser clamping the scroll when the document shrank (no input of theirs, and no scroll of theirs
   *  just before, which momentum keeps up). */
  scrolled(scrollTop: number): boolean {
    const at = this.own.findIndex((target) => Math.abs(target - scrollTop) <= 1)
    if (at !== -1) {
      this.own.splice(0, at + 1)
      return false
    }
    if (!this.intent() && Date.now() - this.lastReaderScroll >= REST_MS) {
      return false
    }
    this.lastReaderScroll = Date.now()
    this.poke()
    return true
  }

  wrote(target: number): void {
    this.own = [...this.own.slice(-7), target]
  }

  settled(): boolean {
    return !this.touching && Date.now() - this.lastReaderScroll >= REST_MS
  }

  /** Resolves once settled, or when the window goes away (`release`), so a wait never strands. */
  whenSettled(): Promise<void> {
    if (this.settled()) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      this.poke()
    })
  }

  poke(): void {
    if (this.touching || this.timer !== undefined) {
      return
    }
    const wait = Math.max(0, REST_MS - (Date.now() - this.lastReaderScroll))
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.settled()) {
        this.poke()
        return
      }
      this.waiters.splice(0).forEach((resolve) => resolve())
      this.onSettled()
    }, wait)
  }

  release(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.waiters.splice(0).forEach((resolve) => resolve())
  }
}
