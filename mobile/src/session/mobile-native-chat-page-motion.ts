/** No touch and no scroll of the reader's for this long: a write any sooner can stop iOS momentum. */
const REST_MS = 150
type Listened = {
  addEventListener: (type: string, listener: () => void, options: { passive: true }) => void
  removeEventListener: (type: string, listener: () => void) => void
}

/** Whether the reader is moving the page, told apart from the page's own writes. Work that can move
 *  rows above the reader (a landing, a measured row, a correction) waits until it settles. */
export class MobileNativeChatPageMotion {
  private touching = false
  private lastReaderScroll = 0
  /** Where the page last accounted for the scroll: its write, an observed scroll, a resize. */
  private seen = 0
  /** A commit changed what is drawn and its resize callback hasn't run: a move now is layout's. */
  private unreconciled = false
  private drawn = ''
  private layouts = 0
  /** Where the page's own writes put the scroller, until their scroll event arrives. */
  private own: number[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private waiters: (() => void)[] = []

  constructor(private readonly onSettled: () => void) {}

  /** Follows the reader's hand on the scroller; returns the detach. */
  attach(scroller: Listened): () => void {
    const down = () => this.touch(true)
    const up = () => this.touch(false)
    scroller.addEventListener('touchstart', down, { passive: true })
    scroller.addEventListener('touchend', up, { passive: true })
    scroller.addEventListener('touchcancel', up, { passive: true })
    return () => {
      scroller.removeEventListener('touchstart', down)
      scroller.removeEventListener('touchend', up)
      scroller.removeEventListener('touchcancel', up)
    }
  }

  touch(down: boolean): void {
    this.touching = down
    if (down) {
      this.own = []
      clearTimeout(this.timer)
      this.timer = undefined
    } else {
      this.poke()
    }
  }

  /** A commit drew `drawn`. When that changed, a move is layout's until its resize callback (or the
   *  next frame, when nothing resized); scroll events run before that frame's resize callbacks. */
  laidOut(drawn: string): void {
    if (drawn === this.drawn) {
      return
    }
    this.drawn = drawn
    this.unreconciled = true
    const token = ++this.layouts
    globalThis.requestAnimationFrame?.(() => {
      if (token === this.layouts) {
        this.unreconciled = false
      }
    })
  }

  reconciled(scrollTop: number): void {
    this.unreconciled = false
    this.seen = scrollTop
  }

  /** What moved the scroll to `scrollTop` since the page last accounted for it, and by how much. Not
   *  the reader when the page's write, an unreconciled commit, rows above the reading place
   *  (`placeMoved`) or a clamp to a shorter end explains it; a finger on the list makes it theirs. */
  scrolled(
    scrollTop: number,
    max: number,
    placeMoved: () => boolean
  ): { by: 'own' | 'layout' | 'reader' | 'none'; moved: number } {
    const [from, moved] = [this.seen, scrollTop - this.seen]
    this.seen = scrollTop
    const at = this.own.findIndex((target) => Math.abs(target - scrollTop) <= 1)
    if (at !== -1) {
      this.own.splice(0, at + 1)
      return { by: 'own', moved }
    }
    if (Math.abs(moved) < 0.5) {
      return { by: 'none', moved }
    }
    const clamped = scrollTop >= max - 0.5 && from > max
    if (!this.touching && (this.unreconciled || clamped || placeMoved())) {
      return { by: 'layout', moved }
    }
    this.lastReaderScroll = Date.now()
    this.poke()
    return { by: 'reader', moved }
  }

  wrote(target: number): void {
    this.own = [...this.own.slice(-7), target]
    this.seen = target
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
