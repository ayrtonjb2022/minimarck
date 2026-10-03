import { llamar } from './ipc'

/**
 * The business, over IPC. `obtener` is all a shell needs — the shop's name in the header.
 * `actualizar` is a settings screen, which is not mounted in this build.
 */
export const negocioAPI = {
  obtener: () => llamar('negocio', 'obtener')
}
