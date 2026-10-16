/** No touch and no scroll of the reader's for this long: a write any sooner can stop iOS momentum. */
const REST_MS = 150

/** Whether the reader is moving the page, told apart from the page's own writes. Work that can move
 *  rows above the reader (a landing, a measured row, a correction) waits until it settles. */
export class MobileNativeChatPageMotion {
  private touching = false
  private lastReaderScroll = 0
  /** Where the page's own writes put the scroller, until their scroll event arrives. */
  private own: number[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private waiters: (() => void)[] = []

  constructor(private readonly onSettled: () => void) {}

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

  scrolled(scrollTop: number): void {
    const at = this.own.findIndex((target) => Math.abs(target - scrollTop) <= 1)
    if (at !== -1) {
      this.own.splice(0, at + 1)
      return
    }
    this.lastReaderScroll = Date.now()
    this.poke()
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
