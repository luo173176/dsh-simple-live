/**
 * Adapter registry. Every file here is self-contained: it exports `id`,
 * `name`, `accent`, `playHeaders` and the four async operations the panel calls.
 *
 * @module dsh-simple-live/lib/live/sites
 */

import * as bilibili from './bilibili.js'
import * as douyu from './douyu.js'
import * as huya from './huya.js'
import * as douyin from './douyin.js'
import * as kuaishou from './kuaishou.js'

/** Display order in the panel rail. */
export const SITES = [bilibili, douyu, huya, douyin, kuaishou]

const byId = new Map(SITES.map((site) => [site.id, site]))

export function site(id) {
  return byId.get(String(id ?? '').toLowerCase())
}

export function list() {
  return SITES.map(({ id, name, accent }) => ({ id, name, accent }))
}
