export type Unsubscribe = () => void

interface ListenerNode {
  active: boolean
  listener: unknown
  next: ListenerNode | null
  once: boolean
  previous: ListenerNode | null
}

interface ListenerBucket {
  head: ListenerNode | null
  size: number
  tail: ListenerNode | null
}

/**
 * Allocation-free dispatch registry after subscription. Listener nodes are
 * linked so unsubscribe during dispatch does not require snapshot arrays.
 */
export default class EventRegistry<Events extends { [Name in keyof Events]: unknown[] }> {
  readonly #buckets = new Map<keyof Events, ListenerBucket>()

  constructor() {
    this.listenerCount = this.listenerCount.bind(this)
    this.off = this.off.bind(this)
    this.on = this.on.bind(this)
    this.once = this.once.bind(this)
  }

  on<Name extends keyof Events>(event: Name, listener: (...args: Events[Name]) => void): Unsubscribe {
    return this.#add(event, listener, false)
  }

  once<Name extends keyof Events>(event: Name, listener: (...args: Events[Name]) => void): Unsubscribe {
    return this.#add(event, listener, true)
  }

  #add<Name extends keyof Events>(
    event: Name,
    listener: (...args: Events[Name]) => void,
    onceOnly: boolean
  ): Unsubscribe {
    if (typeof listener !== 'function') {
      throw new TypeError('Event listener must be a function')
    }

    let bucket = this.#buckets.get(event)

    if (!bucket) {
      bucket = { head: null, size: 0, tail: null }
      this.#buckets.set(event, bucket)
    }

    const node: ListenerNode = {
      active: true,
      listener,
      next: null,
      once: onceOnly,
      previous: bucket.tail
    }

    if (bucket.tail) {
      bucket.tail.next = node
    } else {
      bucket.head = node
    }

    bucket.tail = node
    bucket.size++

    return () => this.#remove(event, bucket, node)
  }

  off<Name extends keyof Events>(event: Name, listener: (...args: Events[Name]) => void): void {
    const bucket = this.#buckets.get(event)

    if (!bucket) {
      return
    }

    let node = bucket.head

    while (node) {
      const next = node.next

      if (node.listener === listener) {
        this.#remove(event, bucket, node)
      }

      node = next
    }
  }

  emit<Name extends keyof Events>(event: Name, ...args: Events[Name]): void {
    const bucket = this.#buckets.get(event)

    if (!bucket) {
      return
    }

    const tailAtStart = bucket.tail

    let node = bucket.head

    while (node) {
      const current = node

      node = current.next

      if (current.active) {
        if (current.once) {
          this.#remove(event, bucket, current)
        }

        const listener = current.listener as (...args: Events[Name]) => void

        listener(...args)
      }

      if (current === tailAtStart) {
        break
      }
    }
  }

  listenerCount<Name extends keyof Events>(event: Name): number {
    return this.#buckets.get(event)?.size ?? 0
  }

  #remove(event: keyof Events, bucket: ListenerBucket, node: ListenerNode): void {
    if (!node.active) {
      return
    }

    node.active = false

    if (node.previous) {
      node.previous.next = node.next
    } else {
      bucket.head = node.next
    }

    if (node.next) {
      node.next.previous = node.previous
    } else {
      bucket.tail = node.previous
    }

    node.next = null
    node.previous = null
    bucket.size--

    if (bucket.size === 0) {
      this.#buckets.delete(event)
    }
  }
}
