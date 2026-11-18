# 接入 dsh-genui 与 dsh-context

> 状态：方案讨论稿，尚未实现。
> 范围：平台 `dsh-sandbox-platform`、脑 `dsh-sandbox-brain`。
> 上游：`@changfenhuang/dsh-genui@0.16.0`、`dsh-context@0.85.1`。
> 版本基线：本工作区平台与脑都锁 DSH `0.2.2-rc.3`，不是另一份接入说明里的 dashboard `0.2.1-alpha.2`。

两个插件都由平台锁版本、随部署发布，用户不能自己安装，也不能改宿主配置。两件事互不依赖，先做 genui，再做 context。

## 1. 结论

| 插件 | 能不能接 | 接入位置 | 主要工作量 |
|---|---|---|---|
| dsh-genui | 能，两半都可行 | 脑装宿主一半，平台浏览器壳装前端一半 | 脑加依赖和一行 profile；平台加依赖、roster 和一条 JS 资产路由 |
| dsh-context | 能，但平台要自己实现数据接口 | 只装浏览器一半，宿主数据由平台投影 | 平台新模块：`/api/dsh-context/*` 拦截、用量投影、两张新表、定价 |

两个插件都不进沙箱，不改变「脑只推理、改状态的动作走工作区沙箱」这条边界。

## 2. 版本与兼容性

- 平台 `package.json` 与脑 `config.yaml` 的 `dshVersion` 都是 `0.2.2-rc.3`。
- genui 0.16.0 的 peer 为 `^0.2.2-alpha.2`，覆盖 rc.3；但它只在 `0.2.2-rc.1` 上验过，rc.3 需要真机复验围栏渲染和 `render_ui` toolview。
- context 0.85.1 的 peer 为 `>=0.2.2-rc.1`，manifest 的 `compatibility.dshReleases` 明确写了 `0.2.2-rc.3+` 兼容。
- 两个插件的 Cordis peer 都被平台的 `@deepseek-ai/cordis@4.1.0` 覆盖。

结论：版本不用降级，但 genui 的 rc.3 兼容性要先冒烟再铺开。

## 3. dsh-genui

模型在正文里输出 `dsh-ui` 代码块，浏览器把它渲染成表格、指标、表单和选项卡；带 `action` 的按钮发一条以 `[genui-action]` 开头的普通用户消息，走现有 `POST /sessions/:id/messages` 回到模型。界面描述只存在会话事件里，刷新从历史重放，不另建表，不碰沙箱。

### 3.1 脑

已验证发布包的宿主半：

- 硬注入只有 `systemPrompt`；工具通过 `ctx.tools.register` 注册 `validate_dsh_ui` 和 `render_ui`。
- `skills`、`webServer` 通过 `ctx.inject([...])` 可选注入，API profile 里都存在。
- `dshGo` 同样是可选注入，API 脑没有这个服务，那段不会启动。
- 自带 `SKILL.md`，以 `source: bundled` 的 skill provider 注册 `genui`，不读沙箱里的技能目录。

接入：

1. `dsh-sandbox-brain/package.json` 锁 `@changfenhuang/dsh-genui@0.16.0`。
2. `dsh-sandbox-brain/profile/api/cordis.patch.yml` 的 `insert:` 列表加一行：

   ```yaml
   - id: genui
     name: '@changfenhuang/dsh-genui'
   ```

3. 不把浏览器地址指到脑的 `/plugins/.../assets/`：浏览器打不到脑。

### 3.2 平台前端

平台自己组装客户端启动图（`src/client/host.ts`），已有客户端包清单在 `src/client/roster.ts`。

接入：

1. `dsh-sandbox-platform/package.json` 锁同一版本。
2. `clientPackages` 加 `'@changfenhuang/dsh-genui'`。
3. 包本身满足加载条件：`dsh.client.platform === 'web'`、导出 `./client`、`inject` 为空。平台加载器会同时把宿主半挂进平台进程，但它等不到 `systemPrompt` 服务，只保持挂起；浏览器半照常进图。

### 3.3 资产路由（必须补，否则图表和 mermaid 不可用）

