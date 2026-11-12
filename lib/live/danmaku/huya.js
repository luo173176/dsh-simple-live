/**
 * 虎牙直播弹幕：真实现（WebSocket + TARS 二进制编码 + 自定义注册/心跳）。
 *
 * 协议要点（实测 2026-11，Node 22 全局 WebSocket / fetch，零第三方依赖）：
 *   1) 先抓 `https://m.huya.com/<roomId>`（移动 UA），从内联 `window.HNF_GLOBAL_INIT`
 *      JSON 里取注册所需的两个 id：
 *        - topSid/subSid = 房间频道号（roomProfile.lUid / tLiveInfo.lChannel / tRecentLive.lChannel）
 *        - ayyuid        = 主播/房间 YY 号（tProfileInfo.lYyid / roomProfile.lYyid）
 *   2) WebSocket 连 `wss://cdnws.api.huya.com`，连上即发送注册帧（TARS）：
 *        外层 WSCommand { command:int32 tag0 = 1（注册）, data:bytes tag1 = 内层 }
 *        内层 Register  { ayyuid:int64 tag0, true:bool tag1, "" tag2, "" tag3,
 *                          tid:int64 tag4=topSid, sid:int64 tag5=topSid, 0 tag6, 0 tag7 }
 *   3) 心跳：固定字节 base64 `ABQdAAwsNgBM`，每 60s 发一次。
 *   4) 下行帧：外层 { command:int32 tag0, data:bytes tag1 }。
 *        command=2      -> 注册回执（视为握手成功，发 status:open）
 *        command=7      -> 推送：data 解出 HYPushMessage { pushType tag0, uri tag1, msg tag2 }
 *            uri=1400    -> 弹幕：msg 解出 HYMessage { userInfo:struct tag0, content:str tag3,
 *                                                    bulletFormat:struct tag6 }
 *                          userInfo 的 nickName 在 tag2，颜色在 bulletFormat 的 fontColor tag0
 *            uri=6501    -> 礼物（尽力解析，字段不确定时静默跳过）
 *            uri=8006    -> 在线人数（忽略）
 *
 * 零第三方依赖：全局 WebSocket + fetch + Buffer。
 *
 * @module dsh-simple-live/lib/live/danmaku/huya
 */

const WS_URL = 'wss://cdnws.api.huya.com'
const HEARTBEAT = Buffer.from('ABQdAAwsNgBM', 'base64')
const HEARTBEAT_MS = 60000
const MAX_RECONNECT = 5
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/90.0.4430.91 Mobile Safari/537.36 Edg/117.0.0.0'

/* ------------------------------------------------------- TARS 编解码 --- */

class TarsWriter {
  constructor() {
    this.bytes = []
  }
  head(tag, type) {
    if (tag < 15) this.bytes.push((tag << 4) | type)
    else {
      this.bytes.push(0xf0 | type)
      this.bytes.push(tag - 15)
    }
  }
  int(value, tag) {
    const v = Number(value) || 0
    if (v === 0) return this.head(tag, 12) // ZERO
    if (v >= -128 && v <= 127) {
      this.head(tag, 0) // INT8
      this.bytes.push(v & 0xff)
    } else if (v >= -32768 && v <= 32767) {
      this.head(tag, 1) // INT16
      const b = Buffer.alloc(2)
      b.writeInt16BE(v)
      this.bytes.push(...b)
    } else if (v >= -2147483648 && v <= 2147483647) {
      this.head(tag, 2) // INT32
      const b = Buffer.alloc(4)
      b.writeInt32BE(v)
      this.bytes.push(...b)
    } else {
      this.head(tag, 3) // INT64
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(BigInt(value))
      this.bytes.push(...b)
    }
  }
  bool(value, tag) {
    this.head(tag, 0)
    this.bytes.push(value ? 1 : 0)
  }
  str(value, tag) {
    const e = Buffer.from(String(value), 'utf8')
    if (e.length <= 255) {
      this.head(tag, 6) // STRING1
      this.bytes.push(e.length)
    } else {
      this.head(tag, 7) // STRING4
      const b = Buffer.alloc(4)
      b.writeInt32BE(e.length)
      this.bytes.push(...b)
    }
    this.bytes.push(...e)
  }
  bytesField(buf, tag) {
    this.head(tag, 13) // SIMPLELIST<byte>
    this.bytes.push(0) // element type = byte
    if (buf.length <= 127) {
      this.head(0, 0)
      this.bytes.push(buf.length)
    } else {
      this.head(0, 2)
      const b = Buffer.alloc(4)
      b.writeInt32BE(buf.length)
      this.bytes.push(...b)
    }
    this.bytes.push(...buf)
  }
  out() {
    return Buffer.from(this.bytes)
  }
}

