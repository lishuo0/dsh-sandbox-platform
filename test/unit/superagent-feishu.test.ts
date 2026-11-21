import { describe, expect, it } from 'vitest'
import {
  feishuInbound,
  fetchChatPages,
  messageText,
  parseEvent,
  validAppId,
  withMentionNames,
  type FeishuEvent,
} from '../../src/modules/superagent/feishu.js'

/**
 * 飞书事件的归一化：只认成员发的消息，只认能判断的文本，
 * 并且要分清「这条是对机器人说的」还是群里的闲聊。
 */

const bot = 'ou_bot'

function event(overrides: { sender?: unknown; message?: Record<string, unknown> } = {}): unknown {
  return {
    sender: overrides.sender ?? { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我把登录页修一下' }),
      create_time: '1700000000000',
      ...(overrides.message ?? {}),
    },
  }
}

describe('文本提取', () => {
  it('纯文本取 text', () => {
    expect(messageText('text', JSON.stringify({ text: '你好' }))).toBe('你好')
  })

  it('富文本把标题和正文按行拼起来，忽略非文本节点', () => {
    const content = JSON.stringify({
      title: '今天的活',
      content: [
        [{ tag: 'text', text: '把' }, { tag: 'text', text: '登录页' }, { tag: 'a', text: '链接' }],
        [{ tag: 'text', text: '改一下' }],
      ],
    })
    expect(messageText('post', content)).toBe('今天的活\n把登录页\n改一下')
  })

  it('解析不了的内容退回原文；图片这类没有可判断的正文', () => {
    expect(messageText('text', '不是 JSON 但有字')).toBe('不是 JSON 但有字')
    expect(messageText('image', JSON.stringify({ image_key: 'img_v2_1' }))).toBeUndefined()
  })
})

describe('事件解析', () => {
  it('机器人自己和其它应用发的消息不触发', () => {
    expect(parseEvent(event({ sender: { sender_type: 'app', sender_id: { open_id: bot } } }), bot)).toBeUndefined()
  })

  it('群聊里没有 @ 机器人时不算点名', () => {
    const parsed = parseEvent(event(), bot)
    expect(parsed?.mentioned).toBe(false)
    expect(parsed?.direct).toBe(false)
  })

  it('@ 的是机器人本人时算点名，占位符换成名字', () => {
    const parsed = parseEvent(
      event({
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 修一下登录页' }),
          mentions: [{ key: '@_user_1', name: '小助手', id: { open_id: bot } }],
        },
      }),
      bot,
    )
    expect(parsed?.mentioned).toBe(true)
    expect(parsed?.text).toBe('@小助手 修一下登录页')
  })

  it('@ 的是别人时不算点名', () => {
    const parsed = parseEvent(
      event({
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 看一下' }),
          mentions: [{ key: '@_user_1', name: '小明', id: { open_id: 'ou_someone' } }],
        },
      }),
      bot,
    )
    expect(parsed?.mentioned).toBe(false)
  })

  it('认不出自己的 open_id 时退化为「有 @ 就算点名」', () => {
    const parsed = parseEvent(
      event({
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 看看' }),
          mentions: [{ key: '@_user_1', name: '某人', id: { open_id: 'ou_x' } }],
        },
      }),
      undefined,
    )
    expect(parsed?.mentioned).toBe(true)
  })

  it('单聊一律算对机器人说的，并带上话题根消息', () => {
    const parsed = parseEvent(
      event({
        message: {
          message_id: 'om_2',
          chat_id: 'oc_p2p',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '在吗' }),
          root_id: 'om_root',
        },
      }),
      bot,
    )
    expect(parsed?.direct).toBe(true)
    expect(parsed?.mentioned).toBe(true)
    expect(parsed?.rootId).toBe('om_root')
    expect(parsed?.at).toBe(new Date(1700000000000).toISOString())
  })

  it('缺关键字段或者没有正文就当没收到', () => {
    expect(parseEvent(null, bot)).toBeUndefined()
    expect(parseEvent({ sender: { sender_type: 'user' } }, bot)).toBeUndefined()
    expect(parseEvent(event({ message: { message_id: '' } }), bot)).toBeUndefined()
  })
})

describe('归一成渠道事件', () => {
  const at = new Date(1700000000000).toISOString()
  const parsed: FeishuEvent = {
    chatId: 'oc_1',
    direct: false,
    messageId: 'om_2',
    rootId: 'om_1',
    senderId: 'ou_a',
    senderName: '小明',
    text: '修一下',
    mentioned: true,
    at,
  }

  it('会话、话题、点名都映射到中立的 InboundEvent', () => {
    expect(feishuInbound(parsed)).toEqual({
      provider: 'feishu',
      conversation: 'oc_1',
      thread: 'om_1',
      messageId: 'om_2',
      senderId: 'ou_a',
      senderName: '小明',
      text: '修一下',
      addressed: true,
      direct: false,
      at,
    })
  })

  it('没有根消息时话题就是这条消息本身', () => {
    expect(feishuInbound({ ...parsed, messageId: 'om_9', rootId: undefined }).thread).toBe('om_9')
  })
})

describe('拉群列表', () => {
  it('翻完所有页，群名缺失时用 id 兜底', async () => {
    const seen: Array<Record<string, unknown>> = []
    const chats = await fetchChatPages(async (params) => {
      seen.push(params)
      if (seen.length === 1) {
        return {
          code: 0,
          data: {
            items: [
              { chat_id: 'oc_1', name: '前端', chat_mode: 'group' },
              { chat_id: 'oc_2', chat_mode: 'topic' },
            ],
            has_more: true,
            page_token: 'p2',
          },
        }
      }
      return { code: 0, data: { items: [{ chat_id: 'oc_3', name: '后端', chat_mode: 'group' }] } }
    })
    expect(seen[0]).toMatchObject({ page_size: 100 })
    expect(seen[1]).toMatchObject({ page_size: 100, page_token: 'p2' })
    expect(chats).toEqual([
      { id: 'oc_1', name: '前端', mode: 'group' },
      { id: 'oc_2', name: 'oc_2', mode: 'topic' },
      { id: 'oc_3', name: '后端', mode: 'group' },
    ])
  })

  it('飞书回业务错误时抛出来，页面能提示补权限', async () => {
    await expect(fetchChatPages(async () => ({ code: 99991672, msg: 'missing scope' }))).rejects.toThrow('missing scope')
  })

  it('没有下一个页游标就停，不会空转', async () => {
    let calls = 0
    const chats = await fetchChatPages(async () => {
      calls += 1
      return { code: 0, data: { items: [{ chat_id: 'oc_1', name: '前端' }], has_more: true } }
    })
    expect(calls).toBe(1)
    expect(chats).toHaveLength(1)
  })
})

describe('应用 id', () => {
  it('只认自建应用的形状；不合法时 SDK 会静默不连', () => {
    expect(validAppId('cli_a1b2c3d4e5f60718')).toBe(true)
    expect(validAppId('cli_1')).toBe(false)
    expect(validAppId('')).toBe(false)
  })

  it('@ 名字替换处理多个占位符', () => {
    expect(
      withMentionNames('@_user_1 和 @_user_2 看一下', [
        { key: '@_user_1', name: '小明' },
        { key: '@_user_2', name: '小红' },
      ]),
    ).toBe('@小明 和 @小红 看一下')
  })
})
