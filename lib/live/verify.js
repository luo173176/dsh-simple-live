/**
 * 平台登录 Cookie 有效性校验。
 *
 * 目标：真正判断"登录状态是否有效"，而不是只看用户有没有填 Cookie。
 * 做法：拿用户填的 Cookie 去请求该平台的"当前用户"接口，
 *   - 明确判定成功 → { ok:true, name, avatar, uid }
 *   - 明确判定未登录/失效 → { ok:false, message }
 *   - 该平台没有稳定的匿名可调用户接口 → { ok:null, message }（如实标注，不假装有效）
 *
 * 目前能可靠自动校验：bilibili（nav）、douyin（profile/self）、huya（个人页）。
 * 其余平台保留兜底，由界面如实展示"已保存·无法自动校验"。
 *
 * @module dsh-simple-live/lib/live/verify
 */

function pick(obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

async function jsonLoose(http, url, opts) {
  const raw = await http.text(url, opts)
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

async function verifyBilibili(http, cookie) {
  const data = await jsonLoose(http, 'https://api.bilibili.com/x/web-interface/nav', {
    headers: { cookie },
    referer: 'https://www.bilibili.com/',
    timeout: 9000,
  })
  const d = data?.data ?? {}
  if (d.isLogin === true) {
    return {
      ok: true,
      name: String(d.uname ?? ''),
      avatar: String(d.face ?? '').replace(/^http:/, 'https:'),
      uid: String(d.mid ?? ''),
      message: '登录有效',
    }
  }
  return { ok: false, message: data?.message ? `Cookie 无效：${data.message}` : 'Cookie 无效或已过期' }
}

async function verifyDouyin(http, cookie) {
  const data = await jsonLoose(http, 'https://www.douyin.com/aweme/v1/web/user/profile/self/', {
    headers: { cookie, accept: 'application/json, text/plain, */*' },
    referer: 'https://www.douyin.com/',
    timeout: 9000,
  })
  const status = Number(data?.status_code)
  const user = data?.user
  if (status === 0 && user) {
    const avatar =
      pick(user, 'avatar_thumb.url_list.0') || pick(user, 'avatar_168x168.url_list.0') || ''
    return {
      ok: true,
      name: String(user.nickname ?? ''),
      avatar: String(avatar),
      uid: String(user.sec_uid ?? user.uid ?? ''),
      message: '登录有效',
    }
  }
  return { ok: false, message: data?.status_msg ? `Cookie 无效：${data.status_msg}` : 'Cookie 无效或已过期' }
}

async function verifyHuya(http, cookie) {
  const html = await http.text(`https://www.huya.com/index.php?do=profile&_=${Date.now()}`, {
    headers: { cookie, accept: 'text/html,application/xhtml+xml' },
    referer: 'https://www.huya.com/',
    timeout: 9000,
  })
  // 虎牙个人页登录后会在页面里写入用户信息 JSON 片段
  const nick =
    /"nick"\s*:\s*"([^"]+)"/.exec(html)?.[1] ||
    /"nickName"\s*:\s*"([^"]+)"/.exec(html)?.[1] ||
    ''
  if (nick) return { ok: true, name: nick, avatar: '', uid: '', message: '登录有效' }
  const isLogin = /"isLogin"\s*:\s*true/.test(html) || /"loginStatus"\s*:\s*1/.test(html)
  if (isLogin) return { ok: true, name: '已登录', avatar: '', uid: '', message: '登录有效' }
  return { ok: null, message: '已保存（虎牙页面未解析到登录信息）' }
}

/**
 * @param {ReturnType<import('./http.js').createHttp>} http
 * @param {string} platform
 * @param {string} cookie
 * @returns {Promise<{ok: boolean|null, name?: string, avatar?: string, uid?: string, message: string}>}
 */
export async function verifyAccount(http, platform, cookie) {
  const p = String(platform ?? '').toLowerCase()
  const ck = String(cookie ?? '').trim()
  if (!ck) return { ok: false, message: '未填写 Cookie' }
  try {
    if (p === 'bilibili') return await verifyBilibili(http, ck)
    if (p === 'douyin') return await verifyDouyin(http, ck)
    if (p === 'huya') return await verifyHuya(http, ck)
    return { ok: null, message: '该平台暂不支持自动校验，已保存' }
  } catch (e) {
    return { ok: null, message: `校验请求失败：${e?.message ?? e}` }
  }
}
