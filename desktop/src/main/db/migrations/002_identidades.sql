-- 002 — LOCAL CREDENTIALS (auth local, sin servidor).
--
-- WHY A SEPARATE TABLE AND NOT COLUMNS ON `users`. The identity is shaped as
-- `provider` + external id so a Google sign-in can later be LINKED to a local user
-- instead of forcing a rewrite of the whole auth model. A provider that owns the login
-- (local password, Google account) is a different concern from the person (name, role,
-- business, active flag), and `users` is a census-verified 20-table schema ported from the
-- web's Sequelize models. Credentials live beside it, not inside it.
--
-- `provider` is `'local'` today and the code refuses any other value: the seam EXISTS, the
-- second provider does not. Building it now costs one column; retrofitting it later means
-- moving every credential and rewriting every lookup.
--
-- WHY THE PASSWORD IS NOT HERE AS PLAINTEXT AND NOT ON `users` AT ALL. `secret` is a
-- scrypt-derived key, hex encoded. `salt` is per-identity random bytes, hex encoded. The
-- plaintext exists only in the `password` argument of `scryptSync` for the microseconds the
-- call takes, and never leaves the main process.
--
-- WHY `parametros` IS A COLUMN. scrypt is a moving target: the cost parameters in a hash
-- recorded in 2026 are deliberately weaker than the ones a future release would choose. Storing
-- the exact (N, r, p, keylen) alongside the key is what makes "re-derive on next successful
-- sign-in and upgrade" implementable instead of theoretical. A hash with no recorded parameters
-- is a hash you can only ever verify, never rehash.
--
-- ALL NUMERIC COLUMNS ARE INTEGER, and the table is `paranoid` (deleted_at), because
-- `tests/db/schema.spec.js` asserts both properties over EVERY table in the file.
--
-- ADDITIVE ONLY. No ALTER of an existing table, no DROP, no data rewrite: an existing shop
-- file that already has sales, purchases and debts keeps every row it has, and the migration
-- cannot fail on data it did not create. That matters more than tidiness — a migration that can
-- fail on a customer's database is how a shop gets locked out of its own till.
CREATE TABLE user_identidades (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  provider       TEXT    NOT NULL,
  external_id    TEXT    NOT NULL,
  secret         TEXT,
  salt           TEXT,
  algoritmo      TEXT,
  parametros     TEXT,
  activo         INTEGER NOT NULL DEFAULT 1,
  ultimo_acceso  TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  deleted_at     TEXT
);

-- One LIVE account per provider handle. This is the index that makes a duplicate sign-in name
-- impossible at the storage layer, and it is the reason `auth.login` can look a user up by a
-- single key instead of a LIKE and a guess.
--
-- WHY IT IS PARTIAL (`activo = 1 AND deleted_at IS NULL`) AND NOT A PLAIN UNIQUE. Writing a
-- credential RETIRES the previous row instead of deleting it — a credential that once opened the
-- shop is a fact about its history — and then inserts the new one under the same handle. Against
-- a plain UNIQUE that is a guaranteed collision: the row being retired is still in the table, so
-- every `auth.changePassword` and every policy upgrade would have failed with a constraint error
-- on the one operation that has to work. The same partial shape 001 already uses for
-- `ux_users_email` and `ux_cajas_abierta`, for exactly this reason.
CREATE UNIQUE INDEX ux_user_identidades_handle
  ON user_identidades (provider, external_id)
  WHERE activo = 1 AND deleted_at IS NULL;

-- Listing a business's employees is a read of every identity belonging to it, which is this
-- index, and it is the only query shape the users module produces.
CREATE INDEX ix_user_identidades_user ON user_identidades (user_id);

-- A sign-in name is case-insensitive, so the lookup stores and compares it folded. Enforced in
-- application code rather than by a UNIQUE index on `users.email` on purpose: an index would be
-- cheaper, but a shop file that somehow holds two rows differing only in email case would make
-- THIS migration fail, and a migration that can fail on pre-existing data is the one failure
-- mode this file is written to be immune to.
