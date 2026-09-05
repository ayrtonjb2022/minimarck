const QUEUE_KEY = "minimarck_offline_sales";

/**
 * Obtener ventas encoladas pendientes de sincronización.
 * @returns {Array<{id: string, data: object, queuedAt: number}>}
 */
export const getQueuedSales = () => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
};

/**
 * Encolar una venta para sincronización posterior.
 * @param {object} saleData - Payload de la venta (body del POST /ventas)
 */
export const queueSale = (saleData) => {
  const queue = getQueuedSales();
  const entry = {
    ...saleData,
    queuedAt: Date.now(),
    id: crypto.randomUUID(),
  };
  queue.push(entry);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
};

/**
 * Eliminar una venta de la cola tras sincronización exitosa.
 * @param {string} id - UUID local de la venta encolada
 */
export const removeQueuedSale = (id) => {
  const queue = getQueuedSales().filter((s) => s.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
};

/**
 * Obtener la cantidad de ventas pendientes en la cola.
 */
export const getQueuedCount = () => getQueuedSales().length;

/**
 * Vaciar toda la cola de ventas offline.
 */
export const clearQueue = () => localStorage.removeItem(QUEUE_KEY);
