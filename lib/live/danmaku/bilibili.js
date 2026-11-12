/**
 * 哔哩哔哩直播弹幕：真实现。
 *
 * 零第三方依赖：node:zlib / node:crypto + 全局 WebSocket / fetch。
 *
 * 现代 B 站弹幕必须先取连接凭证（token + host_list）：
 *   1) GET api.bilibili.com/x/frontend/finger/spi 拿 buvid3/buvid4；
 *   2) GET api.bilibili.com/x/web-interface/nav 拿 WBI 的 img_key/sub_key；
 *   3) WBI 签名 GET api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=<roomId>&type=0
 *      返回 { token, host_list:[{host,wss_port}] }；
 *   4) WebSocket 连 wss://<host>:<wss_port>/sub，op=7 认证 body 带 key=token。
 * 直接连广播地址但不带 token 会被服务端立刻 1006 断开。
 *
 * 16 字节协议头：[4]packetLen(be) [2]headerLen [2]protoVer [4]op [4]seq。
 * protoVer=3 body 为 brotli、=2 为 zlib，解压后仍是多包拼接，按长度递归拆。
 * 心跳 op=2，30s 一次；认证 op=7；通知 op=5；认证回包 op=8。
 *
 * @module dsh-simple-live/lib/live/danmaku/bilibili
 */

import zlib from 'node:zlib'
import crypto from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const API = 'https://api.bilibili.com'
const API_LIVE = 'https://api.live.bilibili.com'
const REFERER = 'https://live.bilibili.com/'

const HEADER_LEN = 16
const OP_HEARTBEAT = 2
const OP_HEARTBEAT_REPLY = 3
const OP_MESSAGE = 5
const OP_AUTH = 7
const OP_AUTH_REPLY = 8
const HEARTBEAT_MS = 30000
const MAX_RECONNECT = 5

/* WBI 混淆表（固定） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6,
  63, 57, 62, 11, 36, 20, 34, 44, 52,
]

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const baseName = (u) => String(u).split('/').pop().split('.')[0]

/* ------------------------------------------------------------ 缓存 --- */
let fpCache = { cookie: '', b3: '', at: 0 }
let wbiCache = { imgKey: '', subKey: '', at: 0 }
const infoCache = new Map() // roomId -> { token, hosts, at }

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined
  }
}

async function fetchJson(url, cookie = '', referer = REFERER) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer,
      cookie,
    },
    signal: timeoutSignal(8000),
  })
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`B站接口非 JSON：${raw.slice(0, 120)}`)
  }
}

async function getCookie() {
  if (fpCache.cookie && Date.now() - fpCache.at < 6 * 3600e3) return fpCache
  try {
    const j = await fetchJson(`${API}/x/frontend/finger/spi`)
    const b3 = j?.data?.b_3 ?? ''
    const b4 = j?.data?.b_4 ?? ''
    fpCache = { cookie: b3 ? `buvid3=${b3}; buvid4=${b4};` : '', b3, at: Date.now() }
  } catch {
    fpCache = { cookie: '', b3: '', at: Date.now() }
  }
  return fpCache
}

async function getWbiKeys(cookie) {
  if (wbiCache.imgKey && Date.now() - wbiCache.at < 12 * 3600e3) return wbiCache
  const j = await fetchJson(`${API}/x/web-interface/nav`, cookie, 'https://www.bilibili.com/')
  const img = baseName(j?.data?.wbi_img?.img_url)
  const sub = baseName(j?.data?.wbi_img?.sub_url)
  if (!img || !sub) throw new Error('B站 WBI 密钥获取失败')
  wbiCache = { imgKey: img, subKey: sub, at: Date.now() }
  return wbiCache
}

