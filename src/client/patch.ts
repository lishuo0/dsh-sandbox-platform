/**
 * 客户端包的平台侧修补。
 *
 * `@deepseek-ai/dsh-client-ui-settings-general` 在“页面就是本机回环地址”时
 * 会挂一个「打开配置文件」按钮，调用脑宿主的 `settings.openSettingsDocument`。
 * 平台里配置归平台管，成员不该打开脑宿主的配置文件，所以把这个判断改成
 * `false`，让按钮永远不注册。通用设置里「开发者工具」的说明还承诺能切换
 * Agent 预设；平台不装预设客户端包，这段文案一并去掉。同一包里的「更新通道」
 * 设置行、桌面通道通知条和侧栏桌面更新角标只对桌面壳有意义（浏览器里没有
 * `globalThis.dshDesktop`，本来也不显示），直接把注册删掉，交付包不再携带。
 *
 * `dsh-context` 默认会在右侧栏指南页挂「上下文」入口（placement=`all`）。
 * 平台只要会话顶栏的「上下文」标签，右侧栏入口关掉。
 *
 * `@deepseek-ai/dsh-client-ui-settings-models` 在没有桌面壳时会在新建会话页挂
 * 「预览版说明」欢迎条；它的“已确认”状态要写进桌面宿主配置文档，web 平台没有
 * 也不该有这份文档，于是欢迎条一出现就是「暂时无法保存确认状态」，而且点「继续」
 * 永远失败。web 平台不需要这个欢迎条，直接不注册。
 *
 * 交付物卡片的「打开所在文件夹 / 在文件管理器中显示」要读桌面宿主
 * （`/api/present.host`），web 平台没有这条路由，卡片会挂“无法读取主机桌面信息”。
 * 文件本来就在沙箱里，浏览器侧只保留「在侧边栏预览」，不再读取宿主信息。
 *
 * `dsh-context` 的推荐卡带着「桌面端现已发布」推广，web 平台里指向不存在的东西，
 * 一并清空。
 *
 * 这是对上游构建产物的文本修补：上游改写法时这里会静默失效。
 * `test/unit/client-patch.test.ts` 盯着标记，升级 DSH 时先跑单测。
 */

const DOCUMENT_ACTION = 'isLoopback?new SettingsDocumentStore('
const DEVELOPER_TOOLS_HINT = '开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换'
const DEVELOPER_TOOLS_HINT_PATCHED = '开启后，显示轨迹和本轮代码差异'

/** settings-general：桌面端的更新通道选择与通道通知条。 */
const DESKTOP_CHANNEL_REGISTRATION =
  'const channelBridge=carrier?.protocolVersion===1?carrier.updates?.channels:void 0;if(channelBridge!==void 0){const channel=new DesktopChannelSource(channelBridge);ctx.effect(()=>()=>{channel.dispose()},`ui-settings-general: desktop channel`);ctx.slots.inject(`settings.general.item`,()=>ctx.slots.register({name:`settings.general.item`,id:`desktop-update-channel`,order:95,locale:NS,inject:()=>({hooks:{channel:channel.store},select:value=>channel.select(value)})},DesktopChannelRow));ctx.slots.inject(`shell.overlay`,()=>ctx.slots.register({name:`shell.overlay`,id:`desktop-channel-toast`,locale:NS,inject:()=>({hooks:{channel:channel.store},dismiss:sequence=>{channel.dismissNotice(sequence)},openConfiguration:()=>{desktopUpdate.open()}})},DesktopChannelToast))}'

/** settings-general：侧栏的桌面更新角标。 */
const DESKTOP_UPDATE_BADGE_REGISTRATION =
  'ctx.slots.inject(`sidebar.toggle.badge`,()=>ctx.slots.register({name:`sidebar.toggle.badge`,locale:NS,inject:()=>({hooks:{desktopUpdate:desktopUpdate.store,connectionState:connection.state}})},DesktopUpdateBadge));'

/** settings-models：web 平台不注册的「预览版说明」欢迎条。 */
const WELCOME_NOTICE_REGISTRATION =
  'if(!(`dshDesktop`in globalThis))ctx.slots.inject(`settings.onboarding`,()=>ctx.slots.register({name:`settings.onboarding`,id:`welcome-notice`,order:-100,inject:welcomeInjected},WelcomeNotice));'

/** dsh-context：默认 placement 与入口解析。 */
const CONTEXT_PLACEMENT_DEFAULT = 'status:`loading`,placement:`all`'
const CONTEXT_PLACEMENT_DEFAULT_PATCHED = 'status:`loading`,placement:`tab`'
const CONTEXT_PLACEMENT_RESOLVE =
  'function Tg(e){return{tab:e===`all`||e===`tab`,sidebar:e===`all`||e===`sidebar`}}'

