import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface AppConfig {
  /** 本地默认 SQLite 文件；部署用 PostgreSQL 连接串。二选一。 */
  database: { url?: string; file?: string };
  aliyun: {
    sandbox: {
      apiKey: string;
      apiUrl: string;
      domain: string;
      template: string;
      roleArn: string;
    };
    oss: {
      region: string;
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      accessKeySecret: string;
    };
  };
  http: { host: string; port: number };
  auth: {
    tokenSecret: string;
    tokenTtlHours: number;
    adminUsername: string;
    adminPassword: string;
  };
  credentialsKey: string;
  brain: { baseUrl: string; appId: string; appKey: string };
  /** 没填 OSS 时，对象写到这个目录。脑的本地沙箱读同一份。 */
  storage?: { dir?: string };
  /**
   * 上下文洞察的价目，单位是美元 / 百万 token。键先按 `provider/model` 精确匹配，
   * 再按 `model`，最后 `*`。投影时把金额算进 `dsh_usage_steps.amount`。
   */
  pricing?: { models?: Record<string, ModelPrice> };
  /**
   * 集团 TokenPlan 的模型目录 / 额度接口。没配时设置页仍能配置 key，
   * 但目录和余额会提示「当前部署未配置 TokenPlan 接口」。
   */
  tokenPlan?: {
    apiBaseUrl?: string;
    applyUrl?: string;
    channel?: string;
    defaultModel?: string;
    timeoutMs?: number;
    balanceTimeoutMs?: number;
  };
}

export interface ModelPrice {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 配置里没写数据库时用的本地 SQLite 文件，相对平台仓库根。 */
export const DEFAULT_DATABASE_FILE = "var/dsh.sqlite";

export function loadConfig(): AppConfig {
  const file = resolve(root, "config.yaml");
  const raw = yaml.load(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("config.yaml 不是一份配置");
  const cfg = raw as AppConfig;
  // 写 file 用指定的 SQLite 文件；写 url 接 PostgreSQL；都没写就用本地默认 SQLite。
  const dbFile = cfg.database?.file?.trim() ?? "";
  if (dbFile) {
    cfg.database = { file: resolve(root, dbFile) };
  } else if (cfg.database?.url?.trim()) {
    cfg.database = { url: cfg.database.url.trim() };
  } else {
    cfg.database = { file: resolve(root, DEFAULT_DATABASE_FILE) };
  }
  // 密钥类配置优先取环境变量，部署时不必把真实值写进仓库里的 config.yaml。
  cfg.auth.tokenSecret = process.env.DSH_TOKEN_SECRET ?? cfg.auth?.tokenSecret ?? ""
  if (process.env.DSH_ADMIN_PASSWORD !== undefined) cfg.auth.adminPassword = process.env.DSH_ADMIN_PASSWORD
  cfg.credentialsKey = process.env.DSH_CREDENTIALS_KEY ?? cfg.credentialsKey ?? ""
  if (process.env.DSH_BRAIN_APP_KEY !== undefined) cfg.brain.appKey = process.env.DSH_BRAIN_APP_KEY
  if (!cfg.auth?.tokenSecret || cfg.auth.tokenSecret.length < 32) {
    throw new Error("config.yaml 的 auth.tokenSecret 至少 32 个字符");
  }
  if (!cfg.credentialsKey) throw new Error("config.yaml 缺少 credentialsKey");
  decodeKey(cfg.credentialsKey);
  const oss = cfg.aliyun?.oss;
  const ossReady = Boolean(oss?.endpoint && oss.bucket && oss.accessKeyId && oss.accessKeySecret);
  if (!ossReady) {
    const configured = cfg.storage?.dir?.trim() ?? "";
    cfg.storage = { dir: configured ? resolve(root, configured) : resolve(root, "var/objects") };
  }
  return cfg;
}

export function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("credentialsKey 必须是 32 字节的 base64");
  return key;
}
