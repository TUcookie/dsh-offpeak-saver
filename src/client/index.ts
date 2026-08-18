/**
 * 浏览器半：注册“错峰省钱”设置页（settings.section 槽）。
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { OffpeakPanel } from './OffpeakPanel.tsx'
import { en, NS, zh } from './locales.ts'
import { OffpeakOverlay, SidebarEntry } from './sidebar-entry.tsx'

export { OffpeakPanel, OffpeakOverlay, SidebarEntry }
export { NS, en, zh } from './locales.ts'

/** Required browser services. */
export const inject = ['slots', 'locale']

/** Mount the off-peak saver settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'offpeak-saver: dictionaries')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'offpeak-saver-panel',
    order: 40,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => ({}),
  }, OffpeakPanel))

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
