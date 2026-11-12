/**
 * 斗鱼 live adapter. See CONTRACT.md at the plugin root.
 *
 * 移植自 dart_simple_live 的 simple_live_core/lib/src/douyu_site.dart：
 * 分类 m.douyu.com/api/cate/list、列表 gapi/rkc/directory/mixList、
 * 房间 betard、搜索 japi/search/api/searchShow，
 * 取流走 swf_api/homeH5Enc 下发的签名脚本 + lapi/live/getH5Play。
 *
 * @module dsh-simple-live/lib/live/sites/douyu
 */

import { createHash } from 'node:crypto'
import vm from 'node:vm'

export const id = 'douyu'
export const name = '斗鱼'
export const accent = '#ff7a00'
export const playHeaders = { referer: 'https://www.douyu.com/', origin: 'https://www.douyu.com' }

const DID = '1000000000000000000000000001501'
const VER = 'Douyu_223061205'
const PAGE_SIZE = 20
const REFERER = 'https://www.douyu.com/'

function absUrl(u) {
  const s = String(u ?? '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  if (/^https?:\/\//i.test(s)) return s
  return `https://${s}`
}

/** "12.3万" / "2824967" -> number */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v ?? '').trim()
  if (!s) return 0
  const m = s.match(/^([\d.]+)\s*(万|w|W)?/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return Math.round(m[2] ? n * 10000 : n)
}

function withPrefix(msg, err) {
  const detail = err && err.message ? err.message : String(err)
  return new Error(`${msg}：${detail}`)
}

function pageOf(page) {
  const p = Math.floor(Number(page))
  return Number.isFinite(p) && p > 0 ? p : 1
}

/* ------------------------------------------------------------------ 分类 */

export async function categories(http) {
  let list
  try {
    list = await http.json('https://m.douyu.com/api/cate/list', { referer: REFERER })
  } catch (e) {
    throw withPrefix('斗鱼分类获取失败', e)
  }
  const data = list?.data ?? {}
  const cate1 = Array.isArray(data.cate1Info) ? data.cate1Info : []
  const cate2 = Array.isArray(data.cate2Info) ? data.cate2Info : []
  if (!cate1.length) throw new Error('斗鱼分类获取失败：接口未返回分类数据')

  return cate1.map((c) => {
    const cid = String(c.cate1Id)
    const children = cate2
      .filter((s) => String(s.cate1Id) === cid)
      .sort((a, b) => Number(a.cate2Id) - Number(b.cate2Id))
      .map((s) => ({ id: String(s.cate2Id), name: String(s.cate2Name ?? '') }))
    const area = { id: cid, name: String(c.cate1Name ?? '') }
    if (children.length) area.children = children
    return area
  })
}

/* ------------------------------------------------------------------ 列表 */

export async function rooms(http, { area, page } = {}) {
  if (area === undefined || area === null || area === '') throw new Error('斗鱼房间列表获取失败：缺少分区 ID')
  const p = pageOf(page)
  // 面板传来的 area 是 `parent:sub`，斗鱼的列表接口只认二级分区 id。
  const cate = String(area).includes(':') ? String(area).split(':').pop() : String(area)
  const url = `https://www.douyu.com/gapi/rkc/directory/mixList/2_${encodeURIComponent(cate)}/${p}`
  let body
  try {
    body = await http.json(url, { referer: 'https://www.douyu.com/directory/all' })
  } catch (e) {
    throw withPrefix('斗鱼房间列表获取失败', e)
  }
  const data = body?.data ?? {}
  const raw = Array.isArray(data.rl) ? data.rl : []
  const items = raw
    .filter((x) => Number(x.type) === 1)
    .map((x) => ({
      platform: id,
      roomId: String(x.rid),
      title: String(x.rn ?? ''),
      cover: absUrl(x.rs16),
      anchor: String(x.nn ?? ''),
      online: toNum(x.ol),
      live: true,
    }))
  const total = Number(data.pgcnt)
  return { items, hasMore: Number.isFinite(total) ? p < total : items.length >= PAGE_SIZE }
}

