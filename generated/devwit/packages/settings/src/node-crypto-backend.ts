/**
 * NodeCryptoBackend（WU007）：基于 node:crypto 的真实 AES-256-GCM 加密后端。
 * 密钥由机器标识（hostname + username）经 scrypt 派生，用于测试与 headless 场景；
 * 生产桌面环境由 apps/desktop 注入 Electron safeStorage 后端替代。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import os from "node:os";
import type { CryptoBackend } from "@devwit/contracts";

const KEY_SALT = "devwit-node-crypto-backend-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function machineSecret(): string {
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USERNAME ?? process.env.USER ?? "unknown";
  }
  return `${os.hostname()}${username}`;
}

export class NodeCryptoBackend implements CryptoBackend {
  readonly name = "node-crypto";

  private readonly key: Buffer;

  constructor() {
    this.key = scryptSync(machineSecret(), KEY_SALT, 32);
  }

  /** 输出 base64(iv | authTag | ciphertext)。 */
  encryptString(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  decryptString(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    if (buf.length < IV_BYTES + TAG_BYTES) {
      throw new Error("Invalid ciphertext: too short");
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const data = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}
