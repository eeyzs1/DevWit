/**
 * SafeStorageBackend（WU005/WU007）：Electron safeStorage 加密后端（AR005）。
 * 密钥由操作系统钥匙串管理（Windows DPAPI / macOS Keychain / Linux kwallet）。
 * 加密不可用时不降级为明文——构造直接抛错，由主进程入口报错退出。
 */
import { safeStorage } from "electron";
import type { CryptoBackend } from "@devwit/contracts";

export class SafeStorageUnavailableError extends Error {
  constructor() {
    super("Electron safeStorage encryption is not available on this system");
    this.name = "SafeStorageUnavailableError";
  }
}

export class SafeStorageBackend implements CryptoBackend {
  readonly name = "electron-safeStorage";

  constructor() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new SafeStorageUnavailableError();
    }
  }

  encryptString(plaintext: string): string {
    return safeStorage.encryptString(plaintext).toString("base64");
  }

  decryptString(ciphertext: string): string {
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  }
}
