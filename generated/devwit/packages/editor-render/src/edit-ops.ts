/**
 * 编辑运算纯函数（v0.7.13 自 EditorView 抽取）：多光标删除的偏移结算与
 * 代理对感知的删除长度。抽出动机：这些是正确性关键路径（光标 = 下次插入点），
 * 需要独立单测锁定；EditorView 只保留 DOM/渲染装配。
 */

/**
 * 多光标删除后的最终偏移结算。
 *
 * 每个光标的最终偏移 = 自身删除后的新位置 −（所有偏移更低的光标实际删除
 * 长度之和）。旧实现以「低位光标个数」近似位移，仅在每光标恰删 1 字符
 * （退格/Delete）时成立——词删除/代理对删除每光标删多字符时高位光标
 * 系统性偏右，之后打字落点漂移。
 *
 * 约定：编辑按偏移降序应用（保证低位偏移在编辑时有效）；ownNewOffsets[i]
 * 为光标 i 自身删除后的（未平移）落点；removedLens[i] 为其实际删除长度。
 * 偏移相同的光标（重合）按传入顺序累计，最终由调用方去重。
 */
export function multiCursorFinalOffsets(
  offsets: readonly number[],
  removedLens: readonly number[],
  ownNewOffsets: readonly number[]
): number[] {
  const n = offsets.length;
  const asc = offsets.map((offset, index) => ({ offset, index })).sort((a, b) => a.offset - b.offset);
  const shiftBelow = new Array<number>(n).fill(0);
  let acc = 0;
  for (const { index } of asc) {
    shiftBelow[index] = acc;
    acc += removedLens[index] ?? 0;
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = (ownNewOffsets[i] ?? 0) - (shiftBelow[i] ?? 0);
  }
  return out;
}

/** 光标左侧一个字符的删除长度：代理对（emoji 等增补平面字符）= 2 码元，否则 1。
 *  按码元硬删 1 会拆散代理对，残留孤立高代理渲染为乱码方块且可持久化。 */
export function backwardDeleteLength(text: string, offset: number): number {
  if (offset >= 2) {
    const two = text.slice(offset - 2, offset);
    if ((two.codePointAt(0) ?? 0) > 0xffff) return 2;
  }
  return 1;
}

/** 光标右侧一个字符的删除长度：代理对 = 2 码元，否则 1。 */
export function forwardDeleteLength(text: string, offset: number): number {
  const two = text.slice(offset, offset + 2);
  if ((two.codePointAt(0) ?? 0) > 0xffff) return 2;
  return 1;
}
