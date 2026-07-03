export const ROLES = {
  ADMIN: "admin",
  SUPERVISOR: "supervisor",
  VENDEDOR: "vendedor",
};

export const METODOS_PAGO = {
  EFECTIVO: "efectivo",
  TARJETA: "tarjeta",
  TRANSFERENCIA: "transferencia",
  CREDITO: "credito",
  MIXTO: "mixto",
};

export const ESTADOS_VENTA = {
  COMPLETADA: "completada",
  ANULADA: "anulada",
};

export const ESTADOS_CAJA = {
  ABIERTA: "abierta",
  CERRADA: "cerrada",
};

export const ESTADOS_DEUDOR = {
  PENDIENTE: "pendiente",
  PARCIAL: "parcial",
  PAGADO: "pagado",
};

export const ESTADOS_COMPRA = {
  PENDIENTE: "pendiente",
  COMPLETADA: "completada",
  CANCELADA: "cancelada",
};

export const ESTADO_COMPRA_LABELS = {
  [ESTADOS_COMPRA.PENDIENTE]: "Pendiente",
  [ESTADOS_COMPRA.COMPLETADA]: "Completada",
  [ESTADOS_COMPRA.CANCELADA]: "Cancelada",
};

export const TIPOS_MOVIMIENTO = {
  INGRESO: "ingreso",
  EGRESO: "egreso",
};

export const ROL_LABELS = {
  [ROLES.ADMIN]: "Administrador",
  [ROLES.SUPERVISOR]: "Supervisor",
  [ROLES.VENDEDOR]: "Vendedor",
};

export const METODO_PAGO_LABELS = {
  [METODOS_PAGO.EFECTIVO]: "Efectivo",
  [METODOS_PAGO.TARJETA]: "Tarjeta",
  [METODOS_PAGO.TRANSFERENCIA]: "Transferencia",
  [METODOS_PAGO.CREDITO]: "Crédito",
  [METODOS_PAGO.MIXTO]: "Mixto",
};

export const ESTADO_DEUDOR_LABELS = {
  [ESTADOS_DEUDOR.PENDIENTE]: "Pendiente",
  [ESTADOS_DEUDOR.PARCIAL]: "Parcial",
  [ESTADOS_DEUDOR.PAGADO]: "Pagado",
};
