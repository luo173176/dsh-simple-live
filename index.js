/**
 * dsh-simple-live — 直播聚合面板的宿主半。
 *
 * 负责三件事：
 *   1. `/simple-live/*` 的 HTTP 面（面板接口、拉流代理、hls.js 静态资源）
 *   2. 三个模型可调用的工具（搜索 / 热门 / 开播）
 *   3. 一段 systemPrompt，让模型知道这个面板存在
 *
 * @module dsh-simple-live
 */

import { createHttp } from './lib/live/http.js'
import { createPlayProxy } from './lib/live/proxy.js'
import { createApi } from './lib/live/routes.js'
import { createStores } from './lib/live/store.js'
import * as danmaku from './lib/live/danmaku/index.js'
import * as sites from './lib/live/sites/index.js'

export const name = 'simple-live'

/** 浏览器载体是唯一硬依赖。 */
export const inject = ['webServer']

const MAX_TEXT = 1200

/**
 * 工具结果的展示形态。
 *
 * 宿主调用签名是 `render(args, result)` —— 第一个参数是工具入参、第二个才是
 * execute 的返回值。只读第一个参数会渲染出空串，模型侧表现为
 * "Tool ran without output or errors"。
 */
function renderText(_args, result) {
  return [{ type: 'text', text: String(result?.text ?? '') }]
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** 把 Web Response 写回 Node 的 ServerResponse，带背压。 */
async function toNode(res, response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r))
      }
    }
  } catch {
    /* 客户端断开或上游中断：直接收尾 */
  } finally {
    res.end()
  }
}

function roomLine(room) {
  const live = room.live ? '直播中' : '未开播'
  const online = room.online ? ` · ${room.online} 人` : ''
  return `${room.title}（${room.anchor || '未知主播'} / ${room.areaName || '未分区'} / ${live}${online} / roomId=${room.roomId}）`
}