/** 用 WBI 规则给 params 追加 wts 并签名，返回完整 query 串（含 w_rid）。 */
async function signedQuery(cookie, params) {
  const { imgKey, subKey } = await getWbiKeys(cookie)
  const raw = imgKey + subKey
  const mixinKey = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  const withTs = { ...params, wts: String(Math.round(Date.now() / 1000)) }
  const q = Object.keys(withTs)
    .sort()
    .map((k) => {
      const v = String(withTs[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  const w_rid = md5(q + mixinKey)
  return `${q}&w_rid=${w_rid}`
}

async function getDanmuInfo(roomId) {
  const cached = infoCache.get(roomId)
  if (cached && Date.now() - cached.at < 5 * 60e3) return cached
  const { cookie } = await getCookie()
  const q = await signedQuery(cookie, { id: String(roomId), type: '0' })
  const j = await fetchJson(
    `${API_LIVE}/xlive/web-room/v1/index/getDanmuInfo?${q}`,
    cookie,
    `https://live.bilibili.com/${roomId}`,
  )
  if (j?.code !== 0 || !j?.data?.token) {
    throw new Error(`B站弹幕凭证获取失败：${j?.message ?? j?.code ?? '无 token'}`)
  }
  const hosts = (j.data.host_list || [])
    .map((h) => ({ host: String(h.host || ''), wss_port: Number(h.wss_port || 443) }))
    .filter((h) => h.host)
  if (!hosts.length) throw new Error('B站弹幕 host_list 为空')
  const info = { token: String(j.data.token), hosts, at: Date.now() }
  infoCache.set(roomId, info)
  return info
}

/* ------------------------------------------------------------ 协议 --- */

function encodePacket(op, body, protoVer = 1) {
  const bodyBuf =
    body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const buf = Buffer.alloc(HEADER_LEN + bodyBuf.length)
  buf.writeUInt32BE(buf.length, 0)
  buf.writeUInt16BE(HEADER_LEN, 4)
  buf.writeUInt16BE(protoVer, 6)
  buf.writeUInt32BE(op, 8)
  buf.writeUInt32BE(1, 12)
  bodyBuf.copy(buf, HEADER_LEN)
  return buf
}

function parseFrames(buf) {
  const out = []
  let offset = 0
  while (offset + HEADER_LEN <= buf.length) {
    const packLen = buf.readUInt32BE(offset)
    const headerLen = buf.readUInt16BE(offset + 4)
    const protoVer = buf.readUInt16BE(offset + 6)
    const op = buf.readUInt32BE(offset + 8)
    if (headerLen < HEADER_LEN || packLen < headerLen || offset + packLen > buf.length) break
    out.push({ op, protoVer, body: buf.subarray(offset + headerLen, offset + packLen) })
    offset += packLen
  }
  return out
}

function splitJsonObjects(str) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(str.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

function colorOf(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return '#ffffff'
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')
}

/**
 * @param {string} roomId 真实房间号
 * @param {{ onEvent?: (ev:any)=>void, cookie?: string, signal?: AbortSignal }} [opts]
 */
export function open(roomId, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
  const signal = opts.signal
  const rid = String(roomId).trim()

  let closed = false
  let ws = null
  let hbTimer = null
  let reconnectTimer = null
  let attempt = 0
  let hostIndex = 0
  let lastError = ''

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

  function handlePayload(obj) {
    if (!obj || typeof obj !== 'object') return
    const cmd = String(obj.cmd || '')
    if (cmd.startsWith('DANMU_MSG')) {
      const info = obj.info || []
      const text = info[1]
      const user = Array.isArray(info[2]) ? info[2][1] : ''
      if (typeof text !== 'string') return
      const rawColor = Array.isArray(info[3]) ? info[3][0] : info[3]
      emit({ type: 'chat', user: String(user || ''), text, color: colorOf(rawColor), ts: Date.now() })
    } else if (cmd.startsWith('SEND_GIFT')) {
      const d = obj.data || {}
      emit({
        type: 'gift',
        user: String(d.uname || ''),
        text: `${d.action || '投喂'} ${d.giftName || '礼物'} x${d.num || 1}`,
        ts: Date.now(),
      })
    }
  }

  function handleJsonText(str) {
    for (const chunk of splitJsonObjects(str)) {
      try {
        handlePayload(JSON.parse(chunk))
      } catch {
        /* 单条坏 JSON 不影响其它 */
      }
    }
  }

  function handleFrames(buf, ctx, depth) {
    if (depth > 6) return
    for (const f of parseFrames(buf)) {
      if (f.op === OP_MESSAGE) {
        if (f.protoVer === 2) {
          let out
          try {
            out = zlib.inflateSync(f.body)
          } catch {
            continue
          }
          handleFrames(out, ctx, depth + 1)
        } else if (f.protoVer === 3) {
          let out
          try {
            out = zlib.brotliDecompressSync(f.body)
          } catch {
            continue
          }
          handleFrames(out, ctx, depth + 1)
        } else {
          handleJsonText(f.body.toString('utf8'))
        }
      } else if (f.op === OP_AUTH_REPLY) {
        let code = 0
        try {
          code = Number(JSON.parse(f.body.toString('utf8')).code ?? 0)
        } catch {
          code = 0
        }
        if (code === 0) {
          attempt = 0
          if (!ctx.authed) {
            ctx.authed = true
            status('open')
          }
        } else {
          lastError = `B站弹幕认证失败 code=${code}`
          status('error', lastError)
          infoCache.delete(rid) // token 失效，下次重连重新取凭证
          try {
            ctx.socket.close()
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  async function connect() {
    if (closed) return
    status('connecting')
    let info
    try {
      info = await getDanmuInfo(rid)
    } catch (e) {
      lastError = e && e.message ? e.message : String(e)
      scheduleReconnect()
      return
    }
    if (closed) return

    const h = info.hosts[hostIndex % info.hosts.length]
    const url = `wss://${h.host}:${h.wss_port}/sub`
    let socket
    try {
      socket = new WebSocket(url)
    } catch (e) {
      lastError = e && e.message ? e.message : String(e)
      scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    ws = socket
    const ctx = { socket, authed: false }

    socket.addEventListener('open', () => {
      if (closed) return
      const { b3 } = fpCache
      const authBody = JSON.stringify({
        uid: 0,
        roomid: Number(rid),
        protover: 3,
        platform: 'web',
        type: 2,
        key: info.token,
        buvid: b3 || undefined,
      })
      try {
        socket.send(encodePacket(OP_AUTH, authBody, 1))
      } catch {
        /* ignore */
      }
      clearHeartbeat()
      hbTimer = setInterval(() => {
        try {
          socket.send(encodePacket(OP_HEARTBEAT, '', 1))
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS)
    })

    socket.addEventListener('message', async (ev) => {
      if (closed) return
      try {
        const d = ev.data
        if (typeof d === 'string') {
          handleJsonText(d)
          return
        }
        let buf
        if (d instanceof ArrayBuffer) buf = Buffer.from(d)
        else if (ArrayBuffer.isView(d)) buf = Buffer.from(d.buffer, d.byteOffset, d.byteLength)
        else if (d && typeof d.arrayBuffer === 'function') buf = Buffer.from(await d.arrayBuffer())
        else buf = Buffer.from(d)
        handleFrames(buf, ctx, 0)
      } catch {
        /* 解析失败不致命 */
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
      if (lastError) status('error', `B站弹幕连接失败：${lastError}`)
      status('closed')
      closed = true
      return
    }
    const delay = Math.min(8000, 1000 * Math.pow(2, attempt))
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      hostIndex += 1
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
      status('unsupported', 'B站弹幕需要真实房间号（roomId 为空）')
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
