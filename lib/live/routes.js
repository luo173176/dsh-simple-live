/**
 * 面板与模型工具共用的一套 HTTP 接口。
 *
 * GET  /simple-live/api/sites
 * GET  /simple-live/api/categories?platform=
 * GET  /simple-live/api/rooms?platform=&area=&page=
 * GET  /simple-live/api/search?platform=&keyword=&page=
 * GET  /simple-live/api/room?platform=&roomId=
 * GET  /simple-live/api/follows
 * POST /simple-live/api/follows       { op:'add'|'remove'|'toggle', platform, roomId, room? }
 * GET  /simple-live/api/history
 * POST /simple-live/api/history       { op?:'add'|'remove'|'clear', platform?, roomId?, room? }
 * GET  /simple-live/api/settings
 * POST /simple-live/api/settings      { ...patch }
 * GET  /simple-live/api/accounts
 * POST /simple-live/api/accounts      { op:'set'|'remove', platform, cookie?, note? }
 * GET  /simple-live/api/parse?url=
 * GET  /simple-live/api/danmaku?platform=&roomId=   → text/event-stream
 * GET  /simple-live/api/control?since=<seq>
 * POST /simple-live/api/play          { platform, roomId }
 *
 * @module dsh-simple-live/lib/live/routes
 */

import { createStores, platformOfHost } from './store.js'
import { verifyAccount } from './verify.js'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 限并发跑一批异步任务，保留顺序。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

/** 超时就 reject，避免单房间卡住整批。 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

/* --------------------------------------------------------- 播放动作队列 --- */

