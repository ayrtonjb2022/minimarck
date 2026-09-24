/**
 * Test: Desglose de caja por medio de pago
 * Verifica que el endpoint GET /api/cajas/:id/desglose
 * devuelva ventas agrupadas correctamente.
 */

const http = require("http");

const BASE = "http://localhost:3000";
let TOKEN = null;
let NEGOCIO_ID = null;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, msg) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ ${msg}`);
  }
}

async function main() {
  console.log("=== TEST: Desglose de Caja por Medio de Pago ===\n");

  // 1. Login
  console.log("1) Login...");
  const login = await request("POST", "/api/auth/login", {
    email: "admin@minimarck.com.ar",
    password: "admin123",
  });
  assert(login.status === 200, `Login status 200 (got ${login.status})`);
  TOKEN = login.body?.data?.token || login.body?.token;
  assert(TOKEN, "Token received");
  NEGOCIO_ID = login.body?.data?.negocioId || login.body?.data?.user?.negocioId;
  if (!NEGOCIO_ID) {
    // Try to get from user info
    const me = await request("GET", "/api/auth/me");
    NEGOCIO_ID = me.body?.data?.negocioId || me.body?.data?.user?.negocioId;
  }
  assert(NEGOCIO_ID, `Negocio ID: ${NEGOCIO_ID}`);

  // 2. Listar cajas
  console.log("\n2) Listar cajas...");
  const cajasRes = await request("GET", "/api/cajas?limit=5");
  assert(cajasRes.status === 200, `Cajas status 200 (got ${cajasRes.status})`);
  const cajas = cajasRes.body?.data || [];
  console.log(`   Encontradas ${cajas.length} cajas`);
  if (cajas.length === 0) {
    console.log("   ⚠️  No hay cajas — el test de desglose no puede continuar");
    return;
  }

  // 3. Probar desglose de la primera caja
  const cajaId = cajas[0].id;
  console.log(`\n3) Desglose de caja #${cajaId}...`);
  const desglose = await request("GET", `/api/cajas/${cajaId}/desglose`);
  assert(desglose.status === 200, `Desglose status 200 (got ${desglose.status})`);

  const data = desglose.body?.data;
  assert(data, "Desglose tiene data");
  assert(data.cajaId === cajaId, `cajaId coincide (${data.cajaId} === ${cajaId})`);
  assert(typeof data.desglose === "object", "desglose es un objeto");
  assert(typeof data.cantidades === "object", "cantidades es un objeto");

  const totalPorMetodo =
    (data.desglose.efectivo || 0) +
    (data.desglose.tarjeta || 0) +
    (data.desglose.transferencia || 0) +
    (data.desglose.mercadopago || 0) +
    (data.desglose.credito || 0) +
    (data.desglose.mixto || 0);

  assert(Math.abs(totalPorMetodo - data.totalVentas) < 0.01,
    `Total por métodos (${totalPorMetodo}) = totalVentas (${data.totalVentas})`);

  console.log(`\n   📊 Resultado:`);
  console.log(`   Efectivo:      $${(data.desglose.efectivo || 0).toFixed(2)} (${data.cantidades.efectivo || 0} ventas)`);
  console.log(`   Tarjeta:       $${(data.desglose.tarjeta || 0).toFixed(2)} (${data.cantidades.tarjeta || 0} ventas)`);
  console.log(`   Transferencia: $${(data.desglose.transferencia || 0).toFixed(2)} (${data.cantidades.transferencia || 0} ventas)`);
  console.log(`   MercadoPago:   $${(data.desglose.mercadopago || 0).toFixed(2)} (${data.cantidades.mercadopago || 0} ventas)`);
  console.log(`   Crédito:       $${(data.desglose.credito || 0).toFixed(2)} (${data.cantidades.credito || 0} ventas)`);
  console.log(`   Total ventas:  $${data.totalVentas.toFixed(2)}`);

  // 4. Verificar que crédito no se cuenta en total real
  console.log("\n4) Verificar lógica de crédito...");
  const totalReal =
    (data.desglose.efectivo || 0) +
    (data.desglose.tarjeta || 0) +
    (data.desglose.transferencia || 0) +
    (data.desglose.mercadopago || 0);
  assert(totalReal <= data.totalVentas,
    `Total real ($${totalReal.toFixed(2)}) <= totalVentas ($${data.totalVentas.toFixed(2)})`);
  if ((data.desglose.credito || 0) > 0) {
    assert(totalReal < data.totalVentas,
      `Crédito ($${data.desglose.credito}) no incluido en total real`);
  }

  // 5. Probar con caja inexistente
  console.log("\n5) Caja inexistente...");
  const bad = await request("GET", "/api/cajas/99999/desglose");
  assert(bad.status === 404, `Status 404 para caja inexistente (got ${bad.status})`);

  // 6. Verificar que la caja activa funciona
  console.log("\n6) Caja activa...");
  const activa = await request("GET", "/api/cajas/activa");
  assert(activa.status === 200, `Caja activa status 200 (got ${activa.status})`);
  if (activa.body?.data?.id) {
    const desgloseActiva = await request("GET", `/api/cajas/${activa.body.data.id}/desglose`);
    assert(desgloseActiva.status === 200, `Desglose caja activa 200 (got ${desgloseActiva.status})`);
    console.log(`   Caja activa #${activa.body.data.id}: totalVentas = $${(desgloseActiva.body?.data?.totalVentas || 0).toFixed(2)}`);
  } else {
    console.log("   No hay caja activa (OK, skip)");
  }

  // 7. Saldo general
  console.log("\n7) Saldo general...");
  const saldo = await request("GET", "/api/cajas/saldo-general");
  assert(saldo.status === 200, `Saldo general status 200 (got ${saldo.status})`);
  console.log(`   Saldo general: $${(saldo.body?.data?.saldoGeneral || 0).toFixed(2)}`);

  // 8. Verificar que ventas sin cajaId (históricas) se encuentran por fecha
  console.log("\n8) Verificar fallback por fecha...");
  const primeraCaja = cajas[cajas.length - 1]; // caja más vieja
  const fallback = await request("GET", `/api/cajas/${primeraCaja.id}/desglose`);
  assert(fallback.status === 200, `Fallback desglose status 200 (got ${fallback.status})`);
  const fbData = fallback.body?.data;
  console.log(`   Caja #${primeraCaja.id} (fallback): ${fbData?.totalVentas || 0} en ventas`);

  console.log("\n=== TEST COMPLETADO ===");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
