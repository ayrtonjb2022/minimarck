import { llamar } from './ipc'

/** Categories, over IPC. `list` answers a flat array — the POS filter row, not a table. */
export const categoriasAPI = {
  listar: () => llamar('categorias', 'list'),
  crear: (data) => llamar('categorias', 'create', data)
}
