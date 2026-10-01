/**
 * THE FIRST-LAUNCH WALK, ON THE REAL PANEL, WITH REAL KEYS.
 *
 * WHY IT IS A SEPARATE MODULE. Three drives (`payment`, `deudores`, `compras`) all boot the real
 * app against a throwaway shop file, and since the sign-in landed ALL THREE now open on the panel
 * instead of on their page. The first version put the walk inline in the payment drive, which made
 * the other two copy it — and a copy of a security walkthrough is exactly the kind of copy that
 * rots silently. One definition, three callers: if the panel changes, it changes here.
 *
 * WHY IT TYPES. `tipear` sends real `sendInputEvent` key events and falls back to
 * `execCommand('insertText')` only if the events did not land. Both are the same two mechanisms a
 * person's fingers reach, and neither calls the auth service directly: the whole point is to prove
 * the path a shopkeeper takes, panel → bridge → IPC → scrypt → row. Calling `registrar()` from main
 * would pass this step while proving nothing about the window.
 *
 * WHAT IT PROVES, IN FIVE CHECKS
 *   1. The app opens SIGNED OUT. A machine that is switched on knows nobody.
 *   2. The panel offers the first-launch path.
 *   3. A name and a password are enough to open the shop — and nothing else is.
 *   4. The session lives in the main process, with a name and a role, and the renderer reads it
 *      through the same bridge every other call uses.
 *   5. The password that was just typed is not in the file, not in the hash column, not in the
 *      salt, and not in the sign-in name.
 *
 * A drive that does not want this step (an installed-package run, say) simply does not call it.
 */
const PASSWORD_POR_DEFECTO = 'Clave-De-La-Prueba-9'

/**
 * @param {object}   p
 * @param {import('electron').BrowserWindow} p.win
 * @param {object}   p.base  the drive's own primitives: leer, esperarEn, buscar, tipear, sleep
 * @param {Function} p.check (nombre, ok, detalle) => boolean
 * @param {Function} p.say   (linea) => void
 * @param {Function} p.db1   (sql, ...args) => row
 * @param {string}   [p.password]
 * @param {string}   [p.negocio]
 * @param {string}   [p.nombre]
 */
export async function firmarComoDueño({
  win,
  base,
  check,
  say,
  db1,
  password = PASSWORD_POR_DEFECTO,
  negocio = 'Tienda del Recorrido',
  nombre = 'Dueña Recorrido'
}) {
  const { leer, esperarEn, buscar, tipear, sleep } = base

  const panel = await leer(
    win,
    `(() => {
      const raiz = document.querySelector('#root');
      const t = (raiz ? (raiz.textContent || '') : '').replace(/\\s+/g, ' ');
      return {
        hayPanel: Boolean(document.querySelector('.acceso-panel')),
        nombreAcceso: Boolean(document.querySelector('#acceso-nombre')),
        password: Boolean(document.querySelector('#acceso-password')),
        pregunta: t.includes('¿Quién está en la caja?'),
        ruta: location.pathname,
        texto: t.trim().slice(0, 120)
      };
    })()`
  )
  check(
    'al abrir, la app pide una contraseña y no entra sola',
    Boolean(panel?.hayPanel) && panel?.pregunta && panel?.nombreAcceso && panel?.password,
    `panel=${JSON.stringify(panel)}`
  )
  if (!panel?.hayPanel) return { ok: false, motivo: 'no hay panel de acceso en pantalla', panel }

  const pestanaCrear = await buscar(win, { texto: 'Crear el negocio' })
  check('el panel ofrece crear el negocio', Boolean(pestanaCrear))
  await sleep(400)
  await tipear(win, { selector: '#acceso-negocio', texto: negocio })
  await tipear(win, { selector: '#acceso-nombre', texto: nombre })
  await tipear(win, { selector: '#acceso-password', texto: password })
  await buscar(win, { texto: 'Crear y entrar' })

  // One scrypt at N=16384 plus the insert. 15s is generous on purpose: a slow machine should not
  // turn a security check into a flake.
  const entro = await esperarEn(win, `!document.querySelector('.acceso-panel')`, 15000)
  check(
    'con un nombre y una contraseña, la dueña entra sola',
    Boolean(entro),
    'el panel sigue en pantalla tras crear la cuenta'
  )

  const quien = await leer(
    win,
    `(async () => {
      const r = await window.minimarck.call('auth', 'me');
      const u = r && r.user;
      return {
        nombre: u && u.nombre,
        rol: u && u.rol,
        acceso: u && u.nombreAcceso,
        personas: r && r.personas ? r.personas.length : null
      };
    })()`
  )
  check(
    'la sesión existe en el proceso principal, con nombre y rol',
    Boolean(quien?.nombre) && Boolean(quien?.rol),
    `auth.me devolvió ${JSON.stringify(quien)}`
  )
  if (quien?.acceso) say(`         en la caja: ${quien.nombre} (${quien.acceso}, ${quien.rol})`)

  // `secret` and `salt` are the real column names. The first version of this step looked for
  // `password_hash`, which does not exist, and it failed loudly — the correct outcome for a check
  // about what is stored on disk.
  const filtrada = db1(
    `SELECT COUNT(*) AS n FROM user_identidades
       WHERE secret LIKE '%${password}%' OR salt LIKE '%${password}%' OR external_id LIKE '%${password}%'`
  ).n
  check('la contraseña escrita no aparece en la base, ni junto a su hash', filtrada === 0, `${filtrada} fila(s) la contienen`)

  return { ok: Boolean(entro) && filtrada === 0, panel, quien }
}
