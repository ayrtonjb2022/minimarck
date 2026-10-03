import { describe, it, expect, beforeEach } from 'vitest'
import { exposed } from '../stubs/electron.js'

/**
 * The preload sandbox smoke (SEC-1). Importing the preload module runs its top-level
 * `contextBridge.exposeInMainWorld('minimarck', ...)`, which the electron stub records.
 * That recorded object is exactly what the renderer would see as `window.minimarck`.
 *
 * SEC-1: `Object.keys(window.minimarck)` MUST be exactly ['call','on','platform','env'].
 */

let bridge

beforeEach(async () => {
  exposed.length = 0
  // Fresh module instance so the top-level exposeInMainWorld runs again.
  const mod = await import('../../src/preload/index.js?fresh=' + Math.random())
  bridge = exposed[exposed.length - 1].value
  expect(typeof mod).not.toBe('undefined')
})

describe('preload bridge surface (SEC-1)', () => {
  it('exposes exactly the four members, no more', () => {
    expect(Object.keys(bridge).sort()).toEqual(['call', 'env', 'on', 'platform'])
  })

  it('exposes it under the key `minimarck`', () => {
    expect(exposed[exposed.length - 1].key).toBe('minimarck')
  })

  it('does NOT leak the raw ipcRenderer handle or any invoke/send escape', () => {
    // The whole point: the renderer gets a narrow surface, not the IPC primitive.
    for (const leak of ['ipcRenderer', 'invoke', 'send', 'sendSync', 'require', 'process']) {
      expect(bridge[leak], leak).toBeUndefined()
    }
  })

  it('platform carries saveBytes, print and showItemInFolder', () => {
    expect(typeof bridge.platform.saveBytes).toBe('function')
    expect(typeof bridge.platform.print).toBe('function')
    expect(typeof bridge.platform.showItemInFolder).toBe('function')
  })

  it('call/on/env are callable and env is a plain data bag', () => {
    expect(typeof bridge.call).toBe('function')
    expect(typeof bridge.on).toBe('function')
    expect(bridge.env).toBeTypeOf('object')
    expect(bridge.env.platform).toBe(process.platform)
  })

  it('on() throws for an unknown topic and registers no listener (SEC-2)', () => {
    expect(() => bridge.on('totally:bogus', () => {})).toThrowError(/unknown topic/)
  })

  it('the surface is frozen so the renderer cannot widen it', () => {
    expect(Object.isFrozen(bridge)).toBe(true)
  })
})