/** dsh-context：推荐卡里的桌面端发布推广。 */
const CONTEXT_DESKTOP_PROMO =
  'promotion:{zh:`DeepSeek Harness桌面端现已发布!`,en:`DeepSeek Harness desktop app is now available!`},'
const CONTEXT_DESKTOP_PROMO_PATCHED = 'promotion:{zh:``,en:``},'

/** deliverables：桌面宿主信息读取与“没有桌面”提示。 */
const PRESENT_HOST_READ =
  'async readHost(signal){let host=`error`;try{const response=await fetch(PRESENT_HOST_ROUTE,{signal});if(response.ok){const value=await response.json();if(isPresentedHost(value))host=value}}catch{host=`error`}if(!signal.aborted)this.host.set(host)}'
const PRESENT_HOST_READ_PATCHED =
  'async readHost(signal){if(!signal.aborted)this.host.set({name:`web`,available:!1,fileManager:null})}'
const PRESENT_UNAVAILABLE_HINT = 'host!==null&&host!==`error`&&!host.available&&'
const PRESENT_UNAVAILABLE_HINT_PATCHED = '!1&&'
const CONTEXT_PLACEMENT_RESOLVE_PATCHED =
  'function Tg(e){return{tab:e===`all`||e===`tab`,sidebar:!1}}'

/** 把设置页「打开配置文件」按钮的注册条件改成永假，并去掉预设切换的旧文案。 */
export function patchSettingsGeneral(source: string): string {
  let patched = source
  if (patched.includes(`.${DOCUMENT_ACTION}`)) {
    patched = patched.replaceAll(`.${DOCUMENT_ACTION}`, `.isLoopback&&false?new SettingsDocumentStore(`)
  }
  if (patched.includes(DEVELOPER_TOOLS_HINT)) {
    patched = patched.replaceAll(DEVELOPER_TOOLS_HINT, DEVELOPER_TOOLS_HINT_PATCHED)
  }
  if (patched.includes(DESKTOP_CHANNEL_REGISTRATION)) {
    patched = patched.replaceAll(DESKTOP_CHANNEL_REGISTRATION, '')
  }
  if (patched.includes(DESKTOP_UPDATE_BADGE_REGISTRATION)) {
    patched = patched.replaceAll(DESKTOP_UPDATE_BADGE_REGISTRATION, '')
  }
  return patched
}

/** 不注册桌面端的「预览版说明」欢迎条（它的确认状态写不进 web 平台）。 */
export function patchSettingsModels(source: string): string {
  return source.replaceAll(WELCOME_NOTICE_REGISTRATION, '')
}

/** 去掉右侧栏「上下文」入口，保留会话顶栏标签；推荐卡去掉桌面端推广。 */
export function patchDshContext(source: string): string {
  let patched = source
  if (patched.includes(CONTEXT_PLACEMENT_DEFAULT)) {
    patched = patched.replaceAll(CONTEXT_PLACEMENT_DEFAULT, CONTEXT_PLACEMENT_DEFAULT_PATCHED)
  }
  if (patched.includes(CONTEXT_PLACEMENT_RESOLVE)) {
    patched = patched.replaceAll(CONTEXT_PLACEMENT_RESOLVE, CONTEXT_PLACEMENT_RESOLVE_PATCHED)
  }
  if (patched.includes(CONTEXT_DESKTOP_PROMO)) {
    patched = patched.replaceAll(CONTEXT_DESKTOP_PROMO, CONTEXT_DESKTOP_PROMO_PATCHED)
  }
  return patched
}

/** 交付物卡不再读取桌面宿主：web 没有可打开的外部文件管理器。 */
export function patchDeliverables(source: string): string {
  let patched = source
  if (patched.includes(PRESENT_HOST_READ)) {
    patched = patched.replaceAll(PRESENT_HOST_READ, PRESENT_HOST_READ_PATCHED)
  }
  if (patched.includes(PRESENT_UNAVAILABLE_HINT)) {
    patched = patched.replaceAll(PRESENT_UNAVAILABLE_HINT, PRESENT_UNAVAILABLE_HINT_PATCHED)
  }
  return patched
}

/** 对 `/plugins` 返回的 JavaScript 批量包应用修补；其余响应原样返回。 */
export async function patchPluginResponse(response: Response, method: string): Promise<Response> {
  if (method === 'HEAD') return response
  if (response.status !== 200) return response
  if (!(response.headers.get('content-type') ?? '').includes('javascript')) return response
  const source = await response.text()
  const patched = patchDeliverables(patchSettingsModels(patchDshContext(patchSettingsGeneral(source))))
  return new Response(patched, { status: response.status, headers: response.headers })
}
