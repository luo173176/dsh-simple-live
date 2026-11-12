/**
 * 虎牙直播弹幕：零依赖降级为 unsupported。
 *
 * 虎牙弹幕走 TARS 二进制编码（WebSocket + TARS 序列化 + 自定义心跳/注册），
 * 在零第三方依赖约束下实现成本过高且易碎，故按契约明确降级：
 * 先发 status:unsupported（含中文原因），再发 status:closed，绝不抛异常。
 *
 * @module dsh-simple-live/lib/live/danmaku/huya
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
      message: '虎牙弹幕需要 TARS 二进制编码与自定义注册/心跳，零依赖实现暂不支持',
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
