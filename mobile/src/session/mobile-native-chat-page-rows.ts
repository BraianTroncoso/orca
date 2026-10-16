type Scroller = { getBoundingClientRect: () => { top: number } }

function isElement(node: unknown): node is Element {
  return typeof Element !== 'undefined' && node instanceof Element
}

/** The page's drawn row nodes by key, each in the one observer while drawn, and the row the reader
 *  is reading: the first drawn row on screen and its offset from the scroller's top. */
export class MobileNativeChatPageRows {
  private nodes = new Map<string, Element>()
  private keys = new WeakMap<Element, string>()
  private refs = new Map<string, (node: unknown) => void>()
  private observer: ResizeObserver | null = null
  private anchor: { key: string; top: number } | null = null

  keyOf(node: Element): string | undefined {
    return this.keys.get(node)
  }

  node(key: string | undefined): Element | undefined {
    return key === undefined ? undefined : this.nodes.get(key)
  }

  readonly observeWith = (observer: ResizeObserver | null): void => {
    this.observer = observer
    this.nodes.forEach((node) => observer?.observe(node))
  }

  /** One ref per key for as long as the row is drawn, so a streamed commit never re-observes it. */
  readonly ref = (key: string): ((node: unknown) => void) => {
    let ref = this.refs.get(key)
    if (!ref) {
      ref = (node: unknown) => {
        const was = this.nodes.get(key)
        if (was) {
          this.observer?.unobserve(was)
          this.nodes.delete(key)
        }
        if (isElement(node)) {
          this.nodes.set(key, node)
          this.keys.set(node, key)
          this.observer?.observe(node)
        } else {
          this.refs.delete(key)
        }
      }
      this.refs.set(key, ref)
    }
    return ref
  }

  takeAnchor(scroller: Scroller, keys: readonly string[], start: number, end: number): void {
    const view = scroller.getBoundingClientRect().top
    let [low, high] = [start, end]
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      const node = this.node(keys[middle])
      if (!node || node.getBoundingClientRect().bottom <= view) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const key = keys[low]
    const node = this.node(key)
    this.anchor = key && node ? { key, top: node.getBoundingClientRect().top - view } : null
  }

  /** How far the anchored row has moved since it was taken; null when it isn't drawn. */
  anchorDrift(scroller: Scroller): number | null {
    const node = this.node(this.anchor?.key)
    return this.anchor && node
      ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - this.anchor.top
      : null
  }

  forgetAnchor(): void {
    this.anchor = null
  }
}
