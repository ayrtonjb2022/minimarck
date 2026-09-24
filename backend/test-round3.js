/* E2E smoke test — round 3 fixes (miniMarck)
 * Runs against a backend instance with the NEW code (PORT=3001).
 * Creates labeled TEST data (folio starts TEST-ROUND3- from idempotencyKey)
 * and asserts the confirmed fixes behave.
 */
const BASE = process.env.API_BASE || "http://localhost:3001/api";
const EMAIL = process.env.EMAIL || "admin@minimarck.com.ar";
const PASS = process.env.PASS || "admin123";

let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}${extra ? " | " + extra : ""}`);
  if (!cond) failures++;
};

async function call(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

(async () => {
  // 0) login
  const login = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASS } });
  ok("login 200", login.status === 200, `status=${login.status}`);
  const token = login.json?.data?.token;
  ok("token recibido", !!token);

  // 1) venta libre con costoUnitario + idempotencyKey
  const freeItem = {
    nombre: "TEST ROUND3 Libre Queso",
    precioUnitario: 1300,
    cantidad: 1,
    costoUnitario: 928.57, // 1300/(1+0.40)
  };
  const key = `test-round3-${Date.now()}`;
  const v1 = await call("/ventas", { method: "POST", token, body: { items: [freeItem], metodoPago: "efectivo", idempotencyKey: key } });
  ok("venta libre 201/200", v1.status === 200 || v1.status === 201, `status=${v1.status}`);
  const folio = v1.json?.data?.venta?.folio || v1.json?.data?.folio;
  const ventaId = v1.json?.data?.venta?.id || v1.json?.data?.id;
  ok("folio generado", !!folio, `folio=${folio}`);
  ok("libre sin duplicado flag en primer envío", !v1.json?.data?.duplicado);
  const vTotal = parseFloat(v1.json?.data?.venta?.total ?? v1.json?.data?.total);
  ok("total libre = 1300 (sin IVA encima)", vTotal === 1300, `total=${vTotal}`);

  // 2) mismo idempotencyKey → duplicado:true, MISMO id, sin segunda venta
  const v2 = await call("/ventas", { method: "POST", token, body: { items: [freeItem], metodoPago: "efectivo", idempotencyKey: key } });
  ok("retry mismo key → duplicado true", v2.json?.data?.duplicado === true, `status=${v2.status}`);
  const ventaId2 = v2.json?.data?.venta?.id || v2.json?.data?.id;
  ok("misma venta id", ventaId2 === ventaId, `id1=${ventaId} id2=${ventaId2}`);

  // 3) mismo ticket, OTRA key → nueva venta (dedup es por key, no por contenido)
  const v3 = await call("/ventas", { method: "POST", token, body: { items: [freeItem], metodoPago: "efectivo", idempotencyKey: key + "-b" } });
  ok("nueva key → nueva venta", !v3.json?.data?.duplicado && (v3.json?.data?.venta?.id || v3.json?.data?.id) !== ventaId, `status=${v3.status}`);

  // 4) crédito sin deudor → 400
  const c1 = await call("/ventas", { method: "POST", token, body: { items: [freeItem], metodoPago: "credito", idempotencyKey: key + "-c1" } });
  ok("crédito sin deudor → 400", c1.status === 400, `status=${c1.status} msg=${c1.json?.message || ""}`);

  // 5) mixto → 400
  const m1 = await call("/ventas", { method: "POST", token, body: { items: [freeItem], metodoPago: "mixto", idempotencyKey: key + "-m1" } });
  ok("mixto → 400", m1.status === 400, `status=${m1.status} msg=${m1.json?.message || ""}`);

  // 6) cantidad inválida (0) → 400
  const q1 = await call("/ventas", { method: "POST", token, body: { items: [{ ...freeItem, cantidad: 0 }], metodoPago: "efectivo", idempotencyKey: key + "-q1" } });
  ok("cantidad 0 → 400", q1.status === 400, `status=${q1.status}`);

  // 7) crédito CON deudor → 200 y deuda registrada
  const deudores = await call("/deudores", { token });
  const deudor = deudores.json?.data?.[0] || (Array.isArray(deudores.json?.data) && deudores.json.data[0]);
  ok("lista deudores disponible", !!deudor, deudor ? `deudorId=${deudor.id}` : `status=${deudores.status}`);
  if (deudor) {
    const dBefore = parseFloat(deudor.deudaPendiente ?? deudor.deudaTotal ?? 0);
    const c2 = await call("/ventas", { method: "POST", token, body: { items: [{ ...freeItem, nombre: "TEST ROUND3 Credito" }], metodoPago: "credito", clienteDeudorId: deudor.id, idempotencyKey: key + "-c2" } });
    ok("crédito con deudor → 200/201", c2.status === 200 || c2.status === 201, `status=${c2.status}`);
    const dAfter = await call(`/deudores/${deudor.id}`, { token });
    const deuda = parseFloat(dAfter.json?.data?.deudaPendiente ?? dAfter.json?.data?.deudaTotal ?? 0);
    ok("deuda del deudor aumentó", deuda > dBefore, `antes=${dBefore} despues=${deuda}`);
  }

  // 8) reporte de ventas: la línea libre debe mostrar ganancia ~28.57% (costo 928.57)
  const rep = await call(`/reportes/ventas?fechaInicio=2026-01-01&fechaFin=2026-12-31`, { token });
  ok("reporte ventas 200", rep.status === 200, `status=${rep.status}`);
  let found = null;
  for (const venta of rep.json?.data?.detalle || []) {
    if (venta.folio === folio) { found = venta; break; }
  }
  ok("venta libre aparece en reporte", !!found, `folio=${folio}`);
  if (found) {
    const det = found.detalles?.[0];
    ok("detalle libre sin productoId", det && det.productoId == null, `productoId=${det?.productoId}`);
    const pc = parseFloat(det?.costoUnitario) > 0 ? parseFloat(det.costoUnitario) : parseFloat(det?.producto?.precioCompra) || 0;
    const pv = parseFloat(det?.precioUnitario) || 0;
    const margen = pv > 0 ? ((pv - pc) / pv) * 100 : 0;
    ok("margen libre ~28.57% (no 100%)", Math.abs(margen - 28.57) < 0.5, `margen=${margen.toFixed(2)}% costo=${pc}`);
  }

  // 9) venta libre NO crea producto (sin contaminar inventario)
  const prods = await call(`/productos?search=TEST+ROUND3+Libre&limit=10`, { token });
  const lista = prods.json?.data?.items || prods.json?.data || [];
  const hay = Array.isArray(lista) && lista.some((p) => (p.nombre || "").includes("TEST ROUND3 Libre"));
  ok("venta libre no crea producto", !hay, `status=${prods.status}`);

  console.log(failures === 0 ? "\nRESULTADO: TODOS LOS CHECKS PASARON" : `\nRESULTADO: ${failures} CHECK(S) FALLARON`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("ERROR INESPERADO:", e.message); process.exit(2); });