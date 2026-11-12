/**
 * 快手直播弹幕：真实现（WebSocket + 手写 protobuf + 可选 gzip/AES 解压 + 自定义进房/心跳）。
 *
 * 协议要点（移植自 simple_live_core 的 kuaishou_danmaku.dart，2026-11 实测，Node 22 全局
 * WebSocket / fetch / zlib / crypto，零第三方依赖）：
 *
 *   1) 进房前先抓房间页 `https://live.kuaishou.com/u/<roomId>`，解析内联
 *      `window.__INITIAL_STATE__`：
 *        - selected = liveroom.playList[] 中 author.id === roomId 的项（优先 isLiving）
 *        - liveStream = selected.liveStream || selected，取 liveStreamId = liveStream.id
 *        - token    = liveroom.token（非空）或递归找 key ∈ token/websockettoken/wstoken
 *        - wsUrls   = 递归找 key ∈ websocketurls/websocketaddresses/websocketinfo 里的 ws/wss
 *        - expTag   = liveStream.expTag，attach = selected.expTag
 *      若 token 或 wsUrls 缺失且 liveStreamId 存在，再请求
 *        `GET /live_api/liveroom/websocketinfo?liveStreamId=<id>` 取 data.token + data.websocketUrls。
 *      登录态（cookie 含 kwfv1）需额外带 header `Kww: <decodeURIComponent(kwfv1)>###ssrc`。
 *
 *   2) 连接 wsUrl（Origin/Referer 由服务端 token 校验，token 随进房帧发送）。
 *
 *   3) 帧 = protobuf `SocketMessage`：field1 varint payloadType；field2 varint compressionType；
 *      field3 bytes payload。compressionType：2→gzip，3→AES-128-CBC(PKCS7)。
 *
 *   4) 进房：payloadType=200，payload 为
 *        writeString(1,token) writeString(2,liveStreamId) writeString(5,expTag)
 *        writeString(6,attach) writeString(7,pageId)   // 空串字段省略，零值字段不写
 *
 *   5) 心跳：每 20s，payloadType=1，payload = writeVarintField(1, Date.now())。
 *
 *   6) 下行：payloadType=103 → 错误(field1 code, field2 message)，记录后断开重连；
 *      payloadType=310 → 弹幕推送，field5 bytes = CommentFeed：
 *        CommentFeed.field2 = SimpleUserInfo(field2 = userName)；
 *        CommentFeed.field3 = content；field6 = 颜色(hex)；field7 varint==2 表示 hidden(跳过)。
 *
 * 限制：匿名访客通常拿不到 token/wsUrl（websocketinfo 返回 result=2），此时按契约
 *   发 `unsupported` 后 `closed`，不进入重连风暴。
 *
 * @module dsh-simple-live/lib/live/danmaku/kuaishou
 */

import { gunzipSync } from 'node:zlib'
import { createDecipheriv, randomBytes } from 'node:crypto'

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://live.kuaishou.com/'
const HEARTBEAT_MS = 20000
const MAX_RECONNECT = 5
const AES_KEY = Buffer.from('PPbzKKL7NB15leYy', 'utf8') // 16 bytes
const AES_IV = Buffer.from('JRODKJiolJ9xqso0', 'utf8') // 16 bytes
const PAGE_ID_CHARS = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

/* --------------------------------------------------------- protobuf --- */

/** 无符号 varint 编码。 */
function uvint(n) {
  const bytes = []
  let v = BigInt(Math.max(0, Math.floor(Number(n) || 0)))
  while (v > 127n) {
    bytes.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}
const pbKey = (tag, wire) => uvint(tag * 8 + wire)
const pbVarint = (tag, val) => Buffer.concat([pbKey(tag, 0), uvint(val)])
const pbBytes = (tag, buf) => Buffer.concat([pbKey(tag, 2), uvint(buf.length), buf])
const pbStr = (tag, s) => pbBytes(tag, Buffer.from(String(s), 'utf8'))

/**
 * 极简 protobuf 读取器：把 buffer 解成 [{ tag, wire, value }]（value：varint=number，length=Buffer）。
 * 只处理 wire 0/2，其余（1/5）跳过。
 */
function pbParse(buf) {
  const out = []
  let p = 0
  const readVarint = () => {
    let shift = 0n
    let v = 0n
    for (;;) {
      if (p >= buf.length) throw new Error('varint 越界')
      const b = buf[p++]
      v |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) break
      shift += 7n
    }
    return v
  }
  while (p < buf.length) {
    const k = readVarint()
    const wire = Number(k & 7n)
    const tag = Number(k >> 3n)
    if (wire === 0) out.push({ tag, wire, value: Number(readVarint()) })
    else if (wire === 2) {
      const len = Number(readVarint())
      if (p + len > buf.length) throw new Error('length-delimited 越界')
      out.push({ tag, wire, value: buf.subarray(p, p + len) })
      p += len
    } else if (wire === 5) {
      p += 4
    } else if (wire === 1) {
      p += 8
    } else {
      break // 不支持的 wire，放弃剩余
    }
  }
  return out
}