genui 的懒加载引擎脚本默认请求：

```
/plugins/@changfenhuang/dsh-genui/assets/<name>.js
```

现状：

- 平台的 `/plugins` 由 `@deepseek-ai/dsh-client-modules` 应答，它的包资产路由只放行 `.svg/.png/.webp/.jpg/.jpeg`，`.js` 一律 404。
- genui 宿主半自己注册的资产路由挂在**脑**的 webServer 上，浏览器到不了。
- 0.16.0 的 client 入口没有导出 `setGenuiAssetBase`（只导出 `apply`、`prefetchGenuiAssets`、`GenuiMapContext`、`setGenuiMapConfig`），所以没法在 index 注入里改基址。

解法：在 `src/client/surface.ts` 的 `/plugins` 分支之前加一条专用路由，从平台安装的 `@changfenhuang/dsh-genui/lib/assets/<flat>.js` 读文件：

- 只接受扁平文件名（与插件自己的白名单一致，如 `^[A-Za-z0-9][A-Za-z0-9._-]*\.js$`），拒绝 `..` 和子目录。
- 只认 `echarts-core`、`echarts-full`、`mermaid`、`three`、`icons`、`maplibre`。
- 返回 `content-type: text/javascript`、长缓存和 `nosniff`。
- 不做这条路由的后果：表格、表单、指标、按钮正常；`echart`/`mermaid`/`scene3d`/`map` 落 error fallback。注意内置 bar/line/pie 也走 `echarts-core`，不是纯 DOM。

### 3.4 验收

- 新会话说「做一个请假表单」，回复里出现可填写的表单，不是裸代码块。
- 提交后会话里多一条以 `[genui-action]` 开头的用户消息，模型能接着答。
- 刷新页面，同一条围栏还能画出来。
- 另一个用户看不到这次提交。
- 回复里不出现可执行 HTML 或脚本；不在白名单里的组件被丢掉，其余照常显示。
- 用一次真实 `render_ui` 确认工具结果的 `meta` 到达浏览器；到了再接工具卡。

## 4. dsh-context

浏览器用插件原来的页面：侧栏「上下文洞察」、会话里的 Context 标签、右侧栏和 `/context` 弹窗。数据不走插件的宿主半。

### 4.1 为什么不进脑

context 的宿主半会注入 `sessionQuery / sessionProjectionCache / sessionPersistence / sessions`，调用 `listSessions()` 扫描整个脑进程，结果放进程内存，没有平台用户校验；浏览器也访问不到脑的 webServer。所以不要把它插进 API profile，提示词前缀后缀也不落库。

平台加载器同样会尝试挂它的宿主半，但平台进程里没有 `connection` 服务，路由注册不会发生；浏览器半仍会进图。

### 4.2 请求路径

浏览器半以相对路径 `POST api/dsh-context/<name>` 请求，响应形如 `{ ok, value, revision, unchanged }`。从页面根 `/` 加载时解析为 `/api/dsh-context/<name>`。

平台现状：`src/client/surface.ts` 把所有 `/api/*` 默认转给脑，未拦截的路径会落到脑上 404。必须在 `proxyWeb` 里像 `/api/schedule/`、`/api/workspace/` 一样先截住 `/api/dsh-context/`，再套平台登录态和会话归属。

需要应答的端点（以浏览器包实际请求为准）：`overview`、`detail`、`fleet`、`balance`、`version`、`heads`、`facts`、`delta`、`backfill`、`attachment`、`skills`、`commands`、`recom`。第一期只填文档约定的块：

- `overview`：只查当前用户的用量行，填 KPI、7 天柱状图、热力图和会话卡片。
- `detail`：确认会话属于当前用户后，只重放这一条的 `assistant/message`、`request/header`、`tool/call`、`tool/result`、`step/*`。
- `fleet` 返回空列表；`balance` 返回空的成功结果，避免页面报错。

### 4.3 用量从哪来

脑在每次模型请求结束后写一条 `assistant/message`，用量在 `event.data.usage`：

