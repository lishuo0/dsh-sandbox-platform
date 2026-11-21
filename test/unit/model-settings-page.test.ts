import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { platformModelSettings } from '../../src/client/model-settings.js'

/**
 * 设置 → 模型页。
 *
 * 真正跑一遍注入脚本：设置面板的导航决定模型页何时挂上去、何时让开。
 * 曾经的问题是切到「通用设置」后，脚本因为「自己还挂在面板里」仍判成
 * 模型分区，把通用设置整块盖住——从外面看就是点了没反应。
 */

const script = readFileSync(new URL('../../src/client/model-settings-client.js', import.meta.url), 'utf8')

class FakeStyle {
  display
  removeProperty(name) {
    if (name === 'display') this.display = ''
  }
}

class FakeElement {
  constructor(tag, text = '') {
    this.tagName = tag.toUpperCase()
    this.text = text
    this.children = []
    this.childNodes = this.children
    this.parentElement = null
    this.attributes = {}
    this.classNames = new Set()
    this.style = new FakeStyle()
    this.dataset = {}
    this.hidden = false
    this.listeners = {}
    this.classList = {
      add: (name) => this.classNames.add(name),
      remove: (name) => this.classNames.delete(name),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classNames.has(name) : force
        if (next) this.classNames.add(name)
        else this.classNames.delete(name)
        return next
      },
      contains: (name) => this.classNames.has(name),
    }
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.text = value
    this.children = []
    this.childNodes = this.children
  }

  get className() {
    return [...this.classNames].join(' ')
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  removeAttribute(name) {
    delete this.attributes[name]
  }

  appendChild(child) {
    if (child.parentElement !== null) child.parentElement.removeChild(child)
    child.parentElement = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parentElement = null
    return child
  }

  contains(node) {
    for (let current = node; current !== null; current = current.parentElement) {
      if (current === this) return true
    }
    return false
  }

  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  }

  querySelectorAll(selector) {
    const tags = selector.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean)
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (tags.includes(child.tagName)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector(selector) {
    const test = (part) => (node) => {
      if (part === 'nav') return node.tagName === 'NAV'
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)
      if (attribute) {
        const [, name, value] = attribute
        return Object.hasOwn(node.attributes, name) && (value === undefined || node.attributes[name] === value)
      }
      return part.startsWith('.') && node.classNames.has(part.slice(1))
    }
    for (const part of selector.split(',').map((value) => value.trim())) {
      const matches = test(part)
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child)) return child
          const nested = walk(child)
          if (nested) return nested
        }
        return null
      }
      const hit = walk(this)
      if (hit) return hit
    }
    return null
  }
}

class FakeMutationObserver {
  static latest
  constructor(callback) {
    this.callback = callback
    FakeMutationObserver.latest = this
  }

  observe() {}
  fire(target) {
    this.callback([{ target }])
  }
}

/** 一套最小设置面板：导航栏 + 分区容器 + 上游模型区块。 */
function buildPanel() {
  const panel = new FakeElement('div')
  panel.attributes['data-shortcut-modal'] = 'settings'

  const nav = new FakeElement('nav')
  const modelsNav = new FakeElement('button', '模型')
  const generalNav = new FakeElement('button', '通用设置')
  modelsNav.attributes['aria-current'] = 'true'
  nav.appendChild(modelsNav)
  nav.appendChild(generalNav)
  panel.appendChild(nav)

  // 和真实壳一样：分区容器下先有一层分区根，说明文字再嵌在分区里。
  const options = new FakeElement('div')
  options.classNames.add('VOzbGW_options')
  panel.appendChild(options)

  const section = new FakeElement('div')
  options.appendChild(section)
  section.appendChild(new FakeElement('p', '填入各提供商的 API 密钥，即可使用其模型。'))

  return { panel, nav, modelsNav, generalNav, options, section }
}