/** 通用 TARS 读取器：把一个结构体解成 { tag: value }。 */
class TarsReader {
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }
  head() {
    let b = this.buf[this.pos++]
    let type = b & 0x0f
    let tag = b >> 4
    if (tag === 15) tag = this.buf[this.pos++] + 15
    return { tag, type }
  }
  value(type) {
    switch (type) {
      case 0: {
        const v = this.buf.readInt8(this.pos)
        this.pos += 1
        return v
      }
      case 1: {
        const v = this.buf.readInt16BE(this.pos)
        this.pos += 2
        return v
      }
      case 2: {
        const v = this.buf.readInt32BE(this.pos)
        this.pos += 4
        return v
      }
      case 3: {
        const v = Number(this.buf.readBigInt64BE(this.pos))
        this.pos += 8
        return v
      }
      case 4: {
        const v = this.buf.readFloatBE(this.pos)
        this.pos += 4
        return v
      }
      case 5: {
        const v = this.buf.readDoubleBE(this.pos)
        this.pos += 8
        return v
      }
      case 6: {
        const n = this.buf.readUInt8(this.pos)
        this.pos += 1
        const s = this.buf.toString('utf8', this.pos, this.pos + n)
        this.pos += n
        return s
      }
      case 7: {
        const n = this.buf.readUInt32BE(this.pos)
        this.pos += 4
        const s = this.buf.toString('utf8', this.pos, this.pos + n)
        this.pos += n
        return s
      }
      case 8: {
        const h = this.head()
        const n = this.value(h.type)
        const m = {}
        for (let i = 0; i < n; i++) {
          const hk = this.head()
          const k = this.value(hk.type)
          const hv = this.head()
          m[k] = this.value(hv.type)
        }
        return m
      }
      case 9: {
        const h = this.head()
        const n = this.value(h.type)
        const a = []
        for (let i = 0; i < n; i++) {
          const hh = this.head()
          a.push(this.value(hh.type))
        }
        return a
      }
      case 10:
        return this.struct()
      case 11:
        return undefined
      case 12:
        return 0
      case 13: {
        const elemType = this.buf[this.pos++]
        const h = this.head()
        const n = this.value(h.type)
        if (elemType === 0) {
          const out = Buffer.from(this.buf.subarray(this.pos, this.pos + n))
          this.pos += n
          return out
        }
        const a = []
        for (let i = 0; i < n; i++) a.push(this.value(elemType))
        return a
      }
      default:
        throw new Error('未知 TARS 类型 ' + type)
    }
  }
  struct() {
    const o = {}
    while (this.pos < this.buf.length) {
      const { tag, type } = this.head()
      if (type === 11) break // STRUCT_END
      o[tag] = this.value(type)
    }
    return o
  }
}

/** 组装注册帧：WSCommand{command=1, data=Register{...}}。 */
function buildJoinFrame(topSid, ayyuid) {
  const inner = new TarsWriter()
  inner.int(ayyuid, 0)
  inner.bool(true, 1)
  inner.str('', 2)
  inner.str('', 3)
  inner.int(topSid, 4)
  inner.int(topSid, 5)
  inner.int(0, 6)
  inner.int(0, 7)

  const outer = new TarsWriter()
  outer.int(1, 0) // command = 1（注册）
  outer.bytesField(inner.out(), 1)
  return outer.out()
}

function colorOf(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return undefined
  return '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0')
}

