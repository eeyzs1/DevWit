/**
 * 极简类型化事件发射器。on 返回解绑函数，fire 同步派发，dispose 清空全部监听。
 */
export type Listener<T> = (event: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  fire(event: T): void {
    // 复制一份，允许监听器在回调中安全地解绑自身
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
