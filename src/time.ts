/**
 * 峰谷时间窗口判断（固定时区偏移，默认 UTC+8，无夏令时）。
 */

export interface PeakWindow {
  /** 开始分钟（0-1439） */
  startMin: number
  /** 结束分钟（0-1439）；若 <= startMin 表示跨零点窗口 */
  endMin: number
  label: string
}

const TIME_PATTERN = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/

function toMinutes(h: number, m: number): number {
  return h * 60 + m
}

export function parsePeakHours(peakHours: string[]): PeakWindow[] {
  const windows: PeakWindow[] = []
  for (const raw of peakHours) {
    const match = TIME_PATTERN.exec(raw.trim())
    if (match === null) {
      throw new Error(`offpeak-saver: 无法解析高峰时段 "${raw}"，正确格式为 "HH:MM-HH:MM"`)
    }
    const startMin = toMinutes(Number(match[1]), Number(match[2]))
    const endMin = toMinutes(Number(match[3]), Number(match[4]))
    if (startMin === endMin) {
      throw new Error(`offpeak-saver: 高峰时段 "${raw}" 起止时间相同`)
    }
    windows.push({ startMin, endMin, label: raw.trim() })
  }
  return windows
}

/** 返回当前时刻在目标时区下的“分钟数”（0-1439）。 */
export function minutesOf(date: Date, tzOffsetHours: number): number {
  const shifted = new Date(date.getTime() + tzOffsetHours * 3_600_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** 该时刻是否处于任一高峰窗口内。 */
export function isPeak(date: Date, windows: PeakWindow[], tzOffsetHours: number): boolean {
  const minutes = minutesOf(date, tzOffsetHours)
  for (const window of windows) {
    if (window.endMin <= window.startMin) {
      // 跨零点窗口
      if (minutes >= window.startMin || minutes < window.endMin) return true
    } else if (minutes >= window.startMin && minutes < window.endMin) {
      return true
    }
  }
  return false
}

export function isOffPeak(date: Date, windows: PeakWindow[], tzOffsetHours: number): boolean {
  return !isPeak(date, windows, tzOffsetHours)
}

export interface NextStart {
  /** 从 now 起多少分钟后进入目标时段 */
  minutes: number
  /** "今日/明日 HH:MM" */
  label: string
  /** 绝对时间 */
  at: Date
}

/**
 * 下一个高峰开始时间。若当前已在高峰内返回 null；
 * 若当前在空闲时段，返回最近的高峰窗口起点（可能为明天）。
 */
export function nextPeakStart(date: Date, windows: PeakWindow[], tzOffsetHours: number): NextStart | null {
  if (isPeak(date, windows, tzOffsetHours)) return null
  const minutes = minutesOf(date, tzOffsetHours)
  const nowUtcMs = date.getTime()
  const tzMs = tzOffsetHours * 3_600_000

  let best: NextStart | null = null
  for (const window of windows) {
    for (const offsetDays of [0, 1]) {
      // 目标时区当日的窗口起点对应的 UTC 毫秒
      const dayStartUtc = Math.floor((nowUtcMs + tzMs) / 86_400_000) + offsetDays
      const startUtcMs = dayStartUtc * 86_400_000 + window.startMin * 60_000 - tzMs
      const delta = startUtcMs - nowUtcMs
      if (delta <= 0) continue
      if (best === null || delta < best.minutes * 60_000) {
        const at = new Date(startUtcMs)
        const dayLabel = offsetDays === 0 ? '今日' : '明日'
        best = {
          minutes: Math.ceil(delta / 60_000),
          label: `${dayLabel} ${formatClock(window.startMin)}`,
          at,
        }
      }
    }
  }
  return best
}

/**
 * 下一个空闲时段开始时间。若当前已在空闲时段返回 null；
 * 若在高峰内，返回最近的高峰结束时间。
 */
export function nextOffPeakStart(date: Date, windows: PeakWindow[], tzOffsetHours: number): NextStart | null {
  if (isOffPeak(date, windows, tzOffsetHours)) return null
  const nowUtcMs = date.getTime()
  const tzMs = tzOffsetHours * 3_600_000
  const minutes = minutesOf(date, tzOffsetHours)

  let best: NextStart | null = null
  for (const window of windows) {
    for (const offsetDays of [0]) {
      const dayStartUtc = Math.floor((nowUtcMs + tzMs) / 86_400_000) + offsetDays
      const endUtcMs = dayStartUtc * 86_400_000 + window.endMin * 60_000 - tzMs
      const delta = endUtcMs - nowUtcMs
      if (delta <= 0) continue
      if (best === null || delta < best.minutes * 60_000) {
        best = {
          minutes: Math.ceil(delta / 60_000),
          label: `今日 ${formatClock(window.endMin)}`,
          at: new Date(endUtcMs),
        }
      }
    }
  }
  return best
}

/** 高峰开始前剩余分钟数；若当前已在高峰内返回 0。 */
export function minutesUntilPeakStart(date: Date, windows: PeakWindow[], tzOffsetHours: number): number {
  const next = nextPeakStart(date, windows, tzOffsetHours)
  return next === null ? 0 : next.minutes
}

/** 距离高峰开始是否已进入“提前停止派发”区间。 */
export function shouldStopBeforePeak(
  date: Date,
  windows: PeakWindow[],
  tzOffsetHours: number,
  stopBeforeMinutes: number,
): boolean {
  if (isPeak(date, windows, tzOffsetHours)) return true
  return minutesUntilPeakStart(date, windows, tzOffsetHours) <= stopBeforeMinutes
}

function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 目标时区下的日期字符串 YYYY-MM-DD。 */
export function dateString(date: Date, tzOffsetHours: number): string {
  const shifted = new Date(date.getTime() + tzOffsetHours * 3_600_000)
  return shifted.toISOString().slice(0, 10)
}
