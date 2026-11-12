/**
 * 播放代理：浏览器不能直连各平台 CDN（防盗链 + CORS + hls.js 需要可跨域的分片），
 * 所以 m3u8 与分片都从本机插件进程转发，并按平台补上 Referer/Origin。
 *
 * @module dsh-simple-live/lib/live/proxy
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HLS_ASSET = fileURLToPath(new URL('../../vendor/hls.min.js', import.meta.url))

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,HEAD,OPTIONS',
}

const MEDIA_TYPES = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  flv: 'video/x-flv',
  key: 'application/octet-stream',
}

function extOf(url) {
  const path = String(url).split('?')[0]
  const m = path.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}

/** 把 m3u8 里的每一行 URI 改写成走本机代理的地址。 */
export function rewritePlaylist(body, baseUrl, streamPath) {
  const toProxy = (uri) => {
    const abs = new URL(uri, baseUrl).toString()
    return streamPath(abs)
  }
  return body
    .split('\n')
    .map((line) => {
      const raw = line.trim()
      if (!raw) return line
      if (!raw.startsWith('#')) return toProxy(raw)
      if (!/URI="/i.test(raw)) return line
      return raw.replace(/URI="([^"]+)"/gi, (_m, uri) => `URI="${toProxy(uri)}"`)
    })
    .join('\n')
}

/**
 * @param {{ request: Function }} http
 * @param {(id: string) => any} findSite
 */
export function createPlayProxy(http, findSite) {
  let hlsSource = null

  function hlsScript() {
    if (hlsSource === null) hlsSource = readFileSync(HLS_ASSET, 'utf8')
    return hlsSource
  }

  /** `/simple-live/stream?platform=<id>&u=<absolute url>` */
  function streamPath(absUrl, platform = '') {
    const qs = new URLSearchParams({ u: absUrl })
    if (platform) qs.set('platform', platform)
    return `/simple-live/stream?${qs}`
  }

  /**
   * @param {Request} request
   * @param {string} platform
   * @param {string} target 上游绝对地址
   * @param {string} [range]
   */
  async function pipe(request, platform, target, range) {
    const site = findSite(platform)
    const headers = { ...(site?.playHeaders ?? {}) }
    if (range) headers.range = range
    const upstream = await http.request(target, {
      headers,
      timeout: 20000,
      signal: request.signal,
    })
    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`上游返回 ${upstream.status}`, {
        status: 502,
        headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    const type = String(upstream.headers.get('content-type') ?? '')
    const isList = type.includes('mpegurl') || (type.includes('text/plain') && extOf(target) === 'm3u8') || extOf(target) === 'm3u8'
    if (isList) {
      const text = rewritePlaylist(await upstream.text(), target, (u) => streamPath(u, platform))
      return new Response(text, {
        status: 200,
        headers: {
          ...CORS,
          'content-type': MEDIA_TYPES.m3u8,
          'cache-control': 'no-store',
        },
      })
    }
    const out = {
      ...CORS,
      'content-type': type || MEDIA_TYPES[extOf(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }
    const len = upstream.headers.get('content-length')
    if (len) out['content-length'] = len
    const cr = upstream.headers.get('content-range')
    if (cr) out['content-range'] = cr
    const ar = upstream.headers.get('accept-ranges')
    if (ar) out['accept-ranges'] = ar
    return new Response(upstream.body, { status: upstream.status, headers: out })
  }

  return {
    streamPath,
    hlsScript,

    /** 路由入口：由 index.js 的 webServer resource handler 调用。 */
    async handle(request, pathname) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

      if (pathname === '/simple-live/vendor/hls.min.js') {
        return new Response(hlsScript(), {
          status: 200,
          headers: {
            ...CORS,
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'public, max-age=86400',
          },
        })
      }

      if (pathname === '/simple-live/stream') {
        const url = new URL(request.url)
        const target = url.searchParams.get('u')
        if (!target || !/^https?:\/\//i.test(target)) {
          return new Response('缺少或非法的 u 参数', {
            status: 400,
            headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
          })
        }
        try {
          return await pipe(request, url.searchParams.get('platform') ?? '', target, request.headers.get('range'))
        } catch (err) {
          return new Response(`拉流失败：${err?.message ?? err}`, {
            status: 502,
            headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
          })
        }
      }

      return new Response('not found', { status: 404, headers: CORS })
    },
  }
}
