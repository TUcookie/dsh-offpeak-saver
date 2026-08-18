import { describe, expect, it } from 'vitest'
import {
  isOffPeak,
  isPeak,
  minutesUntilPeakStart,
  nextOffPeakStart,
  nextPeakStart,
  parsePeakHours,
  shouldStopBeforePeak,
} from '../src/time.js'

const TZ = 8
const OFFICIAL = parsePeakHours(['09:00-12:00', '14:00-18:00'])

function at(h: number, m = 0): Date {
  // 构造 UTC 时间，使北京时间等于指定时刻
  return new Date(Date.UTC(2026, 7, 18, h - TZ, m, 0))
}

describe('parsePeakHours', () => {
  it('解析官方时段', () => {
    const windows = parsePeakHours(['09:00-12:00', '14:00-18:00'])
    expect(windows).toHaveLength(2)
    expect(windows[0]?.startMin).toBe(540)
    expect(windows[0]?.endMin).toBe(720)
  })

  it('拒绝非法格式与空窗口', () => {
    expect(() => parsePeakHours(['9-12'])).toThrow()
    expect(() => parsePeakHours(['09:00-09:00'])).toThrow()
  })

  it('拒绝越界数值（P1-5：99:00 曾导致全天按空闲计费）', () => {
    expect(() => parsePeakHours(['99:00-99:01'])).toThrow()
    expect(() => parsePeakHours(['09:00-24:00'])).toThrow()
    expect(() => parsePeakHours(['09:60-10:00'])).toThrow()
  })
})

describe('isPeak / isOffPeak（官方时段）', () => {
  it('高峰边界：09:00 进入，12:00 退出', () => {
    expect(isPeak(at(8, 59), OFFICIAL, TZ)).toBe(false)
    expect(isPeak(at(9, 0), OFFICIAL, TZ)).toBe(true)
    expect(isPeak(at(11, 59), OFFICIAL, TZ)).toBe(true)
    expect(isPeak(at(12, 0), OFFICIAL, TZ)).toBe(false)
  })

  it('高峰边界：14:00 进入，18:00 退出', () => {
    expect(isPeak(at(13, 59), OFFICIAL, TZ)).toBe(false)
    expect(isPeak(at(14, 0), OFFICIAL, TZ)).toBe(true)
    expect(isPeak(at(17, 59), OFFICIAL, TZ)).toBe(true)
    expect(isPeak(at(18, 0), OFFICIAL, TZ)).toBe(false)
  })

  it('夜间为空闲时段', () => {
    expect(isOffPeak(at(23, 30), OFFICIAL, TZ)).toBe(true)
    expect(isOffPeak(at(0, 30), OFFICIAL, TZ)).toBe(true)
    expect(isOffPeak(at(12, 30), OFFICIAL, TZ)).toBe(true)
  })
})

describe('nextPeakStart / minutesUntilPeakStart', () => {
  it('空闲时段返回下一个高峰起点', () => {
    const next = nextPeakStart(at(12, 30), OFFICIAL, TZ)
    expect(next).not.toBeNull()
    expect(next?.label).toBe('今日 14:00')
    expect(next?.minutes).toBe(90)
  })

  it('深夜返回次日高峰', () => {
    const next = nextPeakStart(at(23, 0), OFFICIAL, TZ)
    expect(next?.label).toBe('明日 09:00')
    expect(next?.minutes).toBe(600)
  })

  it('高峰内返回 null / 0', () => {
    expect(nextPeakStart(at(10, 0), OFFICIAL, TZ)).toBeNull()
    expect(minutesUntilPeakStart(at(10, 0), OFFICIAL, TZ)).toBe(0)
  })
})

describe('nextOffPeakStart', () => {
  it('高峰内返回最近的高峰结束点', () => {
    const next = nextOffPeakStart(at(10, 0), OFFICIAL, TZ)
    expect(next?.label).toBe('今日 12:00')
    expect(next?.minutes).toBe(120)
  })

  it('空闲时段返回 null', () => {
    expect(nextOffPeakStart(at(20, 0), OFFICIAL, TZ)).toBeNull()
  })
})

describe('shouldStopBeforePeak', () => {
  it('高峰前 N 分钟停止派发', () => {
    expect(shouldStopBeforePeak(at(11, 51), OFFICIAL, TZ, 10)).toBe(true)
    expect(shouldStopBeforePeak(at(13, 50), OFFICIAL, TZ, 10)).toBe(true)
    expect(shouldStopBeforePeak(at(13, 49), OFFICIAL, TZ, 10)).toBe(false)
    expect(shouldStopBeforePeak(at(9, 30), OFFICIAL, TZ, 10)).toBe(true)
  })
})

describe('跨零点窗口', () => {
  const overnight = parsePeakHours(['22:00-02:00'])
  it('跨零点高峰覆盖深夜与凌晨', () => {
    expect(isPeak(at(23, 0), overnight, TZ)).toBe(true)
    expect(isPeak(at(1, 0), overnight, TZ)).toBe(true)
    expect(isPeak(at(2, 0), overnight, TZ)).toBe(false)
    expect(isPeak(at(21, 59), overnight, TZ)).toBe(false)
  })

  it('凌晨返回当晚高峰起点', () => {
    const next = nextPeakStart(at(3, 0), overnight, TZ)
    expect(next?.label).toBe('今日 22:00')
  })

  it('跨零点窗口：nextOffPeakStart 补查次日结束点（边界修复）', () => {
    const next = nextOffPeakStart(at(23, 0), overnight, TZ)
    expect(next?.label).toBe('明日 02:00')
    expect(next?.minutes).toBe(180)
  })
})
