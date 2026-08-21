/**
 * 浏览器半：注册“错峰省钱”侧边栏入口与浮层。
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OffpeakPanel } from './OffpeakPanel.tsx'
import { en, NS, zh } from './locales.ts'
import { OffpeakOverlay, SidebarEntry } from './sidebar-entry.tsx'

export { OffpeakPanel, OffpeakOverlay, SidebarEntry }
export { NS, en, zh } from './locales.ts'

/** Required browser services. */
export const inject = ['slots', 'locale']

/** Mount the off-peak saver sidebar entry and overlay. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'offpeak-saver: dictionaries')

  // 侧边栏常驻入口：底部按钮
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'offpeak-saver-entry',
    order: 20,
    locale: NS,
  }, SidebarEntry))

  // 浮层宿主：按钮打开的面板
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'offpeak-saver-overlay',
    locale: NS,
  }, OffpeakOverlay))
}
