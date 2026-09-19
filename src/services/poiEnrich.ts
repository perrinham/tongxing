import { searchPoi, type AmapPoi } from './amap'
import type { PoiSeed } from '@/data/poi'

/**
 * 用高德把本地写死的 POI 名解析成真实坐标/地址。
 * 命中高德则覆盖本地坐标；失败/未配 key 则回退本地库，保证离线可用。
 */
const cache = new Map<string, AmapPoi>()

export async function enrichPoi(seed: PoiSeed, city?: string): Promise<PoiSeed> {
  const hit = cache.get(seed.name)
  if (hit) {
    return { ...seed, lng: hit.lng, lat: hit.lat, address: hit.address || seed.address }
  }
  try {
    const list = await searchPoi(seed.name, city)
    const best = list[0]
    if (best && best.lng && best.lat) {
      cache.set(seed.name, best)
      return { ...seed, lng: best.lng, lat: best.lat, address: best.address || seed.address }
    }
  } catch {
    /* 忽略，回退本地坐标 */
  }
  return seed
}

/** 批量补全（并发限制，避免一次打太多请求） */
export async function enrichPois(seeds: PoiSeed[], city?: string): Promise<PoiSeed[]> {
  const out: PoiSeed[] = []
  for (const s of seeds) {
    out.push(await enrichPoi(s, city))
  }
  return out
}
