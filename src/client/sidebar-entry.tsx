/**
 * 侧边栏常驻入口：底部“错峰省钱”按钮 + shell.overlay 面板宿主。
 * 设置页入口保留作为兜底，两边共享同一面板组件。
 */

import { useEffect, useState } from 'react'
import { loadOverview, type PanelOverview } from './api.ts'
import { OffpeakPanel } from './OffpeakPanel.tsx'
import css from './sidebar-entry.module.css'
import type { zh } from './locales.ts'
import iconWhiteRaw from './assets/icon_white.svg?raw'
import iconBlackRaw from './assets/icon_black.svg?raw'
import valleyRaw from './assets/谷.svg?raw'
import peakRaw from './assets/峰.svg?raw'

const iconWhite = `data:image/svg+xml;base64,${btoa(iconWhiteRaw)}`
const iconBlack = `data:image/svg+xml;base64,${btoa(iconBlackRaw)}`
const valleyIcon = `data:image/svg+xml;base64,${btoa(valleyRaw)}`
const peakIcon = `data:image/svg+xml;base64,${btoa(peakRaw)}`

/** 模块级共享开关状态：按钮与浮层分处不同槽，需要同步。 */
let openState = false
const listeners = new Set<(open: boolean) => void>()

function setOpen(next: boolean): void {
  openState = next
  for (const listener of listeners) listener(next)
}

function useOpenState(): [boolean, (next: boolean) => void] {
  const [open, setOpenLocal] = useState(openState)
  useEffect(() => {
    listeners.add(setOpenLocal)
    return () => {
      listeners.delete(setOpenLocal)
    }
  }, [])
  return [open, setOpen]
}

/** 侧边栏入口也同步服务端时段，每 30 秒更新一次图标。 */
function useCurrentPhase(): PanelOverview['phase'] | null {
  const [phase, setPhase] = useState<PanelOverview['phase'] | null>(null)

  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const overview = await loadOverview()
        if (active) setPhase(overview.phase)
      } catch {
        // 入口仍可正常打开面板；下一轮轮询会重试。
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 30_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  return phase
}

/** 侧边栏底部入口按钮（wide=false 时为折叠栏图标）。 */
export function SidebarEntry({ t, wide }: {
  t: (key: keyof typeof zh) => string
  wide?: boolean
}): React.ReactNode {
  const [open, toggle] = useOpenState()
  const phase = useCurrentPhase()
  const isPeak = phase === 'peak'
  return (
    <button
      className={`${css.entry} ${wide ? '' : css.entryCollapsed}`}
      title={t('nav')}
      onClick={() => { toggle(!open) }}
    >
      <span className={css.iconWrap}>
        <img className={css.iconImg} src={iconBlack} alt="" draggable={false} />
        <img className={`${css.iconImg} ${css.iconDark}`} src={iconWhite} alt="" draggable={false} />
      </span>
      {wide ? <span>{t('nav')}</span> : null}
      {wide && phase !== null && (
        <img
          className={css.phaseIcon}
          src={isPeak ? peakIcon : valleyIcon}
          alt={isPeak ? t('phasePeak') : t('phaseOffpeak')}
          draggable={false}
        />
      )}
    </button>
  )
}

/** shell.overlay 宿主：侧边栏按钮打开的面板浮层。 */
export function OffpeakOverlay({ t }: {
  t: (key: keyof typeof zh) => string
}): React.ReactNode {
  const [open, close] = useOpenState()
  if (!open) return null
  return (
    <div
      className={css.overlayBackdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) close(false)
      }}
    >
      <div className={css.overlayPanel} role="dialog" aria-label={t('title')}>
        <div className={css.overlayHead}>
          <h2 className={css.overlayTitle}>{t('title')}</h2>
          <button className={css.close} onClick={() => { close(false) }} aria-label="close">✕</button>
        </div>
        <div className={css.overlayBody}>
          <OffpeakPanel t={t} />
        </div>
      </div>
    </div>
  )
}