function roomListText(rooms) {
  if (!rooms.length) return '没有找到正在直播的房间。'
  const lines = rooms.slice(0, 12).map((r) => `- ${roomLine(r)}`)
  return lines.join('\n').slice(0, MAX_TEXT)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const db = createStores()
  // 用户在「我的 → 账号」里填过的 cookie 会自动带到对应平台的请求上
  const http = createHttp({ cookieFor: (host) => db.accounts.cookieForHost(host) })
  const proxy = createPlayProxy(http, (platform) => sites.site(platform))

  let seq = 0
  let action = null
  const control = {
    play(payload) {
      seq += 1
      action = { ...payload, seq }
      return action
    },
    since(n) {
      return n >= seq ? null : action
    },
    get seq() {
      return seq
    },
  }

  const api = createApi({ http, sites, proxy, control, stores: db, danmaku })

  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = req.method === 'POST' ? await readBody(req) : undefined
      // 客户端断开（关页面 / 关 SSE）时让上游跟着收尾
      const ac = new AbortController()
      res.on('close', () => ac.abort())
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        body,
        signal: ac.signal,
      })
      const fromApi = await api(request, url.pathname)
      if (fromApi) return toNode(res, fromApi)
      return toNode(res, await proxy.handle(request, url.pathname))
    } catch (err) {
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`simple-live 内部错误：${err?.message ?? err}`)
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/simple-live', handler: handle })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools && typeof tools.register === 'function') {
    const platformEnum = sites.list().map((s) => s.id)
    const platformHint = sites.list().map((s) => `${s.id}=${s.name}`).join('、')

    const registrations = [
      {
        name: 'live_search',
        description:
          `搜索直播房间（${platformHint}）。返回房间标题、主播、分区、在线人数与 roomId；` +
          '要播放时把 platform 与 roomId 交给 live_play。',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: platformEnum, description: '直播平台' },
            keyword: { type: 'string', description: '搜索关键词，可以是主播名、游戏名或房间标题' },
          },
          required: ['platform', 'keyword'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { count: { type: 'number' }, text: { type: 'string' } },
            additionalProperties: true,
          },
          render: renderText,
        },
        async execute(args) {
          const site = sites.site(args?.platform)
          if (!site) throw new Error(`未知平台：${args?.platform}`)
          const res = await site.search(http, { keyword: String(args?.keyword ?? ''), page: 1 })
          return { count: res.items.length, text: roomListText(res.items), items: res.items.slice(0, 12) }
        },
      },
      {
        name: 'live_trending',
        description: `拉取某个平台的热门直播（${platformHint}）。不传 area 时取该平台默认首页分区。`,
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: platformEnum, description: '直播平台' },
            area: { type: 'string', description: '分区 id，格式 parent:sub，可从 live_categories 得到' },
          },
          required: ['platform'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { count: { type: 'number' }, text: { type: 'string' } },
            additionalProperties: true,
          },
          render: renderText,
        },
        async execute(args) {
          const site = sites.site(args?.platform)
          if (!site) throw new Error(`未知平台：${args?.platform}`)
          let area = args?.area
          if (!area) {
            const cats = await site.categories(http)
            const first = cats.find((c) => c.children?.length) ?? cats[0]
            area = first ? `${first.id}:${first.children?.[0]?.id ?? '0'}` : '0:0'
          }
          const res = await site.rooms(http, { area, page: 1 })
          return { count: res.items.length, text: roomListText(res.items), items: res.items.slice(0, 12) }
        },
      },
      {
        name: 'live_categories',
        description: `列出某个平台的直播分区树（${platformHint}），用于给 live_trending 挑 area。`,
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: platformEnum, description: '直播平台' },
          },
          required: ['platform'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            additionalProperties: true,
          },
          render: renderText,
        },
        async execute(args) {
          const site = sites.site(args?.platform)
          if (!site) throw new Error(`未知平台：${args?.platform}`)
          const cats = await site.categories(http)
          const text = cats
            .map((c) => `${c.name}(${c.id}): ${(c.children ?? []).slice(0, 8).map((s) => `${s.name}=${c.id}:${s.id}`).join('、')}`)
            .join('\n')
          return { text: text.slice(0, MAX_TEXT), categories: cats }
        },
      },
      {
        name: 'live_play',
        description:
          '在左侧栏「直播」面板里打开并播放一个房间。会把播放动作排进面板队列，面板在两秒内切换；' +
          '同时返回房间标题与可用清晰度，便于确认。',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: platformEnum, description: '直播平台' },
            roomId: { type: 'string', description: '房间号，来自 live_search / live_trending' },
          },
          required: ['platform', 'roomId'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { queued: { type: 'boolean' }, text: { type: 'string' } },
            additionalProperties: true,
          },
          render: renderText,
        },
        async execute(args) {
          const site = sites.site(args?.platform)
          if (!site) throw new Error(`未知平台：${args?.platform}`)
          const detail = await site.room(http, { roomId: String(args?.roomId ?? '') })
          control.play({ platform: site.id, roomId: detail.roomId })
          db.history.add({
            platform: site.id,
            roomId: detail.roomId,
            title: detail.title,
            anchor: detail.anchor,
            cover: detail.cover,
            areaName: detail.areaName,
          })
          const qualities = (detail.qualities ?? []).map((q) => q.name).join(' / ') || '无可用清晰度'
          return {
            queued: true,
            text: `${detail.live ? '已排队播放' : '房间未开播'}：${roomLine(detail)}\n清晰度：${qualities}`,
            room: { ...detail, qualities: detail.qualities?.map((q) => ({ name: q.name, format: q.format })) },
          }
        },
      },
    ]

    for (const spec of registrations) {
      ctx.effect(() => {
        const dispose = tools.register(spec, {})
        return typeof dispose === 'function' ? dispose : () => {}
      }, `simple-live-tool-${spec.name}`)
    }
  }

  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => {
      const dispose = systemPrompt.section({
        name: 'tool:simple-live',
        order: 118,
        text:
          '直播面板：左侧栏「直播」可浏览/搜索哔哩哔哩、斗鱼、虎牙、抖音的直播并播放。' +
          '工具 live_categories / live_trending / live_search 用来查房间，live_play 直接把房间排进面板播放' +
          '（必要时先 live_search 拿 roomId，不要凭空编造房间号）。',
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'simple-live-prompt')
  }
}
