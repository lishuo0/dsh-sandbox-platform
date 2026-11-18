/**
 * 平台自带的配置页：Skills / MCP / 管理（用户、沙箱）。
 *
 * 布局参考官方设置页：左栏导航 + 右栏内容；定位也和设置页一致——
 * `fixed` 钉在侧栏右侧（`inset: 0 0 0 var(--dsh-platform-sidebar-width)`），
 * 不盖住左侧会话菜单，点左侧照常可点。左侧菜单的 Skills / MCP 各自打开
 * 自己的整页；头像菜单里管理员的「管理」打开用户 / 沙箱，左栏导航只列这两个。
 */

import { readFileSync } from 'node:fs'
import { CONSOLE_VIEWS } from './console-views.js'

const RUNTIME = readFileSync(new URL('./console-client.js', import.meta.url), 'utf8')

const MARKUP = `<div id="dsh-console" hidden aria-hidden="true" data-open="false" data-scope="admin">
<style>
/* 左侧菜单里的 Skills / MCP 入口，由脚本插进客户端自带的面板导航。 */
#dsh-console-menu{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}
#dsh-console-menu button{display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap,8px);min-height:32px;margin:0;padding:5px calc(var(--dsh-sidebar-row-padding,10px) - var(--dsh-sidebar-paint-inset,3px));box-sizing:border-box;border:0;border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;border-radius:var(--dsw-radius-md,10px);background:transparent;background-clip:padding-box;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;line-height:22px;text-align:left;cursor:pointer}
#dsh-console-menu button:hover,#dsh-console-menu button.active{background-color:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06))}
#dsh-console-menu button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#0969da);outline-offset:-2px}
#dsh-console-menu svg{flex:none;width:16px;height:16px}
#dsh-console-menu .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-console-menu.dsh-rail{gap:12px;margin-bottom:12px}
#dsh-console-menu.dsh-rail button{width:36px;height:36px;min-height:0;justify-content:center;padding:0;border-inline:0}
#dsh-console-menu.dsh-rail .label{display:none}
/* 和设置页同一套钉法：fixed 铺满侧栏右侧，不盖左侧菜单。 */
#dsh-console{--c-bg:#fff;--c-side:#f7f8fa;--c-fg:#111827;--c-muted:#6e7781;--c-border:#e5e7eb;--c-border-strong:#d0d7de;--c-hover:#eef1f5;--c-primary:#111827;--c-primary-fg:#fff;--c-accent:#0969da;--c-error:#d1242f;--c-success:#1a7f37;position:fixed;inset:0 0 0 var(--dsh-platform-sidebar-width,280px);z-index:900;display:grid;grid-template-columns:188px minmax(0,1fr);grid-template-rows:minmax(0,1fr);width:auto;height:auto;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,var(--c-bg));color:var(--c-fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;text-align:left}
#dsh-console[hidden]{display:none!important}
#dsh-console [hidden]{display:none!important}
/* 从侧栏的 Skills / MCP 进来时没有管理左栏，内容整页铺开。 */
#dsh-console[data-scope="tool"]{grid-template-columns:minmax(0,1fr)}
#dsh-console *{box-sizing:border-box}
#dsh-console button,#dsh-console input,#dsh-console select,#dsh-console textarea{font:inherit;color:inherit}
/* 左栏：标题 + 导航格，和设置页面板的左栏同宽同高。 */
#dsh-console-rail{display:flex;flex-direction:column;min-width:0;min-height:0;padding:calc(20px + var(--dsh-frame-top-clearance,0px)) 0 12px;background:var(--dsw-specific-sidebar-fill,var(--c-side))}
#dsh-console[data-scope="tool"] #dsh-console-rail{display:none}
#dsh-console-rail-title{padding:0 16px 10px 24px;font-size:16px;font-weight:500;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-console-nav{display:flex;flex-direction:column;gap:4px;min-height:0;padding:0 12px;overflow-y:auto}
#dsh-console-nav button{display:flex;align-items:center;gap:8px;height:40px;margin:0;padding:9px 16px 9px 12px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}
#dsh-console-nav button:hover{background:var(--c-hover)}
#dsh-console-nav button.active{background:color-mix(in srgb,var(--c-fg) 9%,transparent)}
#dsh-console-nav button:focus-visible{outline:2px solid var(--c-accent);outline-offset:-2px}
#dsh-console-nav svg{flex:none;width:16px;height:16px}
#dsh-console-nav .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-console .admin-page-main{grid-column:2;display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0;overflow:auto;padding:calc(20px + var(--dsh-frame-top-clearance,0px)) clamp(20px,4vw,40px) 40px}
#dsh-console[data-scope="tool"] .admin-page-main{grid-column:1}
#dsh-console .admin-page-main-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;width:100%;max-width:1040px;margin:0 auto}
#dsh-console .admin-page-main-head>div:first-child{min-width:0}
#dsh-console .admin-page-main-head h1{margin:0;font-size:20px;font-weight:500;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-console .admin-page-main-head p{margin:5px 0 0;color:var(--c-muted);font-size:12.5px}
#dsh-console .admin-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#dsh-console .admin-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;cursor:pointer;border:1px solid var(--c-border-strong);background:var(--c-bg);color:var(--c-fg);font-size:13px;-webkit-tap-highlight-color:transparent}
#dsh-console .admin-button:hover:not(:disabled){background:var(--c-hover)}
#dsh-console .admin-button:disabled{opacity:.45;cursor:not-allowed}
#dsh-console .admin-button.primary{background:var(--c-primary);color:var(--c-primary-fg);border-color:var(--c-primary)}
#dsh-console .admin-button.primary:hover:not(:disabled){opacity:.9;background:var(--c-primary);color:var(--c-primary-fg)}
#dsh-console .admin-button.small{height:28px;padding:0 9px;font-size:12px}
#dsh-console .admin-close{flex:none;width:28px;padding:0;margin-left:4px}
#dsh-console .admin-button.danger{color:var(--c-error)}
#dsh-console .admin-card,#dsh-console .dsh-card-grid,#dsh-console .admin-state{max-width:1040px;width:100%;margin:0 auto}
#dsh-console .admin-card{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--c-border);border-radius:12px;background:var(--c-bg)}
#dsh-console .admin-hint{color:var(--c-muted);font-size:12px}
#dsh-console .admin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
#dsh-console .admin-grid label,#dsh-console .admin-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--c-muted)}
#dsh-console .admin-grid input,#dsh-console .admin-grid select,#dsh-console .admin-field textarea{box-sizing:border-box;width:100%;border-radius:8px;border:1px solid var(--c-border-strong);background:var(--c-bg);color:var(--c-fg);padding:7px 10px}
#dsh-console .admin-grid input,#dsh-console .admin-grid select{height:34px}
#dsh-console .admin-grid input:disabled,#dsh-console .admin-grid select:disabled{opacity:.65;cursor:not-allowed}
#dsh-console .admin-field textarea{min-height:150px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:1.55;resize:vertical;min-width:100%}
#dsh-console .admin-field textarea.skill-md{min-height:320px}
#dsh-console .admin-grid input:focus,#dsh-console .admin-grid select:focus,#dsh-console .admin-field textarea:focus{outline:2px solid color-mix(in srgb,var(--c-accent) 25%,transparent);border-color:var(--c-accent)}
#dsh-console .dsh-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
#dsh-console .dsh-card{display:flex;flex-direction:column;gap:12px;min-height:170px;padding:18px 18px 14px;text-align:left;border:1px solid var(--c-border);border-radius:12px;background:var(--c-bg);color:inherit;font:inherit;cursor:pointer}
#dsh-console .dsh-card:hover{border-color:var(--c-accent);box-shadow:0 4px 16px rgba(15,23,42,.06)}
#dsh-console .dsh-card:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
#dsh-console .dsh-card.readonly{cursor:default}
#dsh-console .dsh-card.readonly:hover{border-color:var(--c-border);box-shadow:none}
#dsh-console .dsh-card.off{opacity:.72}
#dsh-console .dsh-card-top{display:flex;align-items:flex-start;gap:12px}
#dsh-console .dsh-card-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;color:#fff;font-size:20px;font-weight:600}
#dsh-console .dsh-card-identity{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
#dsh-console .dsh-card-identity strong{font-size:16px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-console .dsh-card-identity span{color:var(--c-muted);font-size:12px}
#dsh-console .dsh-card-visibility{display:inline-flex;align-items:center;gap:4px;flex:none;padding:3px 8px;border-radius:999px;color:var(--c-accent);background:color-mix(in srgb,var(--c-accent) 10%,transparent);font-size:11.5px}
#dsh-console .dsh-card-visibility.private{color:var(--c-muted);background:var(--c-hover)}
#dsh-console .dsh-card-desc{margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--c-muted);font-size:12.5px;line-height:1.6;word-break:break-word}
#dsh-console .dsh-card-foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:8px;color:var(--c-muted);font-size:11.5px}
#dsh-console .dsh-card-meta{display:flex;flex-direction:column;gap:4px;min-width:0}
#dsh-console .dsh-card-meta span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-console .dsh-card-actions{display:flex;align-items:center;gap:10px;flex:none}
#dsh-console .dsh-card-actions [role="button"]{cursor:pointer}
#dsh-console .dsh-card-actions [role="button"]:hover{color:var(--c-fg)}
#dsh-console .dsh-card-actions [role="button"]:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px;border-radius:4px}
#dsh-console .dsh-card-delete{color:var(--c-error)}
#dsh-console .admin-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:28px;text-align:center;color:var(--c-muted);font-size:12.5px;border:1px dashed var(--c-border);border-radius:12px}
#dsh-console .admin-state.empty h2{margin:0;color:var(--c-fg);font-size:15px;font-weight:600}
#dsh-console .admin-state.empty p{margin:0 0 8px}
#dsh-console .admin-state.error{border-color:color-mix(in srgb,var(--c-error) 35%,transparent);color:var(--c-error);min-height:0;padding:12px 16px;align-items:flex-start;text-align:left}
#dsh-console .admin-hint.readonly{margin-left:auto}
#dsh-console .skill-files{display:flex;flex-direction:column;gap:8px}
#dsh-console .skill-files-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--c-muted)}
#dsh-console .skill-files-head>span:first-child{font-weight:600;color:var(--c-fg)}
#dsh-console .skill-files-actions{display:flex;gap:6px;margin-left:auto}
#dsh-console .skill-files-empty{margin:0;color:var(--c-muted);font-size:12px}
#dsh-console .skill-file-list{display:flex;flex-direction:column;gap:6px}
#dsh-console .skill-file-row{display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--c-border);border-radius:8px;font-size:12px}
#dsh-console .skill-file-row code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11.5px}
#dsh-console .skill-file-row span{flex:none;color:var(--c-muted);font-size:11.5px}
#dsh-console .skill-file-row.removed{opacity:.55}
#dsh-console .skill-file-row.removed code{text-decoration:line-through}
#dsh-console .admin-notice{max-width:1040px;width:100%;margin:0 auto;padding:10px 14px;border:1px solid color-mix(in srgb,var(--c-success) 35%,transparent);border-radius:10px;background:color-mix(in srgb,var(--c-success) 8%,transparent);color:var(--c-success);font-size:12.5px;word-break:break-all}
#dsh-console .admin-notice code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12.5px;padding:1px 5px;border-radius:5px;background:rgba(15,23,42,.08)}
#dsh-console .admin-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:1040px;width:100%;margin:0 auto}
#dsh-console .admin-toolbar input,#dsh-console .admin-toolbar select{height:32px;border-radius:8px;border:1px solid var(--c-border-strong);background:var(--c-bg);color:var(--c-fg);padding:0 10px;font:inherit;min-width:0;box-sizing:border-box}
#dsh-console .admin-toolbar input[type="search"]{width:200px;flex:none}
#dsh-console .admin-toolbar select{width:120px;flex:none}
#dsh-console .admin-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
#dsh-console .admin-table-wrap{max-width:1040px;width:100%;margin:0 auto;overflow:auto;border:1px solid var(--c-border);border-radius:12px;background:var(--c-bg)}
#dsh-console .admin-table{width:100%;border-collapse:collapse;font-size:12.5px}
#dsh-console .admin-table th,#dsh-console .admin-table td{padding:9px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--c-border)}
#dsh-console .admin-table th{color:var(--c-muted);font-weight:600;background:var(--c-side)}
#dsh-console .admin-table tr:last-child td{border-bottom:0}
#dsh-console .admin-table td.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11.5px}
#dsh-console .admin-table td.wrap{white-space:normal;word-break:break-all;min-width:180px}
#dsh-console .admin-table .row-actions{display:flex;align-items:center;gap:8px}
#dsh-console .admin-table .row-actions [role="button"]{cursor:pointer;color:var(--c-accent)}
#dsh-console .admin-table .row-actions [role="button"]:hover{text-decoration:underline}
#dsh-console .admin-table .row-actions [role="button"].danger{color:var(--c-error)}
#dsh-console .admin-table .row-actions [role="button"].muted{color:var(--c-muted)}
#dsh-console .admin-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11.5px;color:var(--c-muted);background:var(--c-hover)}
#dsh-console .admin-badge.admin{color:var(--c-accent);background:color-mix(in srgb,var(--c-accent) 10%,transparent)}
#dsh-console .admin-badge.off{color:var(--c-error);background:color-mix(in srgb,var(--c-error) 10%,transparent)}
#dsh-console .admin-pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;max-width:1040px;width:100%;margin:0 auto;color:var(--c-muted);font-size:12px}
#dsh-console .admin-pager button{height:28px}
@media (prefers-color-scheme:dark){
#dsh-console{--c-bg:#15161a;--c-side:#1a1b1f;--c-fg:#f3f4f6;--c-muted:#9aa0a6;--c-border:#2a2b31;--c-border-strong:#3a3b42;--c-hover:#23242a;--c-primary:#f3f4f6;--c-primary-fg:#111827;--c-accent:#6ea8fe;--c-error:#ff8a80;--c-success:#5dd58a}
}
@media (max-width:767px){
/* 和设置页一样：窄屏收紧成上导航、下内容。 */
#dsh-console{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
#dsh-console-rail{padding:calc(16px + var(--dsh-frame-top-clearance,0px)) 0 8px;background:transparent}
#dsh-console-rail-title{padding:0 16px 8px}
#dsh-console-nav{flex-direction:row;gap:4px;padding:0 16px;overflow:auto hidden}
#dsh-console-nav button{flex:1 0 auto;justify-content:center;min-width:108px}
#dsh-console .admin-page-main{grid-column:1;grid-row:2;padding:16px 16px 32px}
#dsh-console .admin-page-main-head{flex-direction:column}
#dsh-console .dsh-card-grid{grid-template-columns:1fr}
}
</style>
<aside id="dsh-console-rail">
<div id="dsh-console-rail-title">管理</div>
<nav id="dsh-console-nav" role="tablist" aria-label="管理"></nav>
</aside>
<main class="admin-page-main">
<div class="admin-page-main-head">
<div>
<h1 id="dsh-console-title">用户管理</h1>
<p id="dsh-console-subtitle"></p>
</div>
<div class="admin-actions">
<button id="dsh-console-return" class="admin-button" type="button" hidden><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>返回列表</button>
<button id="dsh-console-refresh" class="admin-button" type="button">刷新</button>
<button id="dsh-console-create" class="admin-button primary" type="button">＋ 新建用户</button>
<button id="dsh-console-save" class="admin-button primary" type="button" hidden>保存</button>
<button id="dsh-console-back" class="admin-button small admin-close" type="button" title="返回对话" aria-label="返回对话"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
</div>
</div>
<div id="dsh-console-error" class="admin-state error" hidden></div>
<div id="dsh-console-notice" class="admin-notice" hidden></div>
<div id="dsh-console-body"></div>
</main>
</div>`

export function platformConsole(): string {
  // 视图清单只有一份：服务端注入成 JS 字面量，浏览器端不再硬编码菜单项。
  const runtime = RUNTIME.replace('__CONSOLE_VIEWS__', JSON.stringify(CONSOLE_VIEWS))
  return `${MARKUP}\n<script>\n${runtime}\n</script>`
}
