import { llamar } from './ipc'

/**
 * Signing in, signing out, and the people on the till.
 *
 * All five operations are contract members and all five answer. `login` is deliberately the ONLY
 * way to change who is operating: handing the till to an employee and taking it back are both
 * this call, with the incoming person's own sign-in name and their own password. There is no
 * `switchUser` here, and there is no such operation in the contract either, because a call that
 * changed the operator without checking a password is exactly the escalation this feature must
 * not have.
 *
 * `register` is one operation with two meanings, and which one runs is decided by MAIN from the
 * session, never by a flag passed from here: with nobody signed in it creates the business and
 * its owner; with an owner signed in it adds an employee to the business that already exists.
 * The panel sends the same fields either way.
 */
export const authAPI = {
  me: () => llamar('auth', 'me'),
  login: (nombre, password) => llamar('auth', 'login', { nombre, password }),
  register: (datos) => llamar('auth', 'register', datos),
  changePassword: (actualPassword, password) =>
    llamar('auth', 'changePassword', { actualPassword, password }),
  logout: () => llamar('auth', 'logout')
}