/* ------------------------------------------------------ 帧组装/解压 --- */

function buildSocketFrame(payloadType, payload, compressionType = 0) {
  return Buffer.concat([
    pbVarint(1, payloadType),
    pbVarint(2, compressionType),
    pbBytes(3, payload),
  ])
}

function decompressPayload(compressionType, payload) {
  if (compressionType === 2) {
    try {
      return gunzipSync(payload)
    } catch {
      return payload
    }
  }
  if (compressionType === 3) {
    try {
      const d = createDecipheriv('aes-128-cbc', AES_KEY, AES_IV)
      return Buffer.concat([d.update(payload), d.final()])
    } catch {
      return payload
    }
  }
  return payload
}

function buildJoinPayload({ token, liveStreamId, expTag, attach, pageId }) {
  const parts = []
  if (token) parts.push(pbStr(1, token))
  if (liveStreamId) parts.push(pbStr(2, liveStreamId))
  if (expTag) parts.push(pbStr(5, expTag))
  if (attach) parts.push(pbStr(6, attach))
  if (pageId) parts.push(pbStr(7, pageId))
  return Buffer.concat(parts)
}

function makePageId() {
  const bytes = randomBytes(16)
  let s = ''
  for (let i = 0; i < 16; i++) s += PAGE_ID_CHARS[bytes[i] % PAGE_ID_CHARS.length]
  return s
}

/** 颜色归一：'#rrggbb' 或 'rrggbb' → '#rrggbb'。 */
function normalizeColor(raw) {
  if (!raw) return undefined
  const s = String(raw).trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s
  return undefined
}

/**
 * 解 CommentFeed：field2 = SimpleUserInfo(field2 = userName)，field3 = content，
 * field6 = 颜色，field7 varint==2 表示 hidden。返回 {user,text,color?} 或 null。
 */
export function parseCommentFeed(feedBuf) {
  let fields
  try {
    fields = pbParse(feedBuf)
  } catch {
    return null
  }
  let content = ''
  let colorRaw = ''
  let hidden = false
  let userName = ''
  for (const f of fields) {
    if (f.tag === 3 && f.wire === 2) content = f.value.toString('utf8')
    else if (f.tag === 6 && f.wire === 2) colorRaw = f.value.toString('utf8')
    else if (f.tag === 7 && f.wire === 0) hidden = f.value === 2
    else if (f.tag === 2 && f.wire === 2) {
      try {
        const uf = pbParse(f.value)
        for (const u of uf) {
          if (u.tag === 2 && u.wire === 2) {
            userName = u.value.toString('utf8')
            break
          }
        }
      } catch {
        /* 忽略用户信息解析失败 */
      }
    }
  }
  if (hidden || !content) return null
  const out = { user: userName, text: content }
  const color = normalizeColor(colorRaw)
  if (color) out.color = color
  return out
}

/**
 * 解一个下行 SocketMessage，返回：
 *   { kind:'error', message }            —— payloadType 103（错误帧）
 *   { kind:'frame', payloadType, feeds } —— 正常帧，feeds 为已解析的弹幕数组（可能为空）
 *   null                                 —— 无法解析
 */
