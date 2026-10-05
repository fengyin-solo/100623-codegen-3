// Node 运行垫片：最小化 window/localStorage/document，供纯前端 store 在 Node 下冒烟。
// 每次进程启动清空内存存储，保证冒烟测试从迁移后的初始状态开始、结果可重复。
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).window.setTimeout = (fn: (...args: unknown[]) => void, ms: number) => setTimeout(fn, ms)
;(globalThis as any).window.clearTimeout = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
