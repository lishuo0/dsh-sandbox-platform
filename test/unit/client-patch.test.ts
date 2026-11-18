import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  patchConversation,
  patchDeliverables,
  patchDshContext,
  patchPluginResponse,
  patchSettingsGeneral,
  patchSettingsModels,
} from '../../src/client/patch.js'
import { clientPackages } from '../../src/client/roster.js'

/**
 * 设置页的「打开配置文件」按钮由上游按回环地址判断注册；平台把它改成永假。
 * 直接读已安装的上游构建产物，升级 DSH 时先在这里失败。
 */

const require = createRequire(import.meta.url)
const MARKER = 'isLoopback?new SettingsDocumentStore('
const HINT = '开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换'
const CONTEXT_DEFAULT = 'status:`loading`,placement:`all`'
const CONTEXT_RESOLVE =
  'function Tg(e){return{tab:e===`all`||e===`tab`,sidebar:e===`all`||e===`sidebar`}}'
const WELCOME_NOTICE_REGISTRATION =
  'if(!(`dshDesktop`in globalThis))ctx.slots.inject(`settings.onboarding`,()=>ctx.slots.register({name:`settings.onboarding`,id:`welcome-notice`,order:-100,inject:welcomeInjected},WelcomeNotice));'
const CONTEXT_DESKTOP_PROMO =
  'promotion:{zh:`DeepSeek Harness桌面端现已发布!`,en:`DeepSeek Harness desktop app is now available!`},'
const PRESENT_HOST_READ =
  'async readHost(signal){let host=`error`;try{const response=await fetch(PRESENT_HOST_ROUTE,{signal});if(response.ok){const value=await response.json();if(isPresentedHost(value))host=value}}catch{host=`error`}if(!signal.aborted)this.host.set(host)}'
const PRESENT_UNAVAILABLE_HINT = 'host!==null&&host!==`error`&&!host.available&&'
const DESKTOP_CHANNEL_REGISTRATION =
  'const channelBridge=carrier?.protocolVersion===1?carrier.updates?.channels:void 0;if(channelBridge!==void 0){const channel=new DesktopChannelSource(channelBridge);ctx.effect(()=>()=>{channel.dispose()},`ui-settings-general: desktop channel`);ctx.slots.inject(`settings.general.item`,()=>ctx.slots.register({name:`settings.general.item`,id:`desktop-update-channel`,order:95,locale:NS,inject:()=>({hooks:{channel:channel.store},select:value=>channel.select(value)})},DesktopChannelRow));ctx.slots.inject(`shell.overlay`,()=>ctx.slots.register({name:`shell.overlay`,id:`desktop-channel-toast`,locale:NS,inject:()=>({hooks:{channel:channel.store},dismiss:sequence=>{channel.dismissNotice(sequence)},openConfiguration:()=>{desktopUpdate.open()}})},DesktopChannelToast))}'
const DESKTOP_UPDATE_BADGE_REGISTRATION =
  'ctx.slots.inject(`sidebar.toggle.badge`,()=>ctx.slots.register({name:`sidebar.toggle.badge`,locale:NS,inject:()=>({hooks:{desktopUpdate:desktopUpdate.store,connectionState:connection.state}})},DesktopUpdateBadge));'