/* ------------------------------------------------------------------ 搜索 */

export async function search(http, { keyword, page } = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw new Error('斗鱼搜索失败：缺少关键词')
  const p = pageOf(page)
  // ponytail: 斗鱼搜索接口最多 25 页，超出直接当空页，避免面板翻页时报错
  if (p > 25) return { items: [], hasMore: false }
  const url = `https://www.douyu.com/japi/search/api/searchShow?kw=${encodeURIComponent(kw)}&page=${p}&pageSize=${PAGE_SIZE}`
  let body
  try {
    body = await http.json(url, {
      referer: `https://www.douyu.com/search/${encodeURIComponent(kw)}`,
      headers: { cookie: `dy_did=${DID};acf_did=${DID}` },
    })
  } catch (e) {
    throw withPrefix('斗鱼搜索失败', e)
  }
  if (body?.error !== undefined && Number(body.error) !== 0) {
    throw new Error(`斗鱼搜索失败：${body.msg || `error ${body.error}`}`)
  }
  const raw = Array.isArray(body?.data?.relateShow) ? body.data.relateShow : []
  const items = raw.map((x) => ({
    platform: id,
    roomId: String(x.rid),
    title: String(x.roomName ?? ''),
    cover: absUrl(x.roomSrc),
    anchor: String(x.nickName ?? ''),
    online: toNum(x.hot),
    live: true,
  }))
  return { items, hasMore: items.length >= PAGE_SIZE }
}

/* ------------------------------------------------------- 房间详情 + 清晰度 */

/** 房间基础信息：betard/{rid} */
async function roomInfo(http, rid) {
  const body = await http.json(`https://www.douyu.com/betard/${rid}`, { referer: `https://www.douyu.com/${rid}` })
  const r = body?.room
  if (!r) throw new Error('接口未返回房间数据')
  return {
    platform: id,
    roomId: String(r.room_id ?? rid),
    title: String(r.room_name || `斗鱼 ${rid}`),
    cover: absUrl(r.room_pic),
    anchor: String(r.owner_name ?? ''),
    online: toNum(r.room_biz_all?.hot),
    live: Number(r.show_status) === 1 && Number(r.videoLoop) !== 1,
  }
}

/**
 * homeH5Enc 下发的是每个房间单独混淆过的 JS，里面定义
 * ub98484234(rid, did, tt) -> "v=<salt>&did=..&tt=..&sign=.."。
 * 脚本内部通过 eval 调用 CryptoJS.MD5，这里补一个只做 md5-hex 的 shim。
 */
async function signParams(http, rid) {
  const enc = await http.json(`https://www.douyu.com/swf_api/homeH5Enc?rids=${rid}`, {
    referer: `https://www.douyu.com/${rid}`,
  })
  const src = enc?.data?.[`room${rid}`]
  if (typeof src !== 'string' || !src) throw new Error('签名脚本获取失败')

  const ctx = vm.createContext({
    console,
    CryptoJS: { MD5: (v) => ({ toString: () => createHash('md5').update(String(v)).digest('hex') }) },
  })
  vm.runInContext(src, ctx, { timeout: 8000 })
  const tt = String(Math.floor(Date.now() / 1000))
  const out = vm.runInContext(
    `ub98484234(${JSON.stringify(rid)},${JSON.stringify(DID)},${JSON.stringify(tt)})`,
    ctx,
    { timeout: 8000 },
  )
  if (typeof out !== 'string' || !out.includes('sign=')) throw new Error('签名计算失败')
  return out
}

