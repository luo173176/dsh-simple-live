/**
 * 弹幕入口：按 platform 分派到各平台实现。
 *
 * @module dsh-simple-live/lib/live/danmaku
 */

import * as bilibili from './bilibili.js'
import * as douyu from './douyu.js'
import * as huya from './huya.js'
import * as douyin from './douyin.js'

const ADAPTERS = { bilibili, douyu, huya, douyin }

/**
 * 打开某平台的弹幕连接。
 *
 * @param {'bilibili'|'douyu'|'huya'|'douyin'} platform
 * @param {string} roomId
 * @param {{ onEvent?: (ev:any)=>void, cookie?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ close(): void }>}
 */
export async function open(platform, roomId, opts = {}) {
  const adapter = ADAPTERS[platform]
  if (!adapter) {
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
    const emit = (ev) => {
      try {
        onEvent(ev)
      } catch {
        /* swallow */
      }
    }
    emit({ type: 'status', state: 'connecting' })
    emit({ type: 'status', state: 'unsupported', message: `未知平台：${platform}` })
    emit({ type: 'status', state: 'closed' })
    return { close() {} }
  }
  return adapter.open(String(roomId), opts)
}
