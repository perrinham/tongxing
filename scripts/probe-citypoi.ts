import { mock } from './uni-mock'
import { searchPoiWithTypes } from '../src/services/amap'
mock.useDevice('A')
// 分页拉满，看能不能拿到橘子洲/岳麓山/天心阁/太平街这些头部地标
const all: Array<{ name: string; rating?: number }> = []
for (let page = 1; page <= 3; page++) {
  const r = await searchPoiWithTypes('', '长沙', '110200')
  void page
  all.push(...r.map(p => ({ name: p.name, rating: p.rating })))
  break // searchPoiWithTypes 没暴露 page，先看一页 25 条的覆盖
}
console.log('一页 25 条里的知名地标:')
const famous = ['橘子洲', '岳麓山', '天心阁', '马王堆', '太平', '坡子街', '五一广场', '爱晚亭', '花明楼', '靖港']
for (const f of famous) {
  const hit = all.find(p => p.name.includes(f))
  console.log(' ', f, hit ? '✓ ' + hit.name : '✗ 不在第一页')
}
console.log('\n第一页全列表（按评分排）:')
all.sort((a,b)=>(b.rating||0)-(a.rating||0)).forEach(p=>console.log(' ', (p.rating||0).toFixed(1), p.name))
