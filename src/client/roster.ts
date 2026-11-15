/**
 * 平台要装进启动图的 DSH 客户端包。
 *
 * 这些是浏览器侧插件，不是 `dsh web` 宿主。会话、侧边栏、文件树、对话和输入框
 * 都从这里来。宿主半侧在平台上等不到 Agent 服务时保持挂起，浏览器加载的是各包的 client 包。
 */

/** 启动图的种子。缺了其中某个包，客户端进不了主界面，或文件树、输入框、模型选择起不来。 */
export const clientPackages = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-shortcuts',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-file-drag',
  '@deepseek-ai/dsh-client-ui-file-actions',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-context-menu',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-message-quotes',
  '@deepseek-ai/dsh-cordis-client-runner',
] as const

/**
 * 启动图里必须出现的包。前七个缺了，客户端会拒绝进入主界面。
 * 后五个是这份产品要接上的文件树、对话、输入框、模型选择和技能。
 */
export const requiredClientPackages = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-skill',
] as const