export function decodeFrame(buf) {
  let top
  try {
    top = pbParse(buf)
  } catch {
    return null
  }
  let payloadType = 0
  let compressionType = 0
  let payload = null
  for (const f of top) {
    if (f.tag === 1 && f.wire === 0) payloadType = f.value
    else if (f.tag === 2 && f.wire === 0) compressionType = f.value
    else if (f.tag === 3 && f.wire === 2) payload = f.value
  }
  if (!payload) return null
  const body = decompressPayload(compressionType, payload)

  if (payloadType === 103) {
    let msg = ''
    try {
      const ef = pbParse(body)
      for (const f of ef) if (f.tag === 2 && f.wire === 2) msg = f.value.toString('utf8')
    } catch {
      /* ignore */
    }
    return { kind: 'error', message: msg || '服务器返回错误帧(103)' }
  }

  const feeds = []
  if (payloadType === 310) {
    try {
      for (const f of pbParse(body)) {
        if (f.tag === 5 && f.wire === 2) {
          const chat = parseCommentFeed(f.value)
          if (chat) feeds.push(chat)
        }
      }
    } catch {
      /* 单条推送解析失败忽略 */
    }
  }
  return { kind: 'frame', payloadType, feeds }
}


/* -------------------------------------------------------- 凭证解析 --- */

