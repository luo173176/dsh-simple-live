/**
 * Tiny fetch wrapper shared by every live-site adapter.
 *
 * Node's global fetch (undici) sends whatever we pass as headers, including
 * Referer, so the adapters can look like a real browser without a TLS client.
 *
 * @module dsh-simple-live/lib/live/http
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** @param {number} ms */
function timeoutSignal(ms, outer) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), ms)
  if (outer) {
    if (outer.aborted) ac.abort(outer.reason)
    else outer.addEventListener('abort', () => ac.abort(outer.reason), { once: true })
  }
  return { signal: ac.signal, done: () => clearTimeout(timer) }
}

/**
 * @param {{ ua?: string, cookieFor?: (host: string) => string }} [defaults]
 *   cookieFor：按目标域名给出该平台的登录 cookie，用于把用户在「我的 →
 *   账号」里填的 cookie 自动带到该平台的所有请求上（提升搜索/清晰度成功率）。
 */
export function createHttp(defaults = {}) {
  const baseUa = defaults.ua ?? UA
  const cookieFor = typeof defaults.cookieFor === 'function' ? defaults.cookieFor : null

  /**
   * @param {string} url
   * @param {{ method?: string, headers?: Record<string,string>, body?: any,
   *           referer?: string, timeout?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<Response>}
   */
  async function request(url, opts = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      referer,
      timeout = 12000,
      signal: outer,
    } = opts
    const final = { 'user-agent': baseUa, 'accept-language': 'zh-CN,zh;q=0.9', ...headers }
    if (referer && !('referer' in final) && !('Referer' in final)) final.referer = referer
    // 有对应平台的登录 cookie 且调用方没自带 cookie 时补上
    if (cookieFor && !('cookie' in final) && !('Cookie' in final)) {
      try {
        const cookie = cookieFor(new URL(url).hostname)
        if (cookie) final.cookie = cookie
      } catch {
        /* url 解析失败就跳过 cookie 注入 */
      }
    }
    const { signal, done } = timeoutSignal(timeout, outer)
    try {
      return await fetch(url, {
        method,
        headers: final,
        body,
        signal,
        redirect: 'follow',
        duplex: body ? 'half' : undefined,
      })
    } finally {
      done()
    }
  }

  async function text(url, opts) {
    const res = await request(url, opts)
    return res.text()
  }

  async function json(url, opts) {
    const res = await request(url, opts)
    const raw = await res.text()
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`non-JSON response from ${url}: ${raw.slice(0, 160)}`)
    }
  }

  async function buffer(url, opts) {
    const res = await request(url, opts)
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
  }

  return { request, text, json, buffer, ua: baseUa }
}
