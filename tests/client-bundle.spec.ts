import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRequire = createRequire(import.meta.url)

describe('打包后的 client bundle（DSH ModuleLoader 协议）', () => {
  it('可被 window.__ModuleLoader__ 加载，apply 注册 settings.section 槽', () => {
    const code = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

    let capturedFactory: ((require: (spec: string) => unknown) => unknown) | null = null
    const styleTag = { dataset: {}, textContent: '' }
    globalThis.window = {
      __ModuleLoader__: {
        load: (entry: { id: string; factory: (require: (spec: string) => unknown) => unknown }) => {
          expect(entry.id).toBe('dsh-offpeak-saver')
          capturedFactory = entry.factory
        },
      },
    }
    globalThis.document = {
      querySelector: () => null,
      createElement: () => styleTag,
      head: { appendChild: () => undefined },
    }

    const module = { exports: {} as Record<string, unknown> }
    const browserRequire = (spec: string): unknown => {
      if (spec === 'react' || spec === 'react/jsx-runtime') {
        return localRequire(spec)
      }
      if (spec.startsWith('@deepseek-ai/')) return {}
      throw new Error(`unexpected browser require: ${spec}`)
    }

    const fn = new Function('module', 'exports', 'require', code) as (
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>,
      require: (spec: string) => unknown,
    ) => void
    fn(module, module.exports, browserRequire)

    expect(capturedFactory).not.toBeNull()
    const bundle = capturedFactory!(browserRequire) as {
      inject: string[]
      apply: (ctx: unknown) => void
    }
    expect(bundle.inject).toEqual(['slots', 'locale'])

    const registrations: Array<{ id: string; name: string; order?: number }> = []
    const locales: Array<Record<string, Record<string, string>>> = []
    bundle.apply({
      effect: (fn: () => void) => fn(),
      slots: {
        register: (registration: { id: string; name: string; order?: number }) => {
          registrations.push(registration)
          return () => {}
        },
        inject: (name: string, factory: () => unknown) => {
          factory()
        },
      },
      locale: {
        register: (ns: string, dicts: Record<string, Record<string, string>>) => {
          expect(ns).toBe('offpeak.panel')
          locales.push(dicts)
        },
        bind: () => () => '错峰省钱',
      },
    })

    const byId = new Map(registrations.map((registration) => [registration.id, registration]))
    expect(byId.get('offpeak-saver-panel')?.name).toBe('settings.section')
    expect(byId.get('offpeak-saver-entry')?.name).toBe('sidebar.footer.action')
    expect(byId.get('offpeak-saver-overlay')?.name).toBe('shell.overlay')
    expect(locales[0]?.zh.nav).toBe('错峰省钱')
    expect(locales[0]?.en.nav).toBe('Off-Peak Saver')
  })
})
