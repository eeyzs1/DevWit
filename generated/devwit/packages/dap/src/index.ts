/** @devwit/dap — DAP 客户端（Content-Length 分帧，stdio/TCP 传输可注入）+ js-debug 会话编排。 */
export {
  DapClient,
  nodeSpawnFactory,
  stdioTransportFactory,
  type DapChildProcess,
  type DapSpawnFactory,
  type DapTransport,
  type DapTransportBinding,
  type DapTransportFactory,
} from "./dap-client.js";
export { tcpServerTransportFactory } from "./tcp-transport.js";
export {
  JsDebugSession,
  type DebugScope,
  type DebugStackFrame,
  type DebugState,
  type DebugVariable,
  type JsDebugSessionOptions,
} from "./js-debug-session.js";
