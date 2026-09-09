/**
 * 测试夹具：收到消息后永不回复的搜索 worker（超时终止语义测试）。
 */
import { parentPort } from "node:worker_threads";

if (parentPort !== null) {
  parentPort.on("message", () => {
    // 故意不回复：模拟灾难性回溯/挂死
  });
  setInterval(() => {}, 60_000); // 保持事件循环存活
}
