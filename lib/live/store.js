/**
 * 本地持久化：收藏 / 观看历史 / 设置 / 平台登录 cookie。
 *
 * 全部落在 `~/.dsh/simple-live/*.json`，读失败一律降级为空并继续工作，
 * 写失败只影响持久化、不影响本次会话。
 *
 * @module dsh-simple-live/lib/live/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function readJson(file, fallback) {
  try {
    const raw = readFileSync(file, 'utf8')
    const value = JSON.parse(raw)
    return value ?? fallback
  } catch {
    return fallback
  }
}

/** 原子写（先写临时文件再改名），避免并发写坏 JSON。 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/* --------------------------------------------------------------- 收藏 --- */

function createFollows(file) {
  let list = readJson(file, [])
  if (!Array.isArray(list)) list = []
  const save = () => {
    try {
      writeJson(file, list)
    } catch {
      /* 落盘失败不影响收藏操作的内存状态 */
    }
  }
  return {
    list: () => list.slice(),
    has: (platform, roomId) => list.some((f) => f.platform === platform && f.roomId === String(roomId)),
    add(entry) {
      if (!entry?.platform || !entry?.roomId) return list.slice()
      if (!this.has(entry.platform, entry.roomId)) list.push({ ...entry, roomId: String(entry.roomId) })
      save()
      return list.slice()
    },
    remove(platform, roomId) {
      list = list.filter((f) => !(f.platform === platform && f.roomId === String(roomId)))
      save()
      return list.slice()
    },
  }
}

/* --------------------------------------------------------------- 历史 --- */

const HISTORY_CAP = 200

function createHistory(file) {
  let list = readJson(file, [])
  if (!Array.isArray(list)) list = []
  const save = () => {
    try {
      writeJson(file, list)
    } catch {
      /* 同上 */
    }
  }
  return {
    list: () => list.slice(),
    /** 记录一次观看：同房间去重并提到最前，超出上限裁掉最旧的。 */
    add(entry) {
      if (!entry?.platform || !entry?.roomId) return list.slice()
      const roomId = String(entry.roomId)
      const item = { ...entry, roomId, at: Number(entry.at) || Date.now() }
      list = list.filter((h) => !(h.platform === item.platform && h.roomId === roomId))
      list.unshift(item)
      if (list.length > HISTORY_CAP) list = list.slice(0, HISTORY_CAP)
      save()
      return list.slice()
    },
    remove(platform, roomId) {
      list = list.filter((h) => !(h.platform === platform && h.roomId === String(roomId)))
      save()
      return list.slice()
    },
    clear() {
      list = []
      save()
      return []
    },
  }
}

/* --------------------------------------------------------------- 设置 --- */

const SETTINGS_DEFAULTS = {
  danmaku: true, // 弹幕开关
  danmakuOpacity: 0.9, // 0.2 ~ 1
  danmakuSize: 16, // 12 ~ 28 px
  danmakuSpeed: 10, // 一条弹幕横穿屏幕的秒数，4 ~ 20
  autoplay: true, // 打开房间自动播放
  quality: 'auto', // auto | 'best' | 'low'
  historyLimit: HISTORY_CAP,
}

function createSettings(file) {
  const stored = readJson(file, {})
  let value = { ...SETTINGS_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) }
  const save = () => {
    try {
      writeJson(file, value)
    } catch {
      /* 同上 */
    }
  }
  return {
    get: () => ({ ...value }),
    patch(patch) {
      if (!patch || typeof patch !== 'object') return { ...value }
      const next = { ...value }
      for (const [k, v] of Object.entries(patch)) {
        if (k in SETTINGS_DEFAULTS) next[k] = v
      }
      // 数值域收敛，避免 UI 传坏值导致弹幕层错乱
      next.danmakuOpacity = Math.min(1, Math.max(0.2, Number(next.danmakuOpacity) || SETTINGS_DEFAULTS.danmakuOpacity))
      next.danmakuSize = Math.min(28, Math.max(12, Number(next.danmakuSize) || SETTINGS_DEFAULTS.danmakuSize))
      next.danmakuSpeed = Math.min(20, Math.max(4, Number(next.danmakuSpeed) || SETTINGS_DEFAULTS.danmakuSpeed))
      next.danmaku = !!next.danmaku
      next.autoplay = !!next.autoplay
      value = next
      save()
      return { ...value }
    },
  }
}

/* ------------------------------------------------------- 平台登录 cookie --- */

/** 域名后缀 → 平台 id，用于「我登录了 B 站，那 B 站的请求带上这个 cookie」。 */
const HOST_PLATFORM = [
  ['bilibili.com', 'bilibili'],
  ['hdslb.com', 'bilibili'],
  ['bilivideo.com', 'bilibili'],
  ['douyu.com', 'douyu'],
  ['douyucdn.cn', 'douyu'],
  ['huya.com', 'huya'],
  ['douyin.com', 'douyin'],
  ['amemv.com', 'douyin'],
  ['byteimg.com', 'douyin'],
  ['zjcdn.com', 'douyin'],
]

export function platformOfHost(host) {
  const h = String(host ?? '').toLowerCase()
  for (const [suffix, platform] of HOST_PLATFORM) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return platform
  }
  return null
}

/** 只把 cookie 里的键名露出来，值一律打码。 */
function maskCookie(cookie) {
  const pairs = String(cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s.split('=')[0]}=***`)
  return pairs.join('; ')
}

function createAccounts(file) {
  let value = readJson(file, {})
  if (!value || typeof value !== 'object') value = {}
  const save = () => {
    try {
      writeJson(file, value)
    } catch {
      /* 同上 */
    }
  }
  return {
    /** 给 UI 的脱敏视图。 */
    list() {
      return Object.entries(value).map(([platform, entry]) => ({
        platform,
        saved: !!entry?.cookie,
        preview: maskCookie(entry?.cookie),
        note: String(entry?.note ?? ''),
        at: Number(entry?.at) || 0,
      }))
    },
    has: (platform) => !!value?.[platform]?.cookie,
    raw: (platform) => String(value?.[platform]?.cookie ?? ''),
    set(platform, cookie, note) {
      if (!platform) return this.list()
      const text = String(cookie ?? '').trim()
      if (!text) return this.remove(platform)
      value[platform] = { cookie: text, note: String(note ?? ''), at: Date.now() }
      save()
      return this.list()
    },
    remove(platform) {
      if (value?.[platform]) {
        delete value[platform]
        save()
      }
      return this.list()
    },
    /** http 层用：按目标域名找对应平台登录 cookie，没有就返回 ''。 */
    cookieForHost(host) {
      const platform = platformOfHost(host)
      return platform ? this.raw(platform) : ''
    },
  }
}

/**
 * @param {string} [dataDir] 默认 `~/.dsh/simple-live`
 */
export function createStores(dataDir) {
  const dir = dataDir || join(homedir(), '.dsh', 'simple-live')
  return {
    dir,
    follows: createFollows(join(dir, 'follows.json')),
    history: createHistory(join(dir, 'history.json')),
    settings: createSettings(join(dir, 'settings.json')),
    accounts: createAccounts(join(dir, 'accounts.json')),
    defaults: { ...SETTINGS_DEFAULTS },
  }
}
