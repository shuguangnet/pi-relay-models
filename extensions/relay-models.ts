/**
 * relay-models — 一键拉取中转站（OpenAI 兼容）模型列表与上下文大小
 *
 * 用法：
 *   /relay-models  拉取模型列表，匹配 models.dev 元数据，表格展示，并可注册为 Pi provider
 *   /relay-setup   （重新）配置中转站地址与 API Key
 *
 * 数据来源：
 *   - 中转站 GET {baseUrl}/v1/models（OpenRouter 类站点自带 context_length，优先使用）
 *   - models.dev 数据库（https://models.dev/api.json）补全上下文窗口 / 推理能力 / 价格
 *
 * 配置：~/.pi/agent/relay-models.json（权限 0600）
 * 缓存：~/.pi/agent/relay-models.cache.json（models.dev 索引，7 天有效）
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- 类型 ----------

interface RelayConfig {
  baseUrl: string;
  apiKey: string;
  registerProvider: boolean;
  providerId: string;
}

interface FlatDevModel {
  name?: string;
  reasoning?: boolean;
  context?: number;
  output?: number;
  input?: string[];
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface RelayModelRow {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  source: "relay" | "models.dev" | "guess" | "none";
}

interface RelaySnapshot {
  baseUrl: string;
  fetchedAt: string;
  total: number;
  rows: RelayModelRow[];
}

// ---------- 路径与工具 ----------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "relay-models.json");
const CACHE_PATH = join(homedir(), ".pi", "agent", "relay-models.cache.json");
const DEV_API_URL = "https://models.dev/api.json";
const DEV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  // 用户习惯粘贴到 /v1 或根路径都兼容
  return url;
}

function modelsEndpoint(baseUrl: string): string {
  return /\/v\d+$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

function formatTokens(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "未知";
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimNum(n / 1_000)}K`;
  return String(n);
}

function trimNum(x: number): string {
  const s = x.toFixed(x < 10 ? 1 : 0);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

async function loadConfig(): Promise<RelayConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as RelayConfig;
    if (cfg?.baseUrl && cfg?.apiKey) return cfg;
    return null;
  } catch {
    return null;
  }
}

async function saveConfig(cfg: RelayConfig): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await chmod(CONFIG_PATH, 0o600).catch(() => {});
}

// ---------- models.dev 索引 ----------

async function loadDevIndex(): Promise<Map<string, FlatDevModel>> {
  // 1) 磁盘缓存
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const cache = JSON.parse(raw) as { fetchedAt: number; index: Record<string, FlatDevModel> };
    if (Date.now() - cache.fetchedAt < DEV_CACHE_TTL_MS && cache.index) {
      return new Map(Object.entries(cache.index));
    }
  } catch { /* 无缓存 */ }

  // 2) 在线拉取
  const res = await fetch(DEV_API_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`models.dev 请求失败: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { models?: Record<string, FlatDevModel & { limit?: { context?: number; output?: number } }> }>;

  const index: Record<string, FlatDevModel> = {};
  for (const provider of Object.values(data)) {
    for (const [id, m] of Object.entries(provider.models ?? {})) {
      if (index[id]) continue; // 首个 provider 优先
      index[id] = {
        name: m.name,
        reasoning: m.reasoning,
        context: m.limit?.context,
        output: m.limit?.output,
        input: m.modalities?.input,
        cost: m.cost,
      };
    }
  }

  await writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), index })).catch(() => {});
  return new Map(Object.entries(index));
}

// ---------- 模型 id 匹配 ----------

function normalizeId(id: string): string {
  return id.toLowerCase().replace(/[\s_]/g, "-");
}

function stripDateSuffix(id: string): string {
  // gpt-5-2026-01-15 / claude-sonnet-4-20250514 → 去尾部日期
  return id.replace(/[-.]?\d{8}\b$/, "").replace(/[-.]?\d{4}-\d{2}-\d{2}\b$/, "");
}

function findDevModel(devIndex: Map<string, FlatDevModel>, relayId: string): FlatDevModel | null {
  const candidates = [
    relayId,
    normalizeId(relayId),
    stripDateSuffix(normalizeId(relayId)),
    // 去掉 "vendor/" 前缀
    relayId.includes("/") ? relayId.split("/").pop()! : null,
  ].filter((x): x is string => !!x);

  for (const key of candidates) {
    const hit = devIndex.get(key) ?? devIndex.get(stripDateSuffix(key));
    if (hit) return hit;
  }

  // 前缀模糊：relay id 以某个 dev id 为前缀（后跟 - 或结尾），取最长匹配
  const norm = stripDateSuffix(normalizeId(relayId));
  let best: { len: number; model: FlatDevModel } | null = null;
  for (const [devId, devModel] of devIndex) {
    if (norm.startsWith(devId) && (norm.length === devId.length || norm[devId.length] === "-")) {
      if (!best || devId.length > best.len) best = { len: devId.length, model: devModel };
    }
  }
  return best?.model ?? null;
}

// ---------- 拉取与组装 ----------

async function fetchRelayModels(cfg: RelayConfig, devIndex: Map<string, FlatDevModel>): Promise<RelaySnapshot> {
  const res = await fetch(modelsEndpoint(cfg.baseUrl), {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const payload = (await res.json()) as {
    data?: Array<{ id: string; context_length?: number; context_window?: number; max_tokens?: number; owned_by?: string }>;
  };
  const list = payload.data ?? [];
  if (list.length === 0) throw new Error("中转站返回了空模型列表");

  const rows: RelayModelRow[] = list.map((m) => {
    const dev = findDevModel(devIndex, m.id);

    // 上下文：中转站自带 > models.dev > 未知
    const relayCtx = m.context_length ?? m.context_window;
    let contextWindow: number | null = null;
    let source: RelayModelRow["source"] = "none";
    if (relayCtx && Number.isFinite(relayCtx)) {
      contextWindow = relayCtx;
      source = "relay";
    } else if (dev?.context) {
      contextWindow = dev.context;
      source = "models.dev";
    }

    const maxTokens = m.max_tokens ?? dev?.output ?? null;
    const reasoning = dev?.reasoning ?? /deepseek-r|(^|\/)(o[1345]|gpt-5)/i.test(m.id);
    const input: string[] = dev?.input ?? (/(vl|vision|4o|gpt-5|gemini|claude)/i.test(m.id) ? ["text", "image"] : ["text"]);
    const cost = dev?.cost
      ? {
          input: dev.cost.input ?? 0,
          output: dev.cost.output ?? 0,
          cacheRead: dev.cost.cache_read ?? 0,
          cacheWrite: dev.cost.cache_write ?? 0,
        }
      : null;

    return {
      id: m.id,
      name: dev?.name ?? m.id,
      contextWindow,
      maxTokens: typeof maxTokens === "number" ? maxTokens : null,
      reasoning,
      input,
      cost,
      source,
    };
  });

  rows.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || a.id.localeCompare(b.id));

  return {
    baseUrl: cfg.baseUrl,
    fetchedAt: new Date().toISOString(),
    total: rows.length,
    rows,
  };
}

// ---------- 展示 ----------

const ENTRY_TYPE = "relay-models-snapshot";

function renderTable(snapshot: RelaySnapshot, expanded: boolean): Box {
  const box = new Box(1, 1, (t) => t);
  box.addChild(new Text(`中转站 ${snapshot.baseUrl} — ${snapshot.total} 个模型（/relay-models 重新拉取）`));
  box.addChild(new Text(""));

  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  const padL = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s);

  const header = `${pad("模型", 38)}${padL("上下文", 8)}  ${padL("输出", 8)}  推理  来源`;
  box.addChild(new Text(header));
  box.addChild(new Text("-".repeat(Math.min(header.length, 78))));

  const rows = expanded ? snapshot.rows : snapshot.rows.slice(0, 12);
  for (const r of rows) {
    const ctx = r.contextWindow ? formatTokens(r.contextWindow) : "未知";
    const out = r.maxTokens ? formatTokens(r.maxTokens) : "-";
    const reasoning = r.reasoning ? "✓" : "";
    const src = r.source === "relay" ? "中转站" : r.source === "models.dev" ? "models.dev" : "—";
    box.addChild(new Text(`${pad(r.id, 38)}${padL(ctx, 8)}  ${padL(out, 8)}  ${pad(reasoning, 3)}  ${src}`));
  }
  if (!expanded && snapshot.rows.length > rows.length) {
    box.addChild(new Text(`… 其余 ${snapshot.rows.length - rows.length} 个已省略`));
  }
  return box;
}

export default function (pi: ExtensionAPI) {
  // 注册自定义条目渲染器（会话内持久展示，不进 LLM 上下文）
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }) => {
    const snapshot = (entry.data as { snapshot: RelaySnapshot }).snapshot;
    return renderTable(snapshot, expanded);
  });

  let cachedSnapshot: RelaySnapshot | null = null;
  let registeredFor = ""; // baseUrl+providerId，避免重复注册

  // 恢复上次快照（/reload 后表格仍在）
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        cachedSnapshot = (entry.data as { snapshot: RelaySnapshot }).snapshot;
      }
    }
  });

  async function runSetup(ctx: ExtensionCommandContext): Promise<RelayConfig | null> {
    const existing = await loadConfig();
    const baseUrlRaw = await ctx.ui.input(
      "中转站 Base URL",
      existing?.baseUrl ?? "例如 https://api.example.com 或 https://api.example.com/v1",
    );
    if (!baseUrlRaw) return null;
    const apiKey = await ctx.ui.input("API Key", existing?.apiKey ?? "sk-...");
    if (!apiKey) return null;
    const register = await ctx.ui.confirm("注册为 Pi provider？", "注册后可在 /model 选择器直接选用中转站模型（推荐）");

    const cfg: RelayConfig = {
      baseUrl: normalizeBaseUrl(baseUrlRaw),
      apiKey: apiKey.trim(),
      registerProvider: register,
      providerId: "relay",
    };
    await saveConfig(cfg);
    return cfg;
  }

  function registerRelayProvider(cfg: RelayConfig, snapshot: RelaySnapshot): void {
    const key = `${cfg.baseUrl}|${cfg.providerId}`;
    const models = snapshot.rows.map((r) => ({
      id: r.id,
      name: r.name,
      reasoning: r.reasoning,
      input: r.input,
      ...(r.cost ? { cost: r.cost } : {}),
      contextWindow: r.contextWindow ?? 128_000,
      maxTokens: r.maxTokens ?? 8192,
    }));
    pi.registerProvider(cfg.providerId, {
      name: `中转站 (${new URL(cfg.baseUrl).host})`,
      baseUrl: /\/v\d+$/.test(cfg.baseUrl) ? cfg.baseUrl : `${cfg.baseUrl}/v1`,
      apiKey: cfg.apiKey,
      api: "openai-completions",
      models,
    });
    registeredFor = key;
  }

  pi.registerCommand("relay-setup", {
    description: "配置中转站地址与 API Key",
    handler: async (_args, ctx) => {
      const cfg = await runSetup(ctx);
      ctx.ui.notify(cfg ? `已保存配置：${cfg.baseUrl}` : "已取消", cfg ? "info" : "warning");
    },
  });

  pi.registerCommand("relay-models", {
    description: "拉取中转站模型列表与上下文大小",
    getArgumentCompletions: (prefix: string) => {
      const items = [{ value: "--no-register", label: "只拉取展示，不注册 provider" }];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("relay-models 需要交互式 UI（TUI 模式）", "error");
        return;
      }

      let cfg = await loadConfig();
      if (!cfg) {
        ctx.ui.notify("首次使用，先配置中转站", "info");
        cfg = await runSetup(ctx);
        if (!cfg) return;
      }

      ctx.ui.setStatus("relay-models", "拉取中…");
      try {
        const devIndex = await loadDevIndex();
        const snapshot = await fetchRelayModels(cfg, devIndex);
        cachedSnapshot = snapshot;

        // 展示（自定义条目，持久保留在会话里）
        pi.appendEntry(ENTRY_TYPE, { snapshot });

        // 注册 provider
        const skipRegister = args?.includes("--no-register");
        if (cfg.registerProvider && !skipRegister) {
          try {
            registerRelayProvider(cfg, snapshot);
            ctx.ui.setWidget(
              "relay-models",
              [`中转站: ${snapshot.total} 模型 | provider "${cfg.providerId}" 已注册，/model 可选`],
            );
          } catch (e) {
            ctx.ui.notify(`Provider 注册失败：${(e as Error).message}`, "error");
          }
        }

        const known = snapshot.rows.filter((r) => r.source !== "none").length;
        ctx.ui.notify(
          `已拉取 ${snapshot.total} 个模型，${known} 个匹配到上下文大小${cfg.registerProvider && !skipRegister ? `，provider "${cfg.providerId}" 已就绪` : ""}`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`拉取失败：${(e as Error).message}`, "error");
      } finally {
        ctx.ui.setStatus("relay-models", undefined);
      }
    },
  });

  // 暴露给 LLM 的工具：当用户问"中转站有哪些模型/上下文多大"时可直接调用
  pi.registerTool({
    name: "relay_models",
    label: "中转站模型列表",
    description:
      "获取已配置中转站（OpenAI 兼容 API）的模型列表、上下文窗口大小等元数据。" +
      "返回上次拉取的快照；若从未拉取过则提示用户运行 /relay-models。" +
      "当用户询问中转站可用模型、模型上下文大小时使用。",
    parameters: Type.Object({}),
    promptSnippet: "查询中转站可用模型与上下文大小",
    async execute() {
      if (!cachedSnapshot) {
        return {
          content: [{ type: "text", text: "尚未拉取过中转站模型。请让用户运行 /relay-models 命令完成拉取。" }],
          details: {},
        };
      }
      const lines = cachedSnapshot.rows.map(
        (r) => `${r.id}\t上下文 ${formatTokens(r.contextWindow)}\t输出 ${r.maxTokens ? formatTokens(r.maxTokens) : "-"}\t${r.reasoning ? "推理" : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `中转站 ${cachedSnapshot.baseUrl} 共 ${cachedSnapshot.total} 个模型（拉取于 ${cachedSnapshot.fetchedAt}）：\n${lines.join("\n")}`,
          },
        ],
        details: { total: cachedSnapshot.total },
      };
    },
  });
}