function createControl() {
  let seq = 0
  let action = null
  return {
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
}

/* --------------------------------------------------------- 链接解析 --- */

const NAME_SUFFIX = [
  ['bilibili.com', 'bilibili'],
  ['douyu.com', 'douyu'],
  ['huya.com', 'huya'],
  ['douyin.com', 'douyin'],
  ['kuaishou.com', 'kuaishou'],
]

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 跟随一次 302/301 拿 Location；拿不到返回 ''。用于 b23.tv / v.douyin.com 短链。 */
async function resolveShortUrl(url) {
  if (!url) return ''
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 9000)
  try {
    // 首选：让 fetch 自动跟随，拿最终 URL（对 b23.tv / v.douyin.com 最稳）
    try {
      const followed = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': MOBILE_UA } })
      if (followed.url && followed.url !== url) return followed.url
    } catch {
      /* 落到手工 302 */
    }
    // 兜底：手工读 Location / meta refresh
    const res = await fetch(url, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': MOBILE_UA } })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (loc) return new URL(loc, url).toString()
    }
    const text = await res.text().catch(() => '')
    const m = /(?:location\.(?:href|replace)\s*[=(]\s*['"]|url\s*=\s*['"]|href\s*=\s*['"])(https?:\/\/[^"'>\s]+)/i.exec(
      text,
    )
    if (m) return m[1]
  } catch {
    /* 网络/超时：交由上层判空 */
  } finally {
    clearTimeout(timer)
  }
  return ''
}

/** 从任意输入里抠出 { platform, roomId }（对齐原项目 parse_controller 的逻辑 + 短链解析）。 */
async function parseInput(input, depth = 0) {
  const raw = String(input ?? '').trim()
  if (!raw) return { platform: null, roomId: '' }

  // 分享文案里常夹着文字，先抠出第一个链接
  const urlHit = raw.match(/https?:\/\/[^\s"'<>\u4e00-\u9fa5]+/i)
  const text = urlHit ? urlHit[0] : raw

  // platform:roomId
  const tagged = text.match(
    /^(bilibili|bili|douyu|douyu2|huya|douyin|tiktok|kuaishou|ks)\s*[:：]\s*([\w-]+)$/i,
  )
  if (tagged) {
    const map = { bili: 'bilibili', tiktok: 'douyin', douyu2: 'douyu', ks: 'kuaishou' }
    const key = tagged[1].toLowerCase()
    return { platform: map[key] ?? key, roomId: tagged[2] }
  }

  let host = ''
  let path = text
  try {
    const withProto = /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`
    const u = new URL(withProto)
    host = u.hostname.toLowerCase()
    path = u.pathname + u.search
  } catch {
    /* 不是 URL，按纯文本继续 */
  }

  // 短链：b23.tv / v.douyin.com / v.kuaishou.com → 解析 302 后递归
  if (
    depth < 4 &&
    (/(^|\.)b23\.tv$/.test(host) ||
      /(^|\.)v\.douyin\.com$/.test(host) ||
      /(^|\.)v\.kuaishou\.com$/.test(host))
  ) {
    const real = await resolveShortUrl(text)
    if (real) return parseInput(real, depth + 1)
  }

  let platform = platformOfHost(host)
  if (!platform) {
    const hit = NAME_SUFFIX.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`))
    platform = hit ? hit[1] : null
  }

  // 各站专属规则（先精确、后兜底）
  if (platform === 'douyin') {
    const reflow = path.match(/reflow\/(\d+)/) // webcast.amemv.com/webcast/reflow/<id>
    if (reflow) return { platform, roomId: reflow[1] }
    const live = path.match(/live\.douyin\.com\/(\d+)/i)
    if (live) return { platform, roomId: live[1] }
    const num = path.match(/\/(\d{5,})/)
    return { platform, roomId: num ? num[1] : '' }
  }

  if (platform === 'douyu') {
    if (/topic/i.test(path)) {
      const rid = path.match(/[?&]rid=(\d+)/)
      if (rid) return { platform, roomId: rid[1] }
    }
    const num = path.match(/\/([0-9]{3,})/)
    return { platform, roomId: num ? num[1] : '' }
  }

  if (platform === 'bilibili') {
    const live = path.match(/live\.bilibili\.com\/(\d+)/i)
    if (live) return { platform, roomId: live[1] }
    // 空间页（space.bilibili.com/<uid>）不是直播间，别把用户 id 当房间号
    if (/^space\.bilibili\.com$/.test(host)) return { platform, roomId: '' }
    if (/^\/(video|read|bangumi|cheese|festival|blackboard)\b/i.test(path)) return { platform, roomId: '' }
    const num = path.match(/\/(\d{3,})/)
    return { platform, roomId: num ? num[1] : '' }
  }

  if (platform === 'kuaishou') {
    // live.kuaishou.com/u/<authorId> —— 适配器以 authorId 作为 roomId
    const u = path.match(/\/u\/([A-Za-z0-9_-]+)/)
    if (u) return { platform, roomId: u[1] }
    const any = path.match(/\/([A-Za-z0-9_-]{6,})/)
    return { platform, roomId: any ? any[1] : '' }
  }

  // huya 及兜底：路径里第一段 ≥3 位数字
  const digits = path.match(/(\d{3,})/)
  return { platform, roomId: digits ? digits[1] : '' }
}

/* ------------------------------------------------------------- SSE 弹幕 --- */

// 弹幕适配器取 cookie 用的站点域名（登录 cookie 按域名注入）
const DANMAKU_HOST = {
  bilibili: 'live.bilibili.com',
  douyu: 'www.douyu.com',
  huya: 'www.huya.com',
  douyin: 'live.douyin.com',
  kuaishou: 'live.kuaishou.com',
}

function danmakuStream(platform, roomId, danmaku, request, cookie = '') {
  const encoder = new TextEncoder()
  let session = null
  let timer = null
  let closed = false

  return new ReadableStream({
    start(controller) {
      const send = (obj) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {
          closed = true
        }
      }
      const finish = () => {
        if (closed) return
        closed = true
        if (timer) clearInterval(timer)
        try {
          controller.close()
        } catch {
          /* 已关闭 */
        }
      }

      send({ type: 'status', state: 'connecting' })
      // SSE 注释心跳，防止中间层把空闲连接掐掉
      timer = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'))
        } catch {
          finish()
        }
      }, 20000)

      danmaku
        .open(platform, roomId, {
          cookie: '',
          onEvent: (ev) => {
            send(ev)
            if (ev && ev.type === 'status' && ev.state === 'closed') finish()
          },
          signal: request.signal,
        })
        .then((s) => {
          session = s
          if (closed) s.close()
        })
        .catch((err) => {
          send({ type: 'status', state: 'error', message: String(err?.message ?? err) })
          finish()
        })

      request.signal?.addEventListener?.('abort', () => {
        try {
          session?.close()
        } catch {
          /* 已关闭 */
        }
        finish()
      })
    },
    cancel() {
      closed = true
      if (timer) clearInterval(timer)
      try {
        session?.close()
      } catch {
        /* 已关闭 */
      }
    },
  })
}

/**
 * @param {{ http: any, sites: any, proxy: any, control?: any, stores?: any,
 *           danmaku: any, dataDir?: string }} deps
 */
