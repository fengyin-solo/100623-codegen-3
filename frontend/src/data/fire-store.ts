import { buildSeedState } from './fire-seed'
import type { FireState } from './fire-types'

// 消防与应急模块独立存储键，与既有业务模块互不影响。
const STORAGE_KEY = 'hydropower-plant-om:fire-safety'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: FireState | null = null

function readState(): FireState {
  const fallback = buildSeedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    // 以种子为底合并，后续新增字段旧缓存里没有时不会缺。
    return { ...fallback, ...(JSON.parse(raw) as FireState) }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function getState(): FireState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

/**
 * 唯一写入口：整个消防域在一次 commit 里落库。
 * 台账、充装单、隐患结论必须同生共改（事务），不允许写一半。
 */
export function commit(updater: (draft: FireState) => void): FireState {
  const next = clone(getState())
  updater(next)
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    // 单次写入：要么整套生效，要么根本没写。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

/** 供测试注入内存态，不碰 localStorage。 */
export function setStateForTest(state: FireState): void {
  cache = clone(state)
}

export function resetFireState(): FireState {
  cache = buildSeedState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
  return cache
}
