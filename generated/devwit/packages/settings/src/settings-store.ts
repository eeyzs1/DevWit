/**
 * SettingsStore（WU007）：设置中心 + 凭证加密存储（热更新）。
 *
 * - 普通设置：storageDir/settings.json（明文 JSON，禁止写入敏感值，AR005）。
 * - 凭证：storageDir/credentials.enc.json，secret 经注入的 CryptoBackend 加密落盘，
 *   文件中只出现 ciphertext/provider/时间戳，绝无明文。
 * - set/reload 触发 SettingsChangeListener，实现配置热更新（AC6）。
 * - 实现 contracts 的 CredentialResolver，供 llm-providers 主进程内热读取（换 key 不重启）。
 */
import fs from "node:fs";
import path from "node:path";
import { CredentialNotFoundError } from "@devwit/contracts";
import type { CredentialMeta, CredentialResolver, CryptoBackend, SettingsChangeListener } from "@devwit/contracts";

interface CredentialRecord {
  provider: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

const SETTINGS_FILE = "settings.json";
const CREDENTIALS_FILE = "credentials.enc.json";

function readJsonObject(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // 损坏文件备份后按空处理，避免启动崩溃
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // 备份失败忽略
    }
    return {};
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

export class SettingsStore implements CredentialResolver {
  private readonly crypto: CryptoBackend;
  private readonly settingsPath: string;
  private readonly credentialsPath: string;
  private settings: Record<string, unknown>;
  private credentials: Record<string, CredentialRecord>;
  private readonly listeners = new Set<SettingsChangeListener>();

  constructor(crypto: CryptoBackend, storageDir: string) {
    this.crypto = crypto;
    fs.mkdirSync(storageDir, { recursive: true });
    this.settingsPath = path.join(storageDir, SETTINGS_FILE);
    this.credentialsPath = path.join(storageDir, CREDENTIALS_FILE);
    this.settings = readJsonObject(this.settingsPath);
    this.credentials = readJsonObject(this.credentialsPath) as unknown as Record<string, CredentialRecord>;
  }

  /** 加密后端名（node-crypto / electron-safeStorage），用于诊断展示。 */
  get cryptoBackendName(): string {
    return this.crypto.name;
  }

  // ------------------------------------------------------------------
  // 普通设置
  // ------------------------------------------------------------------

  get(key: string): unknown {
    return this.settings[key];
  }

  /** 写入设置并立即落盘，随后触发全部变更监听（热更新）。 */
  set(key: string, value: unknown): void {
    this.settings[key] = value;
    writeJsonAtomic(this.settingsPath, this.settings);
    this.emitChange(key, value);
  }

  /** 订阅设置变更，返回退订函数。 */
  onChanged(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 从磁盘重读设置与凭证；对发生变化的设置键触发变更监听。 */
  reload(): void {
    const prevSettings = this.settings;
    this.settings = readJsonObject(this.settingsPath);
    this.credentials = readJsonObject(this.credentialsPath) as unknown as Record<string, CredentialRecord>;
    const keys = new Set([...Object.keys(prevSettings), ...Object.keys(this.settings)]);
    for (const key of keys) {
      const prev = prevSettings[key];
      const next = this.settings[key];
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        this.emitChange(key, next);
      }
    }
  }

  // ------------------------------------------------------------------
  // 凭证（AR005：明文只在内存中出现，落盘一律密文）
  // ------------------------------------------------------------------

  setCredential(ref: string, provider: string, secret: string): void {
    const now = new Date().toISOString();
    const existing = this.credentials[ref];
    this.credentials[ref] = {
      provider,
      ciphertext: this.crypto.encryptString(secret),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    writeJsonAtomic(this.credentialsPath, this.credentials);
  }

  /** 解密读取凭证明文；ref 不存在抛 CredentialNotFoundError。 */
  getCredential(ref: string): string {
    const record = this.credentials[ref];
    if (!record) {
      throw new CredentialNotFoundError(ref);
    }
    return this.crypto.decryptString(record.ciphertext);
  }

  /** CredentialResolver 契约实现（llm-providers 注入此接口）。 */
  async resolve(ref: string): Promise<string> {
    return this.getCredential(ref);
  }

  deleteCredential(ref: string): void {
    if (!this.credentials[ref]) {
      throw new CredentialNotFoundError(ref);
    }
    delete this.credentials[ref];
    writeJsonAtomic(this.credentialsPath, this.credentials);
  }

  /** 凭证元信息列表，绝不含明文与密文。 */
  listCredentials(): CredentialMeta[] {
    return Object.entries(this.credentials).map(([ref, record]) => ({
      ref,
      provider: record.provider,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }));
  }

  private emitChange(key: string, value: unknown): void {
    for (const listener of this.listeners) {
      listener(key, value);
    }
  }
}
