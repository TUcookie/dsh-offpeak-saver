/**
 * dsh 浏览器运行时模块的最小类型面。
 * 这些包由 dsh web 运行时提供（构建时 external），本地不安装；
 * 类型只覆盖本插件用到的 API 形状。
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    effect(fn: () => void | (() => void), label?: string): void
    slots: import('@deepseek-ai/dsh-client-ui-slots').ClientSlots
    locale: import('@deepseek-ai/dsh-client-locale/client').ClientLocale
    get(name: string): unknown
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  export interface ClientLocale {
    register(namespace: string, dicts: Record<string, Record<string, string>>): void
    bind(namespace: string): (key: string) => string
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ComponentType } from 'react'

  export interface SlotRegistration {
    name: string
    id: string
    order?: number
    label?: () => string
    locale?: string
    inject?: () => unknown
  }

  export interface ClientSlots {
    inject(name: string, factory: () => unknown): void
    register(registration: SlotRegistration, component: ComponentType<any>): unknown
  }

  export type PropsLocale<NS extends string> = { t: (key: string) => string }
  export type InjectFace<T> = T
  export type PropsRuntime<Slot extends string> = Record<string, never>
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  // type-only：拉取 settings.section 槽声明，运行时无值
}

declare module '*.module.css' {
  const classMap: Record<string, string>
  export default classMap
}