describe('设置页修补', () => {
  it('把回环判断改成永假', () => {
    const source = 'const d=ctx.remote.$host.isLoopback?new SettingsDocumentStore(ctx,x):void 0;'
    const patched = patchSettingsGeneral(source)
    expect(patched).toContain('isLoopback&&false?new SettingsDocumentStore(')
    expect(patched).not.toContain('$host.isLoopback?')
  })

  it('去掉开发者工具说明里的预设切换承诺', () => {
    expect(patchSettingsGeneral(`{description:${HINT}}`)).toBe('{description:开启后，显示轨迹和本轮代码差异}')
  })

  it('删掉桌面更新通道与侧栏更新角标注册', () => {
    const source = `a;${DESKTOP_CHANNEL_REGISTRATION}${DESKTOP_UPDATE_BADGE_REGISTRATION}b`
    expect(patchSettingsGeneral(source)).toBe('a;b')
  })

  it('不认识的包原样返回', () => {
    const source = 'const x=1'
    expect(patchSettingsGeneral(source)).toBe(source)
  })

  it('已安装的 settings-general 构建产物仍带标记', () => {
    const file = require.resolve('@deepseek-ai/dsh-client-ui-settings-general/client')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain(MARKER)
    expect(source).toContain(HINT)
    expect(source).toContain(DESKTOP_CHANNEL_REGISTRATION)
    expect(source).toContain(DESKTOP_UPDATE_BADGE_REGISTRATION)
    const patched = patchSettingsGeneral(source)
    expect(patched).not.toContain(`.${MARKER}`)
    expect(patched).not.toContain(HINT)
    expect(patched).not.toContain(DESKTOP_CHANNEL_REGISTRATION)
    expect(patched).not.toContain(DESKTOP_UPDATE_BADGE_REGISTRATION)
  })

  it('只改 JavaScript 批量包，HEAD 与非脚本原样放行', async () => {
    const js = () => new Response(`ctx.remote.$host.${MARKER}ctx,x)`, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
    const patched = await patchPluginResponse(js(), 'GET')
    expect(await patched.text()).toContain('isLoopback&&false?new SettingsDocumentStore(')

    const head = await patchPluginResponse(js(), 'HEAD')
    expect(head.headers.get('content-type')).toContain('javascript')

    const sourceMap = new Response('{"version":3}', { headers: { 'content-type': 'application/json' } })
    expect(await patchPluginResponse(sourceMap, 'GET')).toBe(sourceMap)
  })
})

describe('dsh-context 右侧栏入口修补', () => {
  it('默认 placement 改为 tab，并关掉 sidebar 解析', () => {
    const source = `${CONTEXT_DEFAULT};${CONTEXT_RESOLVE}`
    const patched = patchDshContext(source)
    expect(patched).toContain('status:`loading`,placement:`tab`')
    expect(patched).toContain('sidebar:!1')
    expect(patched).not.toContain(CONTEXT_DEFAULT)
    expect(patched).not.toContain(CONTEXT_RESOLVE)
  })

  it('已安装的 dsh-context 构建产物仍带标记', () => {
    const file = require.resolve('dsh-context/client')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain(CONTEXT_DEFAULT)
    expect(source).toContain(CONTEXT_RESOLVE)
    const patched = patchDshContext(source)
    expect(patched).not.toContain(CONTEXT_DEFAULT)
    expect(patched).toContain('sidebar:!1')
  })
})

describe('预览版说明欢迎条修补', () => {
  it('删掉欢迎条注册，同时保留设置页本身', () => {
    const source = `before;${WELCOME_NOTICE_REGISTRATION}after`
    const patched = patchSettingsModels(source)
    expect(patched).toBe('before;after')
    expect(patched).not.toContain('welcome-notice')
  })

  it('已安装的 settings-models 构建产物仍带标记', () => {
    const file = require.resolve('@deepseek-ai/dsh-client-ui-settings-models/client')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain(WELCOME_NOTICE_REGISTRATION)
    expect(patchSettingsModels(source)).not.toContain(WELCOME_NOTICE_REGISTRATION)
  })

  it('对 models 包走 /plugins 响应时一并生效', async () => {
    const response = new Response(`x;${WELCOME_NOTICE_REGISTRATION}y`, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
    expect(await (await patchPluginResponse(response, 'GET')).text()).toBe('x;y')
  })

  it('对交付物与 context 包走 /plugins 响应时一并生效', async () => {
    const response = new Response(`a;${CONTEXT_DESKTOP_PROMO}b;${PRESENT_HOST_READ}c`, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
    const source = await (await patchPluginResponse(response, 'GET')).text()
    expect(source).not.toContain('桌面端现已发布')
    expect(source).not.toContain('fetch(PRESENT_HOST_ROUTE')
    expect(source).toContain('promotion:{zh:``,en:``},')
  })
})

describe('交付物卡片的桌面宿主修补', () => {
  it('不再请求 /api/present.host，宿主信息直接落成“无桌面”', () => {
    const patched = patchDeliverables(PRESENT_HOST_READ)
    expect(patched).toContain('available:!1')
    expect(patched).not.toContain('fetch(PRESENT_HOST_ROUTE')
    expect(patched).not.toContain('isPresentedHost')
  })

  it('不再渲染「此主机没有可用的桌面」提示', () => {
    const patched = patchDeliverables(`${PRESENT_UNAVAILABLE_HINT}(0,x.jsx)(\`span\`,{})`)
    expect(patched).toBe('!1&&(0,x.jsx)(`span`,{})')
  })

  it('已安装的 deliverables 构建产物仍带标记', () => {
    const file = require.resolve('@deepseek-ai/dsh-client-ui-deliverables/client')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain(PRESENT_HOST_READ)
    expect(source).toContain(PRESENT_UNAVAILABLE_HINT)
    const patched = patchDeliverables(source)
    expect(patched).not.toContain('fetch(PRESENT_HOST_ROUTE')
    expect(patched).not.toContain(PRESENT_UNAVAILABLE_HINT)
  })
})

describe('dsh-context 桌面推广修补', () => {
  it('清空推荐卡的桌面端发布文案', () => {
    const patched = patchDshContext(CONTEXT_DESKTOP_PROMO)
    expect(patched).toBe('promotion:{zh:``,en:``},')
  })

  it('已安装的 dsh-context 构建产物仍带标记', () => {
    const file = require.resolve('dsh-context/client')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain(CONTEXT_DESKTOP_PROMO)
    expect(patchDshContext(source)).not.toContain(CONTEXT_DESKTOP_PROMO)
    expect(patchDshContext(source)).toContain('promotion:{zh:``,en:``},')
  })
})

describe('会话页预览版徽章修补', () => {
  const HERO_PREVIEW_BADGE =
    '(0,react_jsx_runtime.jsx)(`span`,{className:HeroShell_module_css_default.previewBadge,children:t(`hero.preview`)})'

  it('去掉 hero 上的预览版徽章节点', () => {
    expect(patchConversation(`a;${HERO_PREVIEW_BADGE};b`)).toBe('a;null;b')
  })

  it('已安装的 conversation 构建产物仍带标记', () => {
    const file = require.resolve('@deepseek-ai/dsh-client-ui-conversation/client')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain(HERO_PREVIEW_BADGE)
    expect(patchConversation(source)).not.toContain(HERO_PREVIEW_BADGE)
  })

  it('对 conversation 包走 /plugins 响应时一并生效', async () => {
    const response = new Response(`x;${HERO_PREVIEW_BADGE};y`, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
    expect(await (await patchPluginResponse(response, 'GET')).text()).toBe('x;null;y')
  })
})

describe('客户端启动图', () => {
  it('不再装 Agent 预设客户端包', () => {
    expect(clientPackages).not.toContain('@deepseek-ai/dsh-client-ui-agent-preset')
  })

  it('仍装设置外壳，修补才有的放矢', () => {
    expect(clientPackages).toContain('@deepseek-ai/dsh-client-ui-settings-general')
  })

  it('仍装 dsh-context，右侧栏入口靠修补关掉', () => {
    expect(clientPackages).toContain('dsh-context')
  })
})
