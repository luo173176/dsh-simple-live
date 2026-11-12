/**
 * 斗鱼直播弹幕：真实现（走 WebSocket + 斗鱼 STT 文本 + 二进制 Packet 帧）。
 *
 * 说明：斗鱼旧版 `openbarrage.douyucdn.cn:8601` 纯 TCP 已不可用（DNS 不存在）。
 * 现网弹幕代理是 `wss://danmuproxy.douyu.com:<8501..8506>/`：
 *   - 帧格式（小端）：[4]messageLength [4]messageLength [2]689 [2]0 [body + '\0']
 *   - body 是 STT 文本：`key@=value/...`，'@'→'@A'、'/'→'@S'
 *   - 登录 `type@=loginreq/roomid@=<rid>/`，加入 `type@=joingroup/rid@=<rid>/gid@=-9999/`
 *   - 心跳 `type@=mrkl/` 每 45s
 *   - 弹幕 `type@=chatmsg`，字段 nn=(昵称) txt=(内容) col=(颜色，可缺省)
 *
 * 零第三方依赖：全局 WebSocket + Buffer（binaryType='arraybuffer'）。
 *
 * @module dsh-simple-live/lib/live/danmaku/douyu
 */

const DANMU_PORTS = [8501, 8502, 8503, 8504, 8505, 8506]
const HEARTBEAT_MS = 45000
const MAX_RECONNECT = 5
const HEADER_LEN_TOTAL = 12
const HEADER_LEN_SIZE = 4

/* -------------------------------------------------------- STT 文本协议 --- */

function sttEscape(v) {
  return String(v).replace(/@/g, '@A').replace(/\//g, '@S')
}
function sttUnescape(v) {
  return v.replace(/@S/g, '/').replace(/@A/g, '@')
}
/** {type:'loginreq',roomid:'1'} -> 'type@=loginreq/roomid@=1/' */
function sttSerialize(obj) {
  let s = ''
  for (const [k, v] of Object.entries(obj)) s += `${k}@=${sttEscape(v)}/`
  return s
}
/** 'type@=chatmsg/nn@=a/txt@=b/' -> {type:'chatmsg',nn:'a',txt:'b'} */
function sttParse(raw) {
  const out = {}
  for (const part of String(raw).split('/')) {
    if (!part) continue
    const i = part.indexOf('@=')
    if (i < 0) continue
    out[part.slice(0, i)] = sttUnescape(part.slice(i + 2))
  }
  return out
}

/* ------------------------------------------------------ 二进制 Packet 帧 --- */

function encodePacket(text) {
  const body = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])])
  const messageLength = body.length + HEADER_LEN_SIZE * 2 // body + 8
  const buf = Buffer.alloc(body.length + HEADER_LEN_TOTAL)
  buf.writeUInt32LE(messageLength, 0)
  buf.writeUInt32LE(messageLength, 4)
  buf.writeInt16LE(689, 8)
  buf.writeInt16LE(0, 10)
  body.copy(buf, HEADER_LEN_TOTAL)
  return buf
}

/** 把二进制缓冲拆成若干 STT 文本（可多帧拼接）。 */
function decodePackets(buf) {
  const out = []
  let offset = 0
  while (offset + HEADER_LEN_SIZE <= buf.length) {
    const readLength = buf.readUInt32LE(offset)
    offset += HEADER_LEN_SIZE
    if (readLength < HEADER_LEN_TOTAL - HEADER_LEN_SIZE + 1) break
    if (offset + readLength > buf.length) break
    const bodyStart = offset + (HEADER_LEN_TOTAL - HEADER_LEN_SIZE)
    const bodyLength = readLength - (HEADER_LEN_TOTAL - HEADER_LEN_SIZE) - 1
    out.push(buf.toString('utf8', bodyStart, bodyStart + bodyLength))
    offset += readLength
  }
  return out
}

function colorOf(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return undefined
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')
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
  let portIndex = 0
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

  function handleStt(raw) {
    const m = sttParse(raw)
    const type = m.type
    if (type === 'chatmsg') {
      const chat = { type: 'chat', user: m.nn || '', text: m.txt || '', ts: Date.now() }
      const color = colorOf(m.col)
      if (color) chat.color = color
      emit(chat)
    } else if (type === 'dgb') {
      emit({
        type: 'gift',
        user: m.nn || '',
        text: `赠送礼物 x${m.gfcnt || m.gc || 1}`,
        ts: Date.now(),
      })
    } else if (type === 'error') {
      lastError = `斗鱼弹幕服务返回错误：${m.error || m.msg || '未知'}`
      status('error', lastError)
    }
  }

  function connect() {
    if (closed) return
    status('connecting')
    const port = DANMU_PORTS[portIndex % DANMU_PORTS.length]
    const url = `wss://danmuproxy.douyu.com:${port}/`
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
    const ctx = { authed: false }

    function markOpen() {
      if (ctx.authed) return
      ctx.authed = true
      attempt = 0
      status('open')
    }

    socket.addEventListener('open', () => {
      if (closed) return
      try {
        socket.send(encodePacket(sttSerialize({ type: 'loginreq', roomid: rid })))
        socket.send(encodePacket(sttSerialize({ type: 'joingroup', rid, gid: '-9999' })))
      } catch (e) {
        lastError = e && e.message ? e.message : String(e)
      }
      clearHeartbeat()
      hbTimer = setInterval(() => {
        try {
          socket.send(encodePacket(sttSerialize({ type: 'mrkl' })))
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
        if (typeof d === 'string') {
          buf = Buffer.from(d, 'utf8')
        } else if (d instanceof ArrayBuffer) {
          buf = Buffer.from(d)
        } else if (ArrayBuffer.isView(d)) {
          buf = Buffer.from(d.buffer, d.byteOffset, d.byteLength)
        } else if (d && typeof d.arrayBuffer === 'function') {
          buf = Buffer.from(await d.arrayBuffer())
        } else {
          buf = Buffer.from(d)
        }
        for (const raw of decodePackets(buf)) {
          const t = sttParse(raw).type
          if (t === 'loginres') markOpen()
          handleStt(raw)
          if (!ctx.authed) markOpen() // 收到任何业务包也视为握手成功
        }
      } catch {
        /* 单帧解析失败不影响连接 */
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
      if (lastError) status('error', `斗鱼弹幕连接失败：${lastError}`)
      status('closed')
      closed = true
      return
    }
    const delay = Math.min(8000, 1000 * Math.pow(2, attempt))
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      portIndex += 1
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
      status('unsupported', '斗鱼弹幕需要真实房间号（roomId 为空）')
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
