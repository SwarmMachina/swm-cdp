export default class TaskQueue {
  readonly #maxDepth: number
  readonly #overflow: 'throw' | 'drop-oldest'
  readonly #queue: Array<{ droppable: boolean; task: () => void } | undefined> = []
  #depth = 0
  #droppedCount = 0
  #read = 0
  #scheduled = false
  #stopped = false

  constructor(maxDepth = Number.POSITIVE_INFINITY, overflow: 'throw' | 'drop-oldest' = 'throw') {
    if ((!Number.isSafeInteger(maxDepth) && maxDepth !== Number.POSITIVE_INFINITY) || maxDepth < 0) {
      throw new TypeError('Task queue depth must be a non-negative safe integer')
    }

    this.#maxDepth = maxDepth
    this.#overflow = overflow
  }

  get droppedCount(): number {
    return this.#droppedCount
  }

  enqueue(task: () => void, droppable = false): boolean {
    if (typeof task !== 'function') {
      throw new TypeError('Task must be a function')
    }

    if (this.#stopped) {
      throw new Error('Task queue already stopped')
    }

    if (this.#depth >= this.#maxDepth) {
      if (this.#overflow !== 'drop-oldest' || !this.#dropOldestDroppable()) {
        if (droppable && this.#overflow === 'drop-oldest') {
          this.#droppedCount++

          return false
        }

        throw new RangeError(`Task queue depth limit exceeded: ${this.#maxDepth}`)
      }
    }

    this.#queue.push({ droppable, task })
    this.#depth++
    this.#schedule()

    return true
  }

  stop(): void {
    this.#stopped = true
    this.#scheduled = false
    this.#queue.length = 0
    this.#read = 0
    this.#depth = 0
  }

  #schedule(): void {
    if (this.#scheduled) {
      return
    }

    this.#scheduled = true
    setImmediate(() => this.#drain())
  }

  #drain(): void {
    this.#scheduled = false

    if (this.#stopped || this.#read === this.#queue.length) {
      return
    }

    const end = Math.min(this.#queue.length, this.#read + 64)

    while (!this.#stopped && this.#read < end) {
      const entry = this.#queue[this.#read]

      this.#queue[this.#read++] = undefined

      if (entry) {
        this.#depth--
        entry.task()
      }
    }

    if (this.#stopped || this.#read === this.#queue.length) {
      this.#queue.length = 0
      this.#read = 0
    } else {
      this.#schedule()
    }
  }

  #dropOldestDroppable(): boolean {
    for (let index = this.#read; index < this.#queue.length; index += 1) {
      if (this.#queue[index]?.droppable) {
        this.#queue[index] = undefined
        this.#depth--
        this.#droppedCount++

        return true
      }
    }

    return false
  }
}
