/** Binary min-heap keyed by number — used for Dijkstra priority queues. */
export class MinHeap<T> {
  private heap: { key: number; value: T }[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(key: number, value: T): void {
    this.heap.push({ key, value });
    this._bubbleUp(this.heap.length - 1);
  }

  pop(): { key: number; value: T } | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].key <= this.heap[i].key) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.heap[l].key < this.heap[smallest].key) smallest = l;
      if (r < n && this.heap[r].key < this.heap[smallest].key) smallest = r;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }
}
