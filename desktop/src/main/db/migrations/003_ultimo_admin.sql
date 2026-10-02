-- 003 — THE SHOP IS NEVER LEFT WITHOUT AN ACTIVE OWNER.
--
-- THE INVARIANT. While any active `admin` exists for a business, that business cannot be taken to
-- zero: not by a hard `DELETE`, not by `activo = 0`, not by a soft `deleted_at`, and not by
-- demoting the last owner to `supervisor` or `vendedor`.
--
-- WHY THIS IS A TRIGGER AND NOT A FUNCTION SOME CALLER REMEMBERS. The three actions that could
-- break it do not exist in this build: §L is frozen at 89 operations and none of them is
-- `usuarios.update` or `usuarios.remove`, so there is no repository method, no IPC handler and no
-- screen that performs any of the three. A guard function with no caller is a guard that will not
-- be there when the first `usuarios` group is added — and the day somebody adds it, the code that
-- breaks the rule and the code that is supposed to stop it are written at the same time, by the
-- same person, on a bad afternoon. The engine refuses instead. `sqlite3` on the shop's own machine,
-- a maintenance script, a future migration, a half-finished feature branch: every one of them hits
-- the same two triggers, and the one thing none of them can do is talk the engine out of it.
--
-- WHY THIS IS SAFE TO ADD TO AN EXISTING SHOP FILE. The triggers are pure DDL: they create no
-- table, rewrite no row and read no existing data at migration time. A file whose owner was
-- deleted by hand years ago has zero admins, and these triggers do nothing about that — they
-- refuse to MAKE IT WORSE, which is the only claim made here. Repairing a file that is already
-- missing an owner is `auth.register`'s job on first launch, and it is not this file's business.
--
-- ── THE COUNT IS PER BUSINESS, NOT PER FILE ───────────────────────────────────────────────────
--
-- `OLD.negocio_id` scopes the subquery on purpose. A shop file that has adopted a second business
-- (`negocioUnico` refuses to guess between them) must be able to keep one owner in each, and a
-- file-wide count would let the first business's last owner be removed on the grounds that the
-- second business still had one. The rule being protected is "THIS shop always has somebody who
-- can sign in as its owner", not "this file contains a row with rol = 'admin' somewhere".
--
-- ── WHY `ABORT` AND NOT `ROLLBACK` ─────────────────────────────────────────────────────────────
--
-- `RAISE(ABORT, …)` undoes the STATEMENT and leaves the transaction open, so a caller that meant
-- to touch several rows and failed on this one sees one refusal and keeps whatever it legitimately
-- changed. `RAISE(ROLLBACK, …)` would discard the whole transaction, including work that had
-- nothing to do with the person being demoted. And `RAISE(FAIL, …)` would not undo the statement at
-- all, which is the opposite of a refusal.
--
-- ── WHY THE MESSAGE CARRIES A PREFIX ──────────────────────────────────────────────────────────
--
-- The text is what SQLite reports, and it is what `errores-sqlite.js` matches. The prefix
-- `ULTIMO_ADMIN:` is the stable part; the sentence after it is for whoever reads the log. Matching
-- the PREFIX rather than the sentence means re-wording this message for a shopkeeper cannot
-- silently turn the refusal into an unrecognised SQLite error, which is the same mistake
-- `errores-sqlite.js` exists to document about matching an index name SQLite never emits.

-- DELETE — the physical removal. `001_init.sql` soft-deletes through `deleted_at`, so this is the
-- path a hand-written `DELETE FROM users` or a future hard-delete migration would take, and it is
-- the one path no application code currently takes.
CREATE TRIGGER trg_users_no_dejar_sin_dueno_borrar
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.rol = 'admin'
     AND OLD.activo = 1
     AND OLD.deleted_at IS NULL
     AND (
       SELECT COUNT(*) FROM users
        WHERE negocio_id = OLD.negocio_id
          AND rol = 'admin' AND activo = 1 AND deleted_at IS NULL
     ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'ULTIMO_ADMIN: no se puede borrar el único dueño activo del negocio');
END;

-- UPDATE — the three ways a person stops being an owner without the row going away: deactivating
-- them, retiring them the way this schema retires everything, or taking their role away.
--
-- `UPDATE OF rol, activo, deleted_at` IS NOT AN OPTIMISATION ONLY. A trigger with `OF` fires when
-- the statement's SET list mentions one of those columns, so the two UPDATEs this codebase really
-- does write — `marcarAcceso` stamping `ultimo_acceso` on every sign-in, and `registrar` renaming
-- the owner on first launch — never reach this trigger at all. The check runs only on the writes
-- that can actually change the answer, which is also the writes worth paying a COUNT for.
CREATE TRIGGER trg_users_no_dejar_sin_dueno_actualizar
BEFORE UPDATE OF rol, activo, deleted_at ON users
FOR EACH ROW
WHEN OLD.rol = 'admin'
     AND OLD.activo = 1
     AND OLD.deleted_at IS NULL
     AND (
       NEW.rol <> 'admin' OR NEW.activo <> 1 OR NEW.deleted_at IS NOT NULL
     )
     AND (
       SELECT COUNT(*) FROM users
        WHERE negocio_id = OLD.negocio_id
          AND rol = 'admin' AND activo = 1 AND deleted_at IS NULL
     ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'ULTIMO_ADMIN: no se puede dejar el negocio sin dueño activo');
END;