function extractState(html) {
  const marker = 'window.__INITIAL_STATE__='
  let i = html.indexOf(marker)
  if (i < 0) return null
  i += marker.length
  let depth = 0
  let start = -1
  let end = -1
  for (let k = i; k < html.length; k++) {
    const c = html[k]
    if (c === '{') {
      if (start < 0) start = k
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  if (start < 0 || end < 0) return null
  try {
    return JSON.parse(html.slice(start, end).replace(/\bundefined\b/g, 'null'))
  } catch {
    return null
  }
}

/** 递归找某个 key（不区分大小写）下第一个非空字符串值。 */
function findStringByKey(node, keys) {
  const want = new Set(keys.map((k) => k.toLowerCase()))
  const seen = new Set()
  let found = ''
  ;(function walk(x) {
    if (found || !x || typeof x !== 'object' || seen.has(x)) return
    seen.add(x)
    if (Array.isArray(x)) {
      for (const y of x) walk(y)
      return
    }
    for (const [k, v] of Object.entries(x)) {
      if (want.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) {
        found = v.trim()
        return
      }
      walk(v)
      if (found) return
    }
  })(node)
  return found
}

/** 递归收集 key ∈ keys 的值里所有 ws:// / wss:// 字符串。 */
function collectWsUrls(node, keys) {
  const want = new Set(keys.map((k) => k.toLowerCase()))
  const seen = new Set()
  const out = []
  const grab = (val) => {
    ;(function rec(z) {
      if (!z || typeof z !== 'object' || seen.has(z)) return
      seen.add(z)
      if (Array.isArray(z)) {
        for (const y of z) rec(y)
        return
      }
      for (const y of Object.values(z)) {
        if (typeof y === 'string' && /^wss?:\/\//i.test(y)) out.push(y)
        else rec(y)
      }
    })(val)
  }
  ;(function walk(x) {
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) {
      for (const y of x) walk(y)
      return
    }
    for (const [k, v] of Object.entries(x)) {
      if (want.has(k.toLowerCase())) grab(v)
      else walk(v)
    }
  })(node)
  return out
}

/** 从 cookie 里取 kwfv1 → Kww 头值（decodeURIComponent(value)+'###ssrc'）。 */
function kwwFromCookie(cookie) {
  if (!cookie) return ''
  const m = /(?:^|;\s*)kwfv1=([^;]+)/.exec(cookie)
  if (!m) return ''
  let v = m[1]
  try {
    v = decodeURIComponent(v)
  } catch {
    /* 保留原值 */
  }
  return v ? `${v}###ssrc` : ''
}

class UnsupportedError extends Error {
  constructor(message) {
    super(message)
    this.unsupported = true
  }
}

async function fetchRoomHtml(roomId, cookie) {
  const headers = {
    'user-agent': DESKTOP_UA,
    'accept-language': 'zh-CN,zh;q=0.9',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    referer: REFERER,
  }
  if (cookie) headers.cookie = cookie
  const res = await fetch(`https://live.kuaishou.com/u/${encodeURIComponent(roomId)}`, { headers })
  if (!res.ok) throw new Error(`房间页 HTTP ${res.status}`)
  return res.text()
}

async function fetchWsInfo(liveStreamId, roomId, cookie) {
  const headers = {
    'user-agent': DESKTOP_UA,
    accept: 'application/json, text/plain, */*',
    referer: `https://live.kuaishou.com/u/${encodeURIComponent(roomId)}`,
    origin: 'https://live.kuaishou.com',
  }
  if (cookie) headers.cookie = cookie
  const kww = kwwFromCookie(cookie)
  if (kww) headers.Kww = kww
  const url = `https://live.kuaishou.com/live_api/liveroom/websocketinfo?liveStreamId=${encodeURIComponent(liveStreamId)}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`websocketinfo HTTP ${res.status}`)
  const json = await res.json()
  return json && json.data ? json.data : {}
}

/** 解析进房所需参数；拿不到 token/wsUrl 时抛 UnsupportedError。 */
async function resolveArgs(roomId, cookie) {
  const html = await fetchRoomHtml(roomId, cookie)
  const state = extractState(html)
  const liveroom = state && state.liveroom
  if (!liveroom) {
    throw new UnsupportedError('快手房间页未返回直播间数据（可能已下播或页面结构变更）')
  }

  const playList = Array.isArray(liveroom.playList) ? liveroom.playList : []
  const rid = String(roomId)
  const selected =
    playList.find((r) => r && r.author && String(r.author.id) === rid && r.isLiving === true) ||
    playList.find((r) => r && r.author && String(r.author.id) === rid) ||
    playList[0] ||
    {}

  const liveStream =
    selected.liveStream && typeof selected.liveStream === 'object' ? selected.liveStream : selected
  const liveStreamId = String(liveStream.id || '')
  const expTag = liveStream.expTag || ''
  const attach = selected.expTag || ''

  // 页面风控/错误快照（例如“请求过快，请稍后重试”）：可重试，不当成“未开播”
  const errType = selected.errorType
  if (errType && (typeof errType === 'object' ? errType.title || errType.type : errType)) {
    const title = typeof errType === 'object' ? errType.title || `type=${errType.type}` : String(errType)
    if (String(title).includes('请求过快') || String(title).includes('风控')) {
      throw new Error(`快手房间页风控：${title}`)
    }
  }

  let token = String(liveroom.token || '') || findStringByKey([liveroom, selected], ['token', 'websockettoken', 'wstoken'])
  let wsUrls = collectWsUrls([liveroom, selected], ['websocketurls', 'websocketaddresses', 'websocketinfo'])

  if ((!token || wsUrls.length === 0) && liveStreamId) {
    let data = {}
    try {
      data = await fetchWsInfo(liveStreamId, roomId, cookie)
    } catch {
      data = {}
    }
    if (data && (data.result === 1 || data.result === '1' || data.token)) {
      if (!token && data.token) token = String(data.token)
      if (wsUrls.length === 0) wsUrls = collectWsUrls(data, ['websocketurls', 'websocketaddresses', 'websocketinfo'])
    }
  }

  if (!liveStreamId) {
    throw new UnsupportedError('快手房间未在播（未取到 liveStreamId）')
  }
  if (!token || wsUrls.length === 0) {
    // 匿名访客的典型结局：无 kwfv1 → websocketinfo result=2 → 拿不到 token/wsUrl
    const loggedIn = !!kwwFromCookie(cookie)
    throw new UnsupportedError(
      loggedIn
        ? '快手弹幕未取到 token/连地址（登录态可能失效或房间未在播）'
        : '快手弹幕需要登录：当前无 kwfv1 cookie，匿名访客无法获取弹幕 token（websocketinfo 返回 result=2）',
    )
  }

  return {
    wsUrl: wsUrls[0],
    token,
    liveStreamId,
    expTag,
    attach,
    pageId: makePageId(),
  }
}

/* ------------------------------------------------------------ 主逻辑 --- */

/**
 * @param {string} roomId 真实房间号（与 URL 一致）
 * @param {{ onEvent?: (ev:any)=>void, cookie?: string, signal?: AbortSignal }} [opts]
 * @returns {{ close(): void }}
 */
export function open(roomId, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
  const signal = opts.signal
  const cookie = opts.cookie
  const rid = String(roomId == null ? '' : roomId).trim()

  let closed = false
  let ws = null
  let hbTimer = null
  let reconnectTimer = null
  let attempt = 0
  let lastError = ''
  let cachedArgs = null

  function emit(ev) {
    try {
      onEvent(ev)
    } catch {
      /* swallow */
    }
  }
  const status = (state, message) =>
    emit(message ? { type: 'status', state, message } : { type: 'status', state })

  function clearHeartbeat() {
    if (hbTimer) {
      clearInterval(hbTimer)
      hbTimer = null
    }
  }

  async function connect() {
    if (closed) return
    status('connecting')

    let args = cachedArgs
    if (!args) {
      try {
        args = await resolveArgs(rid, cookie)
        cachedArgs = args
      } catch (e) {
        lastError = (e && e.message) || String(e)
        if (e && e.unsupported) {
          // 匿名/无凭证：明确告知无法取弹幕，然后正常关闭，不重连
          status('unsupported', lastError)
          status('closed')
          closed = true
          return
        }
        scheduleReconnect()
        return
      }
    }

    if (closed) return

    let socket
    try {
      socket = new WebSocket(args.wsUrl)
    } catch (e) {
      lastError = (e && e.message) || String(e)
      scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    ws = socket
    const ctx = { authed: false, opened: false }

    function markOpen() {
      if (ctx.opened || closed) return
      ctx.opened = true
      attempt = 0
      status('open')
    }

    socket.addEventListener('open', () => {
      if (closed) return
      try {
        socket.send(buildSocketFrame(200, buildJoinPayload(args)))
      } catch (e) {
        lastError = (e && e.message) || String(e)
      }
      clearHeartbeat()
      hbTimer = setInterval(() => {
        try {
          const hb = buildSocketFrame(1, pbVarint(1, Date.now()))
          socket.send(hb)
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS)
    })

    socket.addEventListener('message', async (ev) => {
      if (closed) return
      try {
        const d = ev.data
        let buf
        if (typeof d === 'string') buf = Buffer.from(d, 'utf8')
        else if (d instanceof ArrayBuffer) buf = Buffer.from(d)
        else if (ArrayBuffer.isView(d)) buf = Buffer.from(d.buffer, d.byteOffset, d.byteLength)
        else if (d && typeof d.arrayBuffer === 'function') buf = Buffer.from(await d.arrayBuffer())
        else buf = Buffer.from(d)
        const r = decodeFrame(buf)
        if (!r) return
        if (r.kind === 'error') {
          lastError = r.message
          try {
            socket.close()
          } catch {
            /* 交给 close 事件重连 */
          }
          return
        }
        ctx.authed = true
        for (const chat of r.feeds) {
          const ev = { type: 'chat', user: chat.user, text: chat.text, ts: Date.now() }
          if (chat.color) ev.color = chat.color
          emit(ev)
        }
        markOpen()
      } catch {
        /* 单帧失败不影响连接 */
      }
    })

    socket.addEventListener('error', () => {
      /* 后随 close，交给 close 处理重连 */
    })

    socket.addEventListener('close', () => {
      clearHeartbeat()
      if (closed) return
      scheduleReconnect()
    })
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    if (attempt >= MAX_RECONNECT) {
      clearHeartbeat()
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        ws = null
      }
      if (lastError) status('error', `快手弹幕连接失败：${lastError}`)
      status('closed')
      closed = true
      return
    }
    const delay = Math.min(8000, 1000 * Math.pow(2, attempt))
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function close() {
    if (closed) return
    closed = true
    clearHeartbeat()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const s = ws
    ws = null
    if (s) {
      try {
        s.close()
      } catch {
        /* ignore */
      }
    }
    status('closed')
  }

  if (!rid) {
    queueMicrotask(() => {
      if (closed) return
      status('connecting')
      status('unsupported', '快手弹幕需要真实房间号（roomId 为空）')
      status('closed')
      closed = true
    })
    return { close() {} }
  }

  if (signal) {
    if (signal.aborted) {
      queueMicrotask(() => {
        if (!closed) {
          closed = true
          status('closed')
        }
      })
      return { close() {} }
    }
    signal.addEventListener('abort', () => close(), { once: true })
  }

  connect()
  return { close }
}
