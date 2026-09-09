/**
 * 渲染层共享 DOM 助手（v0.7.10：自五个模块各自的本地拷贝收敛为单一实现）。
 * 签名与各历史拷贝完全一致（tag/className/text），纯搬移零行为变化。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