function mountScript() {
  const view = buildPanel()
  const ids = new Map()
  for (const id of [
    'dsh-platform-models',
    'dsh-pm-rows',
    'dsh-pm-add',
    'dsh-pm-add-card',
    'dsh-pm-add-editor',
    'dsh-pm-editor-tpl',
    'dsh-pm-saved',
    'dsh-pm-error',
  ]) {
    ids.set(id, new FakeElement('div'))
  }
  ids.get('dsh-pm-editor-tpl').content = { firstElementChild: new FakeElement('form') }

  const body = new FakeElement('body')
  const document = {
    body,
    getElementById: (id) => ids.get(id) ?? null,
    querySelector: (selector) => (selector === '[data-shortcut-modal="settings"]' ? view.panel : null),
  }
  const window = { setTimeout, clearTimeout }
  const fetch = () => Promise.reject(new Error('offline in test'))

  new Function('window', 'document', 'MutationObserver', 'fetch', script)(window, document, FakeMutationObserver, fetch)
  return { ...view, body, root: ids.get('dsh-platform-models') }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 90))

/** 模拟点上某个分区：只有被点的那个导航项带 aria-current。 */
function select(view, target) {
  for (const nav of [view.modelsNav, view.generalNav]) {
    if (nav === target) nav.attributes['aria-current'] = 'true'
    else delete nav.attributes['aria-current']
  }
  FakeMutationObserver.latest.fire(target)
}

describe('模型设置页', () => {
  const html = platformModelSettings()

  it('协议类型和提交字段都随页面下发', () => {
    expect(html).toContain('name="api"')
    expect(html).toContain('value="openai-completions"')
    expect(html).toContain('value="openai-responses"')
    expect(html).toContain('value="anthropic-messages"')
    expect(html).toContain('value="google-generative-ai"')
    expect(script).toContain('api: protocolSelect ? protocolSelect.value')
  })

  it('上游分区的让位规则随页面下发', () => {
    // 分区容器挂属性、由规则整体藏起；逐节点改 style 会在 React 重渲染时闪。
    expect(html).toContain('[data-dsh-pm-host="true"]>:not(#dsh-platform-models)')
    expect(script).toContain("setAttribute('data-dsh-pm-host'")
  })

  it('停在模型分区时挂进面板，并让上游分区让位', () => {
    const view = mountScript()
    expect(view.root.parentElement).toBe(view.options)
    expect(view.root.hidden).toBe(false)
    expect(view.root.dataset.open).toBe('true')
    expect(view.options.attributes['data-dsh-pm-host']).toBe('true')
  })

  it('切到通用设置就摘下来放回 body，不再盖住通用内容', async () => {
    const view = mountScript()
    select(view, view.generalNav)
    await settle()

    expect(view.root.parentElement).toBe(view.body)
    expect(view.root.hidden).toBe(true)
    expect(view.root.dataset.open).toBe('false')
    expect(Object.hasOwn(view.options.attributes, 'data-dsh-pm-host')).toBe(false)
  })

  it('再切回模型分区仍然能重新挂上', async () => {
    const view = mountScript()
    select(view, view.generalNav)
    await settle()
    select(view, view.modelsNav)
    await settle()

    expect(view.root.parentElement).toBe(view.options)
    expect(view.root.hidden).toBe(false)
    expect(view.options.attributes['data-dsh-pm-host']).toBe('true')
  })

  it('上游模型区块被 React 卸载后，根节点也能收回来隐藏', async () => {
    const view = mountScript()
    view.options.removeChild(view.section)
    select(view, view.generalNav)
    await settle()

    expect(view.root.parentElement).toBe(view.body)
    expect(view.root.hidden).toBe(true)
  })

  it('反复同步不会让挂载点漂移（页面闪烁的根因）', async () => {
    const view = mountScript()
    for (let i = 0; i < 5; i += 1) {
      select(view, view.modelsNav)
      await settle()
      expect(view.root.parentElement).toBe(view.options)
    }
    expect(view.options.attributes['data-dsh-pm-host']).toBe('true')
  })
})
