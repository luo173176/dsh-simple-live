/**
 * 抖音直播弹幕：零依赖降级为 unsupported。
 *
 * 抖音弹幕走 Protobuf（WebSocket + protobuf 消息 + 签名/设备参数），
 * 零第三方依赖下需要手写 protobuf 编解码并处理复杂的签名链路，成本过高且易碎，
 * 故按契约明确降级：先发 status:unsupported（含中文原因），再发 status:closed，绝不抛异常。
 *
 * @module dsh-simple-live/lib/live/danmaku/douyin
 */

/**
 * @param {string} roomId
 * @param {{ onEvent?: (ev:any)=>void, cookie?: string, signal?: AbortSignal }} [opts]
 */
export function open(roomId, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
  let closed = false
  const emit = (ev) => {
    try {
      onEvent(ev)
    } catch {
      /* swallow */
    }
  }

  queueMicrotask(() => {
    if (closed) return
    emit({ type: 'status', state: 'connecting' })
    emit({
      type: 'status',
      state: 'unsupported',
      message: '抖音弹幕需要 Protobuf 编解码与设备签名链路，零依赖实现暂不支持',
    })
    emit({ type: 'status', state: 'closed' })
    closed = true
  })

  return {
    close() {
      closed = true
    },
  }
}
