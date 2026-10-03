import { contextBridge, ipcRenderer } from 'electron'
import { TOPICS, CHANNEL, ENVELOPE_VERSION } from '../shared/ipc-contract.js'

/**
 * The COMPLETE renderer surface — exactly FOUR members (SEC-1).
 *
 * `Object.keys(window.minimarck)` MUST be exactly ['call','on','platform','env'].
 *
 * The raw `ipcRenderer` handle is NEVER exposed, and there is no `invoke`/`send` escape,
 * no `require`/`process`/`fs`, and no channel that names a table or accepts SQL (SEC-2).
 * The renderer can only ask for a *contract operation* (group, op, payload) over one
 * versioned channel. The `TOPICS` guard makes an unknown subscription throw instead of
 * silently registering a listener.
 */
const call = (group, op, payload) =>
  ipcRenderer.invoke(CHANNEL, { v: ENVELOPE_VERSION, group, op, payload })

const on = (topic, cb) => {
  if (!TOPICS.includes(topic)) throw new Error('unknown topic')
  const channel = `minimarck:evt:${topic}`
  const listener = (_event, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  // Return an unsubscribe function so React effects can clean up.
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge = {
  call,
  on,
  platform: {
    saveBytes: (name, bytes) => call('platform', 'export.xlsx', { name, bytes }),
    print: (html) => call('platform', 'print', { html }),
    showItemInFolder: (target) => call('platform', 'shell.showItemInFolder', { target })
  },
  env: {
    platform: process.platform,
    version: process.env.MINIMARCK_VERSION || null
  }
}

// Freeze so a renderer bug cannot add a fifth member or mutate the surface.
contextBridge.exposeInMainWorld('minimarck', Object.freeze(bridge))