/** getH5Play：返回 { multirates, cdn, url } */
async function playOnce(http, rid, sign, cdn, rate) {
  const body = `${sign}&cdn=${cdn}&rate=${rate}&ver=${VER}&iar=1&ive=1&hevc=0&fa=0`
  const res = await http.json(`https://www.douyu.com/lapi/live/getH5Play/${rid}`, {
    method: 'POST',
    body,
    referer: `https://www.douyu.com/${rid}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  if (res?.error !== undefined && Number(res.error) !== 0) throw new Error(res.msg || `取流失败 error ${res.error}`)
  const d = res?.data
  if (!d?.rtmp_url || !d?.rtmp_live) throw new Error('接口未返回播放地址')
  return { data: d, url: `${d.rtmp_url}/${String(d.rtmp_live)}` }
}

/** 只读第一块判断是不是 m3u8 */
async function isHls(http, url) {
  try {
    const res = await http.request(url, { headers: { referer: REFERER }, timeout: 8000 })
    if (res.status !== 200 || !res.body) return false
    const reader = res.body.getReader()
    const { value } = await reader.read()
    try {
      await reader.cancel()
    } catch {}
    return Buffer.from(value ?? new Uint8Array()).subarray(0, 7).toString('latin1') === '#EXTM3U'
  } catch {
    return false
  }
}

const toHls = (url) => (url.includes('.flv') ? url.replace('.flv', '.m3u8') : '')

/** 斗鱼 H5 只给 flv；华为系 CDN（hw-h5 / hs-h5）把后缀换成 .m3u8 后是真 HLS */
async function qualities(http, rid) {
  const sign = await signParams(http, rid)
  const probe = await playOnce(http, rid, sign, '', -1)

  const rates = (Array.isArray(probe.data.multirates) ? probe.data.multirates : [])
    .map((r) => ({ name: String(r.name || `清晰度${r.rate}`), rate: Number(r.rate) }))
    .filter((r) => Number.isFinite(r.rate))
  const cdns = (Array.isArray(probe.data.cdnsWithName) ? probe.data.cdnsWithName : [])
    .map((c) => String(c.cdn ?? ''))
    .filter(Boolean)
  // 自建 scdn 不提供 HLS，排到最后
  const ordered = [...cdns.filter((c) => !c.startsWith('scdn')), ...cdns.filter((c) => c.startsWith('scdn'))]
  const best = rates[0]

  if (best) {
    for (const cdn of ordered.slice(0, 3)) {
      let base
      try {
        base = await playOnce(http, rid, sign, cdn, best.rate)
      } catch {
        continue
      }
      const hls = toHls(base.url)
      if (hls && (await isHls(http, hls))) {
        const list = [{ name: best.name, url: hls, format: 'hls' }]
        for (const r of rates.slice(1)) {
          try {
            const one = await playOnce(http, rid, sign, cdn, r.rate)
            const u = toHls(one.url)
            if (u) list.push({ name: r.name, url: u, format: 'hls' })
          } catch {}
        }
        return list
      }
    }
  }

  // 兜底：FLV
  const fallbackCdn = ordered[0] ?? ''
  const list = []
  const rateList = rates.length ? rates : [{ name: '原画', rate: -1 }]
  for (const r of rateList) {
    try {
      const one =
        r.rate === -1 && fallbackCdn === ''
          ? { url: probe.url }
          : await playOnce(http, rid, sign, fallbackCdn, r.rate)
      list.push({ name: r.name, url: one.url, format: 'flv' })
    } catch {}
  }
  if (!list.length) throw new Error('没有可用的播放地址')
  return list
}

export async function room(http, { roomId } = {}) {
  const rid = String(roomId ?? '').trim()
  if (!/^\d+$/.test(rid)) throw new Error('斗鱼房间号无效')

  let info
  try {
    info = await roomInfo(http, rid)
  } catch (e) {
    throw withPrefix('斗鱼房间信息获取失败', e)
  }
  if (!info.live) return { ...info, qualities: [] }

  try {
    info.qualities = await qualities(http, rid)
  } catch (e) {
    throw withPrefix('斗鱼播放地址获取失败', e)
  }
  return info
}