export function createApi({ http, sites, proxy, control, stores, danmaku, dataDir }) {
  const db = stores || createStores(dataDir)
  const ctrl = control || createControl()

  function siteOrThrow(platform) {
    const site = sites.site(platform)
    if (!site) throw new Error(`未知平台：${platform}`)
    return site
  }

  function decorate(detail, platform) {
    const qualities = (detail.qualities ?? []).map((q) => ({
      name: q.name,
      format: q.format,
      src: proxy.streamPath(q.url, platform),
    }))
    return { ...detail, qualities }
  }

  /** @returns {Promise<Response|null>} null 表示不是本插件的 API 路径 */
  return async function handle(request, pathname) {
    if (!pathname.startsWith('/simple-live/api/')) return null
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    const url = new URL(request.url)
    const q = url.searchParams
    const route = pathname.slice('/simple-live/api/'.length)

    try {
      if (route === 'sites') return json({ items: sites.list() })

      if (route === 'categories') {
        const site = siteOrThrow(q.get('platform'))
        return json({ items: await site.categories(http) })
      }

      if (route === 'rooms') {
        const platform = q.get('platform')
        const site = siteOrThrow(platform)
        const page = Number(q.get('page') ?? 1) || 1
        const res = await site.rooms(http, { area: q.get('area') ?? '0:0', page })
        return json(res)
      }

      if (route === 'search') {
        const platform = q.get('platform')
        const site = siteOrThrow(platform)
        const page = Number(q.get('page') ?? 1) || 1
        return json(await site.search(http, { keyword: q.get('keyword') ?? '', page }))
      }

      if (route === 'room') {
        const platform = q.get('platform')
        const site = siteOrThrow(platform)
        const detail = await site.room(http, { roomId: q.get('roomId') ?? '' })
        return json(decorate(detail, platform))
      }

      if (route === 'follows') {
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}))
          const op = body?.op ?? 'toggle'
          const platform = String(body?.platform ?? '')
          const roomId = String(body?.roomId ?? '')
          if (op === 'remove' || (op === 'toggle' && db.follows.has(platform, roomId))) {
            return json({ items: db.follows.remove(platform, roomId) })
          }
          return json({ items: db.follows.add({ ...(body?.room ?? {}), platform, roomId }) })
        }
        if (q.get('live') === '1') {
          const saved = db.follows.list()
          const head = saved.slice(0, 30)
          const refreshed = await mapLimit(head, 5, async (f) => {
            try {
              const site = sites.site(f.platform)
              if (!site) return f
              const detail = await withTimeout(site.room(http, { roomId: String(f.roomId) }), 8000)
              return {
                ...f,
                live: detail.live !== false,
                title: detail.title || f.title,
                anchor: detail.anchor || f.anchor,
                cover: detail.cover || f.cover,
                online: detail.online ?? f.online,
              }
            } catch {
              return f
            }
          })
          return json({ items: refreshed.concat(saved.slice(30)) })
        }
        return json({ items: db.follows.list() })
      }

      if (route === 'history') {
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}))
          const op = body?.op ?? 'add'
          if (op === 'clear') return json({ items: db.history.clear() })
          if (op === 'remove') {
            return json({ items: db.history.remove(String(body?.platform ?? ''), String(body?.roomId ?? '')) })
          }
          const room = body?.room ?? body ?? {}
          return json({
            items: db.history.add({
              platform: String(body?.platform ?? room.platform ?? ''),
              roomId: String(body?.roomId ?? room.roomId ?? ''),
              title: String(room.title ?? ''),
              anchor: String(room.anchor ?? ''),
              cover: String(room.cover ?? ''),
              areaName: String(room.areaName ?? ''),
              at: Number(body?.at) || Date.now(),
            }),
          })
        }
        return json({ items: db.history.list() })
      }

      if (route === 'settings') {
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}))
          const patch = body && body.patch && typeof body.patch === 'object' ? body.patch : body
          return json({ value: db.settings.patch(patch) })
        }
        return json({ value: db.settings.get(), defaults: db.defaults })
      }

      if (route === 'accounts') {
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}))
          const platform = String(body?.platform ?? '')
          const op = String(body?.op ?? 'set')
          if (op === 'remove') return json({ items: db.accounts.remove(platform) })
          // 只校验、不落库（用于"校验"按钮或未保存的 cookie）
          if (op === 'verify') {
            const cookie = String(body?.cookie ?? db.accounts.raw(platform))
            const verify = await verifyAccount(http, platform, cookie)
            return json({ verify })
          }
          // 保存后立刻校验一次，把真实登录状态回给界面
          const items = db.accounts.set(platform, body?.cookie, body?.note)
          const verify = await verifyAccount(http, platform, db.accounts.raw(platform))
          return json({ items, verify })
        }
        return json({ items: db.accounts.list() })
      }

      if (route === 'parse') {
        const parsed = await parseInput(q.get('url') ?? '')
        const site = parsed.platform ? sites.site(parsed.platform) : null
        return json({ ...parsed, platformName: site ? site.name : '' })
      }

      if (route === 'danmaku') {
        const platform = String(q.get('platform') ?? '')
        const roomId = String(q.get('roomId') ?? '')
        if (!sites.site(platform)) return json({ error: `未知平台：${platform}` }, 400)
        if (!roomId) return json({ error: '需要 roomId' }, 400)
        const dkHost = DANMAKU_HOST[platform]
        const dkCookie = (dkHost && db.accounts?.cookieForHost?.(dkHost)) || ''
        return new Response(danmakuStream(platform, roomId, danmaku, request, dkCookie), {
          headers: {
            ...CORS,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          },
        })
      }

      if (route === 'control') {
        const action = ctrl.since(Number(q.get('since') ?? 0) || 0)
        return json({ seq: ctrl.seq, action })
      }

      if (route === 'play' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}))
        const platform = String(body?.platform ?? '')
        const roomId = String(body?.roomId ?? '')
        if (!platform || !roomId) return json({ error: '需要 platform 与 roomId' }, 400)
        const action = ctrl.play({ platform, roomId })
        return json({ ok: true, action })
      }

      return json({ error: `未知接口：${route}` }, 404)
    } catch (err) {
      return json({ error: String(err?.message ?? err) }, 500)
    }
  }
}
