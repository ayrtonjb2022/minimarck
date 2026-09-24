-- Folio UUID: V-<uuid> tiene 38 caracteres. VARCHAR(20) desborda en modo
-- estricto (error 1406) en cada Venta.create.
ALTER TABLE ventas MODIFY folio VARCHAR(40) NOT NULL;