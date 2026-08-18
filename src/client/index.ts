/**
 * 浏览器半：注册“错峰省钱”设置页（settings.section 槽）。
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { OffpeakPanel } from './OffpeakPanel.tsx'
import { en, NS, zh } from './locales.ts'

export { OffpeakPanel }
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
}