/** 从 m.huya.com 页面解析注册所需的 topSid / ayyuid。 */
async function resolveArgs(roomId) {
  const res = await fetch(`https://m.huya.com/${roomId}`, {
    headers: { 'user-agent': MOBILE_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
  })
  if (!res.ok) throw new Error(`房间页 HTTP ${res.status}`)
  const html = await res.text()

  let topSid
  let ayyuid

  // 1) 优先解析内联 HNF_GLOBAL_INIT JSON
  try {
    const marker = html.indexOf('window.HNF_GLOBAL_INIT')
    if (marker >= 0) {
      const eq = html.indexOf('=', marker)
      const start = html.indexOf('{', eq)
      let depth = 0
      let end = -1
      let inStr = false
      let esc = false
      for (let p = start; p < html.length; p++) {
        const c = html[p]
        if (inStr) {
          if (esc) esc = false
          else if (c === '\\') esc = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') inStr = true
        else if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            end = p + 1
            break
          }
        }
      }
      const obj = JSON.parse(html.slice(start, end))
      const rp = obj.roomProfile || {}
      const ri = obj.roomInfo || {}
      const tpi = ri.tProfileInfo || {}
      const tli = ri.tLiveInfo || {}
      const trl = ri.tRecentLive || {}
      topSid = tli.lChannel || trl.lChannel || rp.lUid || tpi.lUid || trl.lUid
      ayyuid = tpi.lYyid || rp.lYyid || trl.lYyid
    }
  } catch {
    /* 落到正则兜底 */
  }

  // 2) 正则兜底
  if (!topSid) {
    const m = html.match(/lChannel[Ii]d"\s*:\s*(\d+)/) || html.match(/"lUid"\s*:\s*(\d+)/)
    if (m) topSid = Number(m[1])
  }
  if (!ayyuid) {
    const m = html.match(/lYyid"\s*:\s*(\d+)/)
    if (m) ayyuid = Number(m[1])
  }
  if (!ayyuid) ayyuid = topSid

  topSid = Number(topSid) || 0
  ayyuid = Number(ayyuid) || 0
  if (!topSid) throw new Error('未能在房间页解析到频道号（可能房间不存在或页面结构变更）')
  return { topSid, ayyuid }
}

/**
 * @param {string} roomId 真实房间号（与 URL 一致）
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

  /** 处理一个下行帧；解析失败不影响连接。 */
  function handleFrame(buf, ctx) {
    let top
    try {
      top = new TarsReader(buf).struct()
    } catch {
      return
    }
    const cmd = top[0]
    // command=2：注册回执；command=7：业务推送 —— 两者都说明链路已通
    if (cmd === 2 || cmd === 7) ctx.authed = true
    if (cmd !== 7 || !Buffer.isBuffer(top[1])) return

    let push
    try {
      push = new TarsReader(top[1]).struct()
    } catch {
      return
    }
    const uri = push[1]
    const msg = push[2]
    if (!Buffer.isBuffer(msg)) return

    if (uri === 1400) {
      let m
      try {
        m = new TarsReader(msg).struct()
      } catch {
        return
      }
      const nick = m[0] && typeof m[0] === 'object' ? m[0][2] : ''
      const text = m[3]
      if (typeof text !== 'string' || text === '') return
      const chat = { type: 'chat', user: String(nick || ''), text, ts: Date.now() }
      const color = m[6] && typeof m[6] === 'object' ? colorOf(m[6][0]) : undefined
      if (color) chat.color = color
      emit(chat)
    } else if (uri === 6501) {
      // 礼物：字段随版本而异，尽力解析，失败静默
      let m
      try {
        m = new TarsReader(msg).struct()
      } catch {
        return
      }
      const nick = m[0] && typeof m[0] === 'object' ? m[0][2] : ''
      const text = m[3] || m[4] || ''
      if (typeof text === 'string' && text) {
        emit({ type: 'gift', user: String(nick || ''), text, ts: Date.now() })
      }
    }
  }

  async function connect() {
    if (closed) return
    status('connecting')

    let args = cachedArgs
    if (!args) {
      try {
        args = await resolveArgs(rid)
        cachedArgs = args
      } catch (e) {
        lastError = e && e.message ? e.message : String(e)
        scheduleReconnect()
        return
      }
    }

    if (closed) return

    let socket
    try {
      socket = new WebSocket(WS_URL)
    } catch (e) {
      lastError = e && e.message ? e.message : String(e)
      scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    ws = socket
    const ctx = { authed: false, opened: false }

    function markOpen() {
      if (ctx.opened) return
      ctx.opened = true
      attempt = 0
      status('open')
    }

    socket.addEventListener('open', () => {
      if (closed) return
      try {
        socket.send(buildJoinFrame(args.topSid, args.ayyuid))
      } catch (e) {
        lastError = e && e.message ? e.message : String(e)
      }
      clearHeartbeat()
      hbTimer = setInterval(() => {
        try {
          socket.send(HEARTBEAT)
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
        handleFrame(buf, ctx)
        if (ctx.authed) markOpen()
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
      if (lastError) status('error', `虎牙弹幕连接失败：${lastError}`)
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
      status('unsupported', '虎牙弹幕需要真实房间号（roomId 为空）')
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
