import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface AppConfig {
  database: { url: string };
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
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(): AppConfig {
  const file = resolve(root, "config.yaml");
  const raw = yaml.load(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("config.yaml 不是一份配置");
  const cfg = raw as AppConfig;
  if (!cfg.database?.url) throw new Error("config.yaml 缺少 database.url");
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
