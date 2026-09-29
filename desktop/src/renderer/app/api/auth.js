import { llamar } from './ipc'

/**
 * The shop, over IPC.
 *
 * The desktop has no sign-in (decision #275): no password, no session, no token. `login`,
 * `register`, `changePassword` and `logout` are contract members with no handler in this build
 * and would answer 501, so they are not exposed here at all — a method that always fails is
 * worse than a method that does not exist. `me` is the one that answers, and it is how the shell
 * learns the operator's name for the avatar.
 */
export const authAPI = {
  me: () => llamar('auth', 'me')
}
