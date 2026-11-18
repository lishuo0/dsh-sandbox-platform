/**
 * 设置 → 模型：平台自有页。
 *
 * 不引入上游 settings-models 包；视觉按 ModelsSection.module.css 抄
 * 行卡片 / 编辑器 / 模型行 / 虚线添加按钮。数据读写
 * `/dsh-api/platform/v1/settings/model`，落到 `dsh_user_model_providers` /
 * `dsh_user_credentials`（一成员多提供商）。
 */

import { readFileSync } from 'node:fs'

const RUNTIME = readFileSync(new URL('./model-settings-client.js', import.meta.url), 'utf8')

const MARKUP = `<div id="dsh-platform-models" hidden data-open="false" aria-hidden="true">
<style>
#dsh-platform-models{
  --pm-label: var(--dsw-alias-label-primary, #0f1115);
  --pm-label-2: var(--dsw-alias-label-secondary, #5b616a);
  --pm-label-3: var(--dsw-alias-label-tertiary, #8a8f98);
  --pm-label-dim: var(--dsw-alias-label-dimmed, #a0a4ab);
  --pm-border: var(--dsw-alias-border-l3, rgba(15,17,21,.12));
  --pm-border-soft: var(--dsw-alias-border-l4, rgba(15,17,21,.08));
  --pm-border-l2: var(--dsw-alias-border-l2, rgba(15,17,21,.16));
  --pm-card: var(--dsw-alias-settings-card-fill, #fff);
  --pm-card-stroke: var(--dsw-alias-settings-card-stroke, rgba(15,17,21,.08));
  --pm-module: var(--dsw-alias-bg-module-platform, #f6f7f9);
  --pm-input-bg: var(--dsw-alias-bg-layer-1, #fff);
  --pm-primary: var(--dsw-alias-button-primary-fill, #0f1115);
  --pm-primary-fg: var(--dsw-alias-label-primary-foreground, #fff);
  --pm-primary-hover: var(--dsw-alias-button-primary-hover, #2a2e36);
  --pm-hover: var(--dsw-alias-interactive-bg-hover, rgba(15,17,21,.06));
  --pm-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, rgba(15,17,21,.08));
  --pm-hover-danger: var(--dsw-alias-interactive-bg-hover-danger, rgba(209,36,47,.08));
  --pm-danger: var(--dsw-alias-state-error-primary, #d1242f);
  --pm-ok: var(--dsw-alias-state-success-primary, #1a7f37);
  --pm-focus: var(--dsw-alias-state-business-primary, #0969da);
  --pm-radius-xl: var(--dsw-radius-xl, 14px);
  --pm-radius-lg: var(--dsw-radius-lg, 12px);
  --pm-radius-md: var(--dsw-radius-md, 10px);
  --pm-radius-sm: var(--dsw-radius-sm, 8px);
  --pm-radius-xs: var(--dsw-radius-xs, 6px);
  box-sizing: border-box;
  width: 100%;
  max-width: 720px;
  padding: 8px 4px 28px;
  color: var(--pm-label);
  font: 14px/22px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
#dsh-platform-models[hidden]{display:none!important}
#dsh-platform-models *,#dsh-platform-models *::before,#dsh-platform-models *::after{box-sizing:border-box}
#dsh-platform-models .pm-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--pm-label)}
#dsh-platform-models .pm-intro{margin:0;font-size:14px;line-height:22px;color:var(--pm-label-3)}
#dsh-platform-models .pm-saved{margin:0;font-size:12px;line-height:18px;color:var(--pm-ok)}
#dsh-platform-models .pm-error{margin:0;font-size:12px;line-height:18px;color:var(--pm-danger)}
#dsh-platform-models .pm-rows{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
#dsh-platform-models .pm-row-card{
  border:0.5px solid var(--pm-card-stroke);
  background:var(--pm-card);
  border-radius:var(--pm-radius-xl);
  padding:12px 14px;
  display:flex;flex-direction:column;gap:12px;
}
#dsh-platform-models .pm-row-head{display:flex;align-items:center;gap:10px}
#dsh-platform-models .pm-row-identity{display:inline-flex;align-items:center;gap:6px;min-width:0}
#dsh-platform-models .pm-row-name{font-size:14px;line-height:22px;font-weight:500;color:var(--pm-label)}
#dsh-platform-models .pm-row-tag{
  flex:none;padding:1px 6px;border:0.5px solid var(--pm-border);border-radius:var(--pm-radius-xs);
  font-size:11px;line-height:16px;color:var(--pm-label-2);
}
#dsh-platform-models .pm-dot{
  box-sizing:border-box;display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;
  background:var(--pm-danger);
}
#dsh-platform-models .pm-dot[data-ok="true"]{background:var(--pm-ok)}
#dsh-platform-models .pm-row-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}
#dsh-platform-models .pm-btn{
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;
  height:36px;padding:0 14px;border:none;border-radius:var(--pm-radius-md);
  font:inherit;font-size:14px;line-height:22px;cursor:pointer;
}
#dsh-platform-models .pm-btn:disabled{opacity:.4;cursor:default}
#dsh-platform-models .pm-btn-primary{background:var(--pm-primary);color:var(--pm-primary-fg)}
#dsh-platform-models .pm-btn-primary:hover:not(:disabled){background:var(--pm-primary-hover)}
#dsh-platform-models .pm-btn-secondary{
  border:0.5px solid var(--pm-border);background:transparent;color:var(--pm-label);
}
#dsh-platform-models .pm-btn-secondary:hover:not(:disabled){background:var(--pm-hover-solid)}
#dsh-platform-models .pm-btn-danger{background:transparent;color:var(--pm-danger)}
#dsh-platform-models .pm-btn-danger:hover:not(:disabled){background:var(--pm-hover-danger)}
#dsh-platform-models .pm-row-actions .pm-btn{
  height:28px;padding:0 10px;border-radius:var(--pm-radius-sm);font-size:12px;line-height:18px;
}
#dsh-platform-models .pm-editor{
  border-radius:var(--pm-radius-lg);background:var(--pm-module);padding:14px 16px;
  display:flex;flex-direction:column;gap:14px;
}
#dsh-platform-models .pm-editor-header{display:flex;align-items:baseline;gap:8px}
#dsh-platform-models .pm-editor-title{font-size:14px;line-height:22px;font-weight:500;color:var(--pm-label)}
#dsh-platform-models .pm-hint{margin:0;font-size:12px;line-height:18px;color:var(--pm-label-3)}
#dsh-platform-models .pm-field{display:flex;flex-direction:column;gap:6px}
#dsh-platform-models .pm-label{font-size:12px;line-height:18px;font-weight:500;color:var(--pm-label-2)}
#dsh-platform-models .pm-input{
  width:100%;height:32px;padding:0 10px;
  border:0.5px solid var(--pm-border-soft);border-radius:var(--pm-radius-md);
  background:var(--pm-input-bg);color:var(--pm-label);font:inherit;font-size:14px;line-height:22px;
}
#dsh-platform-models .pm-input:focus{outline:none;border-color:var(--pm-focus)}
#dsh-platform-models .pm-input::placeholder{color:var(--pm-label-dim)}
#dsh-platform-models .pm-key{position:relative}
#dsh-platform-models .pm-key .pm-input{padding-right:40px}
#dsh-platform-models .pm-key-toggle{
  position:absolute;inset:1px 1px 1px auto;width:32px;border:0;border-radius:var(--pm-radius-md);
  background:transparent;color:var(--pm-label-2);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
}
#dsh-platform-models .pm-key-toggle:hover{color:var(--pm-label)}
#dsh-platform-models .pm-catalog{
  display:flex;flex-direction:column;gap:10px;padding-top:12px;
  border-top:0.5px solid var(--pm-border-l2);
}
#dsh-platform-models .pm-catalog-title{font-size:12px;line-height:18px;font-weight:500;color:var(--pm-label-2)}
#dsh-platform-models .pm-catalog-meta{margin:0;font-size:12px;line-height:18px;color:var(--pm-label-3)}
#dsh-platform-models .pm-model-list{display:flex;flex-direction:column;gap:8px}
#dsh-platform-models .pm-model-list-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
#dsh-platform-models .pm-model-entry{
  border:0.5px solid var(--pm-border-soft);border-radius:var(--pm-radius-lg);padding:6px;
}
#dsh-platform-models .pm-model-row{display:flex;align-items:center;gap:6px}
#dsh-platform-models .pm-model-row .pm-input{flex:1 1 auto;min-width:0}
#dsh-platform-models .pm-icon-btn{
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border:none;border-radius:var(--pm-radius-sm);
  background:transparent;color:var(--pm-label-3);cursor:pointer;flex:none;
}
#dsh-platform-models .pm-icon-btn:hover{background:var(--pm-hover);color:var(--pm-label)}
#dsh-platform-models .pm-icon-btn-danger:hover{background:var(--pm-hover-danger);color:var(--pm-danger)}
#dsh-platform-models .pm-model-empty{
  margin:0;padding:12px;border:1px dashed var(--pm-border);border-radius:var(--pm-radius-lg);
  text-align:center;color:var(--pm-label-3);font-size:12px;line-height:18px;
}
#dsh-platform-models .pm-add-model{
  box-sizing:border-box;align-self:flex-start;display:inline-flex;align-items:center;gap:4px;
  height:28px;padding:0 10px;border:0.5px solid var(--pm-border);border-radius:var(--pm-radius-sm);
  background:transparent;color:var(--pm-label);font:inherit;font-size:12px;line-height:18px;cursor:pointer;
}
#dsh-platform-models .pm-add-model:hover{background:var(--pm-hover)}
#dsh-platform-models .pm-editor-actions{display:flex;justify-content:flex-end;gap:8px}
#dsh-platform-models .pm-add-block{display:flex;flex-direction:column;gap:12px;margin-top:20px}
#dsh-platform-models .pm-add-btn{
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  flex:1 1 0;min-width:180px;height:44px;padding:0 14px;
  border:1px dashed var(--pm-border);border-radius:var(--pm-radius-lg);
  background:transparent;color:var(--pm-label);font:inherit;font-size:14px;line-height:22px;cursor:pointer;
}
#dsh-platform-models .pm-add-btn:hover{background:var(--pm-hover)}
#dsh-platform-models .pm-add-card{
  border-radius:var(--pm-radius-lg);background:var(--pm-module);padding:14px 16px;
  display:flex;flex-direction:column;gap:14px;list-style:none;
}
#dsh-platform-models .pm-add-card .pm-editor{background:none;padding:0}
#dsh-platform-models .pm-hidden{display:none!important}
@media (prefers-color-scheme: dark){
  #dsh-platform-models{
    --pm-label:#f3f4f6;--pm-label-2:#c2c7ce;--pm-label-3:#9aa0a6;--pm-label-dim:#7a8088;
    --pm-border:rgba(255,255,255,.14);--pm-border-soft:rgba(255,255,255,.10);--pm-border-l2:rgba(255,255,255,.18);
    --pm-card:#1c1d21;--pm-card-stroke:rgba(255,255,255,.08);--pm-module:#15161a;
    --pm-input-bg:#121318;--pm-primary:#f3f4f6;--pm-primary-fg:#111827;--pm-primary-hover:#ffffff;
    --pm-hover:rgba(255,255,255,.08);--pm-hover-solid:rgba(255,255,255,.10);
  }
}
</style>
<section class="pm-section" aria-label="模型设置">
  <h2 class="pm-title">模型</h2>
  <p class="pm-intro">填入各提供商的 API 密钥即可使用其模型。配置保存在平台数据库，按登录成员生效。</p>
  <p id="dsh-pm-saved" class="pm-saved" hidden role="status" aria-live="polite"></p>
  <p id="dsh-pm-error" class="pm-error" hidden role="alert"></p>
  <ul id="dsh-pm-rows" class="pm-rows"></ul>
  <div class="pm-add-block">
    <button id="dsh-pm-add" class="pm-add-btn" type="button">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      添加模型 API
    </button>
    <div id="dsh-pm-add-card" class="pm-add-card pm-hidden" hidden>
      <div class="pm-editor-header"><span class="pm-editor-title">自定义模型 API</span></div>
      <p class="pm-hint">连接中转站、自部署服务或其他兼容 OpenAI 协议的接口，需填写 API 地址、密钥和模型。</p>
      <div id="dsh-pm-add-editor"></div>
    </div>
  </div>
</section>
<template id="dsh-pm-editor-tpl">
  <form class="pm-editor" novalidate>
    <label class="pm-field">
      <span class="pm-label">API 地址</span>
      <input class="pm-input" name="baseUrl" type="url" required placeholder="https://api.example.com/v1" autocomplete="off">
    </label>
    <label class="pm-field">
      <span class="pm-label">API 密钥</span>
      <span class="pm-key">
        <input class="pm-input" name="apiKey" type="password" autocomplete="new-password" placeholder="sk-...">
        <button class="pm-key-toggle" type="button" aria-label="显示密钥" aria-pressed="false">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8ZM10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z"/></svg>
        </button>
      </span>
      <span class="pm-key-hint pm-hint">密钥只存平台库，不会回显明文。</span>
    </label>
    <div class="pm-catalog">
      <div class="pm-model-list-head">
        <div>
          <div class="pm-catalog-title">模型列表</div>
          <p class="pm-catalog-meta">至少添加一个模型；默认模型取列表第一项。</p>
        </div>
        <button class="pm-add-model" type="button" data-action="add-model">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          添加模型
        </button>
      </div>
      <div class="pm-model-list" data-role="model-list"></div>
      <p class="pm-model-empty pm-hidden" data-role="model-empty">还没有模型，点击「添加模型」。</p>
    </div>
    <div class="pm-editor-actions">
      <button class="pm-btn pm-btn-secondary" type="button" data-action="cancel">取消</button>
      <button class="pm-btn pm-btn-primary" type="submit" data-action="save">应用</button>
    </div>
  </form>
</template>
</div>`

export function platformModelSettings(): string {
  return `${MARKUP}\n<script>\n${RUNTIME}\n</script>`
}
