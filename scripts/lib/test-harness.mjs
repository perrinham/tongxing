/**
 * 统一测试 harness：四段冒烟（server / client / city / amap）共用的「断言 + 报告」。
 *
 * 此前四个文件各自实现了一份 `pass/fail + ok() + section()`，断言宏四处各写各的，
 * 是「审计脚本各漂各的」问题的来源之一。这里收成一份；新断言照本文件抄。
 *
 * 约定：
 *   · `ok(cond, label, extra?)` —— cond 真为通过；输出格式 `  ✓/✗ label [extra]`
 *   · `section(title)` —— 分段标题（\n 前缀，保持与历史输出逐字节一致）
 *   · `H.pass` / `H.fail` —— 结束时拿去组装汇总行（保持各文件自己的汇总模板）
 *
 * Node 版的未捕获异常/未处理 Promise 拒绝默认就会让进程非零退出，
 * 不需要在这里重造（UI 侧的运行时错误见 src/App.vue 的 [app-err:…] 记录）。
 */
export function createHarness() {
  let _pass = 0
  let _fail = 0
  return {
    get pass() {
      return _pass
    },
    get fail() {
      return _fail
    },
    ok(cond, label, extra) {
      if (cond) {
        _pass += 1
        console.log('  ✓', label)
      } else {
        _fail += 1
        console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra))
      }
    },
    section(title) {
      console.log('\n' + title)
    }
  }
}