| 字段 | 含义 |
|---|---|
| `inputTokens` | 未命中缓存的输入 |
| `cacheReadTokens` / `cacheWriteTokens` | 缓存读写，单独计 |
| `outputTokens` | 输出，`reasoningTokens` 已包含，不重复加 |
| `totalTokens` | 有值时以它为准 |

- 当前上下文大小 = 该会话最新一次请求的 `inputTokens + cacheReadTokens + cacheWriteTokens`。
- 累计 token 和金额才把历次请求相加。
- 模型取该条消息的 `source.provider`、`source.model`。
- 没形成 `assistant/message` 的 `llm/retry` 这一期不计。

数据来源是共享库里脑写的两张表：

- `dsh_session_events`：平台已经在读（`src/modules/sessions/service.ts` 的 `history()`）。
- `dsh_session_headers.next_seq`：平台目前不读，需要新增；表由脑建，平台要容忍建表前的 `42P01`（`history()` 已有同样的处理）。

本地默认两边共用同一个 SQLite 文件；PG 部署要求两边同库，且平台账号对 `dsh_session_headers` 有读权限。

### 4.4 平台自己的表

```sql
-- 一条已计价的 assistant/message，主键 (session_id, seq)
dsh_usage_steps (
  session_id, seq, user_id, workspace_id,
  at, provider, model,
  input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
  price_version, amount
);

-- 每个会话已经扫到的 seq
dsh_usage_cursors (session_id PRIMARY KEY, seq);
```

- 写入时从 `dsh_sessions` 带上 `user_id`、`workspace_id`；没有 `dsh_sessions` 行的会话跳过，子代理不混进用户用量。
- 价目放平台配置，按模型区分输入、缓存读、缓存写、输出；投影当时算好金额，之后改价不影响旧账。
- 投影放在平台进程里单独跑，不挂在聊天 SSE 上；历史会话用同一套游标补齐。可复用 `src/modules/schedule/loop.ts` 的定时器模式。
- 扫过的序号即使没有用量也推进游标；插入冲突忽略。

### 4.5 验收

- 侧栏能打开上下文洞察，数字只包含当前用户的会话。
- 打开一条自己的会话，Context 标签能看到最近一次上下文大小和本会话累计。
- 换一个用户登录，看不到上一个用户的会话卡片和金额。
- 刷新后数字还在，来自 `dsh_usage_steps`，不依赖脑进程内存。
- 系统提示里没有插件配置的前缀或后缀。
- SSE 实时路径是字节透传、历史路径是整条 event 原样下发，`meta` 不会丢；仍用一次真实工具调用复核。

## 5. 风险清单

| 风险 | 影响 | 处理 |
|---|---|---|
| genui 未在 rc.3 上验证 | 围栏或 toolview 可能不显示 | 先在一个会话里冒烟，再接入 |
| genui 懒加载 JS 资产被 `/plugins` 的图片白名单挡住 | 图表、mermaid、3D、地图不可用 | 平台补专用 `lib/assets/*.js` 路由 |
| `/api/dsh-context/*` 默认被转给脑 | 页面全 404 | `proxyWeb` 先拦截，再套归属校验 |
| 平台尚未读 `dsh_session_headers` | 投影起不来 | 新增读取并容忍 `42P01` |
| SQLite 单写者 | 投影写用量与脑写事件可能短暂争锁 | 小批量、短事务；必要时退避重试 |
| context 的 13 个端点响应结构只能从发布包逆出 | 工期主要在平台侧 | 以浏览器包实际请求和渲染结果为准，逐块对齐 |

## 6. 实施顺序

1. genui 脑侧：依赖 + profile 一行，跑一次真实会话确认工具与围栏。
2. genui 平台侧：依赖 + roster + 资产路由，补单测和 e2e（资产白名单、越界 404、启动图包含该包）。
3. genui 验收四条：表单可填、提交回到模型、刷新可重放、跨用户不可见。
4. context 浏览器包进图 + `/api/dsh-context/*` 拦截骨架（先 `version`/`fleet`/`balance` 空实现）。
5. 用量表、游标、投影循环、定价；补单测与多用户 e2e。
6. `overview` 与 `detail` 按真实渲染对齐，最后做全量验收。
