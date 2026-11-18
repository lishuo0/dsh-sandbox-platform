/**
 * 侧边栏「新增工作区」入口和弹窗。
 *
 * 官方客户端的「+」只在注册了 `sidebar.workspaces.directoryFlow` 槽位时出现，
 * 平台没有自定义客户端插件，所以这里用注入的 DOM 自己挂一个按钮：名称 + 选择
 * 这个工作区要接入的 Skills / MCP，提交走平台的 `P/remote/workspace/create` 收口，
 * 创建完让脑重新投影，侧边栏随之刷新。
 */

import { readFileSync } from 'node:fs'

const RUNTIME = readFileSync(new URL('./workspace-create-client.js', import.meta.url), 'utf8')

const MARKUP = `<div id="dsh-workspace-create" hidden aria-hidden="true">
<style>
#dsh-workspace-add{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}
#dsh-workspace-add svg{width:16px;height:16px;flex:none}
#dsh-workspace-add:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06))}
#dsh-workspace-add:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#0969da));outline-offset:-2px}
#dsh-workspace-add[data-rail="1"]{width:36px;height:36px;border-radius:var(--dsw-radius-md,10px);color:var(--dsw-alias-label-primary,#0f1115)}
#dsh-workspace-add[data-rail="1"] svg{width:18px;height:18px}
#dsh-workspace-create{--w-bg:#fff;--w-fg:#111827;--w-muted:#6e7781;--w-border:#e5e7eb;--w-border-strong:#d0d7de;--w-hover:#f3f4f6;--w-primary:#111827;--w-primary-fg:#fff;--w-error:#d1242f;--w-tag:#0969da;position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:24px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:var(--w-fg)}
#dsh-workspace-create[hidden]{display:none}
#dsh-workspace-create *{box-sizing:border-box}
#dsh-workspace-create .dsh-ws-mask{position:absolute;inset:0;background:rgba(15,17,21,.38)}
#dsh-workspace-create .dsh-ws-dialog{position:relative;display:flex;flex-direction:column;gap:14px;width:min(560px,100%);max-height:min(720px,100%);padding:20px 22px;border-radius:14px;background:var(--w-bg);box-shadow:0 18px 60px rgba(15,17,21,.28);overflow:auto}
#dsh-workspace-create h2{margin:0;font-size:17px;font-weight:600}
#dsh-workspace-create .dsh-ws-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
#dsh-workspace-create .dsh-ws-hint{margin:4px 0 0;color:var(--w-muted);font-size:12px}
#dsh-workspace-create .dsh-ws-close{flex:none;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--w-muted);font-size:18px;line-height:1;cursor:pointer}
#dsh-workspace-create .dsh-ws-close:hover{background:var(--w-hover);color:var(--w-fg)}
#dsh-workspace-create .dsh-ws-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--w-muted)}
#dsh-workspace-create .dsh-ws-field input{height:36px;padding:0 11px;border:1px solid var(--w-border-strong);border-radius:9px;background:var(--w-bg);color:var(--w-fg);font:inherit;font-size:13px}
#dsh-workspace-create .dsh-ws-field input:focus{outline:2px solid color-mix(in srgb,var(--w-tag) 25%,transparent);border-color:var(--w-tag)}
#dsh-workspace-create .dsh-ws-section{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--w-border);border-radius:11px}
#dsh-workspace-create .dsh-ws-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
#dsh-workspace-create .dsh-ws-section-head h3{margin:0;font-size:13px;font-weight:600}
#dsh-workspace-create .dsh-ws-section-head span{color:var(--w-muted);font-size:11.5px}
#dsh-workspace-create .dsh-ws-picker{display:flex;flex-direction:column;gap:8px}
#dsh-workspace-create .dsh-ws-searchbox{position:relative}
#dsh-workspace-create .dsh-ws-search{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:1px solid var(--w-border-strong);border-radius:8px;background:transparent;color:var(--w-fg);font:inherit;font-size:12.5px}
#dsh-workspace-create .dsh-ws-search:focus{outline:2px solid color-mix(in srgb,var(--w-tag) 25%,transparent);border-color:var(--w-tag)}
#dsh-workspace-create .dsh-ws-panel{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;max-height:240px;overflow:auto;padding:4px;border:1px solid var(--w-border);border-radius:10px;background:var(--w-bg);box-shadow:0 12px 32px rgba(15,23,42,.16)}
#dsh-workspace-create .dsh-ws-panel[hidden]{display:none}
#dsh-workspace-create .dsh-ws-candidate{display:flex;align-items:flex-start;gap:10px;width:100%;padding:8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
#dsh-workspace-create .dsh-ws-candidate:hover,#dsh-workspace-create .dsh-ws-candidate:focus-visible{background:var(--w-hover);outline:none}
#dsh-workspace-create .dsh-ws-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;color:#fff;font-size:14px;font-weight:600}
#dsh-workspace-create .dsh-ws-candidate-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;font-size:11.5px;color:var(--w-muted)}
#dsh-workspace-create .dsh-ws-candidate-text strong{color:var(--w-fg);font-size:12.5px;font-weight:600}
#dsh-workspace-create .dsh-ws-candidate-text span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-workspace-create .dsh-ws-selected{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
#dsh-workspace-create .dsh-ws-pick{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--w-border);border-radius:9px;background:var(--w-bg)}
#dsh-workspace-create .dsh-ws-pick-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
#dsh-workspace-create .dsh-ws-pick-text strong{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-workspace-create .dsh-ws-pick-text span{color:var(--w-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-workspace-create .dsh-ws-remove{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--w-muted);font-size:16px;line-height:1;cursor:pointer}
#dsh-workspace-create .dsh-ws-remove:hover{background:var(--w-hover);color:var(--w-error)}
#dsh-workspace-create .dsh-ws-empty{margin:2px 0;color:var(--w-muted);font-size:12px}
#dsh-workspace-create .dsh-ws-error{margin:0;padding:9px 12px;border-radius:9px;background:color-mix(in srgb,var(--w-error) 10%,transparent);color:var(--w-error);font-size:12px}
#dsh-workspace-create .dsh-ws-error[hidden]{display:none}
#dsh-workspace-create .dsh-ws-actions{display:flex;justify-content:flex-end;gap:8px}
#dsh-workspace-create .dsh-ws-button{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;border:1px solid var(--w-border-strong);border-radius:9px;background:var(--w-bg);color:var(--w-fg);font:inherit;font-size:13px;cursor:pointer}
#dsh-workspace-create .dsh-ws-button:hover:not(:disabled){background:var(--w-hover)}
#dsh-workspace-create .dsh-ws-button.primary{border-color:var(--w-primary);background:var(--w-primary);color:var(--w-primary-fg)}
#dsh-workspace-create .dsh-ws-button:disabled{opacity:.5;cursor:not-allowed}
@media (prefers-color-scheme:dark){
#dsh-workspace-create{--w-bg:#15161a;--w-fg:#f3f4f6;--w-muted:#9aa0a6;--w-border:#2a2b31;--w-border-strong:#3a3b42;--w-hover:#23242a;--w-primary:#f3f4f6;--w-primary-fg:#111827;--w-error:#ff8a80;--w-tag:#6ea8fe}
}
@media (max-width:720px){
#dsh-workspace-create{padding:0}
#dsh-workspace-create .dsh-ws-dialog{width:100%;height:100%;max-height:none;border-radius:0}
}
</style>
<div class="dsh-ws-mask" data-dsh-ws-close></div>
<div class="dsh-ws-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-ws-title">
<div class="dsh-ws-head">
<div>
<h2 id="dsh-ws-title">新建工作区</h2>
<p class="dsh-ws-hint">选择这个工作区里的新会话可以使用的 Skills 和 MCP；不选表示都不接入。</p>
</div>
<button class="dsh-ws-close" type="button" aria-label="关闭" data-dsh-ws-close>×</button>
</div>
<label class="dsh-ws-field">
<span>名称</span>
<input id="dsh-ws-name" type="text" value="新工作区" maxlength="60" autocomplete="off">
</label>
<section class="dsh-ws-section">
<div class="dsh-ws-section-head"><h3>Skills</h3><span id="dsh-ws-skills-count"></span></div>
<div class="dsh-ws-picker">
<div class="dsh-ws-searchbox">
<input class="dsh-ws-search" id="dsh-ws-skills-search" type="search" placeholder="搜索并添加 Skill" autocomplete="off" aria-label="搜索 Skill">
<div class="dsh-ws-panel" id="dsh-ws-skills-panel" role="listbox" aria-label="可用的 Skill" hidden></div>
</div>
<div class="dsh-ws-selected" id="dsh-ws-skills"></div>
</div>
</section>
<section class="dsh-ws-section">
<div class="dsh-ws-section-head"><h3>MCP</h3><span id="dsh-ws-mcp-count"></span></div>
<div class="dsh-ws-picker">
<div class="dsh-ws-searchbox">
<input class="dsh-ws-search" id="dsh-ws-mcp-search" type="search" placeholder="搜索并添加 MCP" autocomplete="off" aria-label="搜索 MCP">
<div class="dsh-ws-panel" id="dsh-ws-mcp-panel" role="listbox" aria-label="可用的 MCP" hidden></div>
</div>
<div class="dsh-ws-selected" id="dsh-ws-mcp"></div>
</div>
</section>
<p class="dsh-ws-error" id="dsh-ws-error" hidden></p>
<div class="dsh-ws-actions">
<button class="dsh-ws-button" type="button" data-dsh-ws-close>取消</button>
<button class="dsh-ws-button primary" id="dsh-ws-submit" type="button">创建</button>
</div>
</div>
</div>`

export function workspaceCreate(): string {
  return `${MARKUP}\n<script>\n${RUNTIME}\n</script>`
}
