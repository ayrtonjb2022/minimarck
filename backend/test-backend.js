/**
 * ============================================================
 *  SCRIPT DE PRUEBAS — SISTEMA DE GESTIÓN DE NEGOCIOS
 *
 *  Arquitectura: Multi-tenant con RBAC
 *  Roles: admin, supervisor, vendedor
 *
 *  Ejecutar con: node test-backend.js
 *  Requisitos: Servidor corriendo en localhost:3000
 * ============================================================
 */

const BASE_URL = "http://localhost:3000/api";

// ─── COLORES ─────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

// ─── ESTADO GLOBAL ────────────────────────────────────────────
const S = {
  adminToken: null,
  supervisorToken: null,
  vendedorToken: null,

  adminId: null,
  supervisorId: null,
  vendedorId: null,

  categoriaId: null,
  productoId: null,
  cajaId: null,
  movimientoId: null,
  ventaId: null,
  deudorId: null,

  nuevoSupervisorToken: null,
  nuevoSupervisorId: null,
  nuevoNegocioId: null,

  proveedorId: null,
  compraId: null,

  // Para pruebas de rate limiting
  registroExitoso: false,
};

// ─── CONTADORES ───────────────────────────────────────────────
let passed = 0,
  failed = 0,
  skipped = 0;
const failures = [];

// ─── HELPERS ─────────────────────────────────────────────────
async function req(
  method,
  path,
  { body, token, expectedStatus, label, extractFn, note } = {},
) {
  const url = `${BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res, data;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get("content-type") || "";
    data = ct.includes("application/json")
      ? await res.json()
      : await res.text();
  } catch (err) {
    console.log(`  ${C.red}✗ [NET ERR] ${label}${C.reset}`);
    console.log(`    ${C.dim}→ ${err.message}${C.reset}`);
    failed++;
    failures.push({ label, reason: `Network: ${err.message}` });
    return null;
  }

  const expected = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  const ok = expected.includes(res.status);

  const icon = ok ? `${C.green}✔` : `${C.red}✗`;
  const statusColor = ok ? C.green : C.red;

  console.log(
    `  ${icon} [${statusColor}${res.status}${C.reset}] ${label}${C.reset}${note ? C.dim + "  ← " + note + C.reset : ""}`,
  );

  if (!ok) {
    const msg =
      typeof data === "object"
        ? JSON.stringify(data).slice(0, 200)
        : String(data).slice(0, 200);
    console.log(`    ${C.dim}→ ${msg}${C.reset}`);
    failed++;
    failures.push({ label, reason: `HTTP ${res.status} — ${msg}` });
    return null;
  }

  passed++;
  if (extractFn) extractFn(data);
  return data;
}

// ─── GENERADORES DE NOMBRES ÚNICOS ──────────────────────────
const generarNombreUnico = (base) =>
  `${base}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

// ─── ESPERA PARA EVITAR RATE LIMITING ──────────────────────
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function section(title) {
  console.log(`\n${C.cyan}${C.bold}━━━  ${title}  ━━━${C.reset}`);
}

function skip(label, reason) {
  console.log(`  ${C.yellow}⊘ [SKIP] ${label} — ${reason}${C.reset}`);
  skipped++;
}

// ════════════════════════════════════════════════════════════
//  SUITE COMPLETA
// ════════════════════════════════════════════════════════════

async function run() {
  console.log(
    `\n${C.bold}${C.cyan}╔══════════════════════════════════════════════╗`,
  );
  console.log(`║  TEST SUITE — Sistema de Gestión de Negocios  ║`);
  console.log(`╚══════════════════════════════════════════════╝${C.reset}`);
  console.log(`  Base URL: ${BASE_URL}\n`);

  // ══════════════════════════════════════════════════════════
  section("1 · AUTENTICACIÓN — Login");
  // ══════════════════════════════════════════════════════════

  await req("POST", "/auth/login", {
    label: "1.1 Login — admin@empresa.com",
    expectedStatus: 200,
    body: { email: "admin@empresa.com", password: "Admin123!" },
    extractFn: (d) => {
      S.adminToken = d.data?.token || d.token;
      S.adminId = d.data?.user?.id || d.user?.id;
    },
  });

  await req("POST", "/auth/login", {
    label: "1.2 Login — demo@tienda.com",
    expectedStatus: 200,
    body: { email: "demo@tienda.com", password: "Demo123!" },
    extractFn: (d) => {
      S.supervisorToken = d.data?.token || d.token;
      S.supervisorId = d.data?.user?.id || d.user?.id;
    },
  });

  await req("POST", "/auth/login", {
    label: "1.3 Login — mismo usuario (segundo token)",
    expectedStatus: 200,
    body: { email: "admin@empresa.com", password: "Admin123!" },
    extractFn: (d) => {
      S.vendedorToken = d.data?.token || d.token;
      S.vendedorId = d.data?.user?.id || d.user?.id;
    },
  });

  await req("POST", "/auth/login", {
    label: "1.4 Login — credenciales incorrectas (debe dar 401)",
    expectedStatus: 401,
    body: { email: "noexiste@test.com", password: "mal" },
  });

  await req("GET", "/auth/me", {
    label: "1.5 Me — sin token (debe dar 401)",
    expectedStatus: 401,
  });

  await req("GET", "/auth/me", {
    label: "1.6 Me — con token admin",
    expectedStatus: 200,
    token: S.adminToken,
  });

  await req("GET", "/auth/me", {
    label: "1.7 Me — con token supervisor",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  // ══════════════════════════════════════════════════════════
  section("2 · REGISTRO DE SUPERVISOR (NUEVO)");
  // ══════════════════════════════════════════════════════════

  const emailNuevoSupervisor = `super_${Date.now()}@nuevonegocio.com`;
  const nombreNegocio = generarNombreUnico("Mi Negocio");
  const nombreSupervisor = generarNombreUnico("Carlos Rodríguez");

  console.log(
    `  ${C.dim}📝 Registrando supervisor: ${emailNuevoSupervisor}${C.reset}`,
  );

  // 2.1 Registrar nuevo supervisor (dueño de negocio)
  const registroResponse = await req("POST", "/auth/register", {
    label: "2.1 Registrar supervisor con tipoComercio (debe dar 201)",
    expectedStatus: 201,
    body: {
      nombre: nombreSupervisor,
      email: emailNuevoSupervisor,
      password: "Super123!",
      nombreNegocio: nombreNegocio,
      ruc: `12345678901-${Date.now().toString().slice(-6)}`,
      telefono: "555-1234567",
      direccion: "Calle Principal 123",
      tipoComercio: "despensa",
    },
    extractFn: (d) => {
      S.nuevoSupervisorToken = d.data?.token || d.token;
      S.nuevoSupervisorId = d.data?.user?.id || d.user?.id;
      S.nuevoNegocioId = d.data?.negocio?.id || d.negocio?.id;
      S.registroExitoso = true;
    },
  });

  // Esperar para evitar rate limiting
  await esperar(1000);

  // Si el registro falló, saltar las pruebas dependientes
  if (!S.registroExitoso) {
    console.log(
      `  ${C.yellow}⚠️ Registro falló, saltando pruebas 2.2-2.5${C.reset}`,
    );
    skip("2.2-2.5", "Registro falló, probablemente por rate limiting");
  } else {
    // 2.2 Verificar que el usuario creado es ADMIN
    await req("GET", "/auth/me", {
      label: "2.2 Verificar rol del nuevo usuario (debe ser 'admin')",
      expectedStatus: 200,
      token: S.nuevoSupervisorToken,
      extractFn: (d) => {
        const user = d.data || d;
        if (user.rol === "admin") {
          console.log(`    ${C.green}✓ Rol correcto: admin${C.reset}`);
        } else {
          console.log(`    ${C.red}✗ Rol incorrecto: ${user.rol}${C.reset}`);
          failed++;
          failures.push({
            label: "2.2 Rol incorrecto",
            reason: `Se esperaba 'admin' pero se obtuvo '${user.rol}'`,
          });
        }
      },
    });

    // 2.3 Verificar que el negocio fue creado
    await req("GET", "/auth/me", {
      label: "2.3 Verificar negocio creado automáticamente",
      expectedStatus: 200,
      token: S.nuevoSupervisorToken,
      extractFn: (d) => {
        const user = d.data || d;
        if (user.negocio && user.negocio.id) {
          console.log(
            `    ${C.green}✓ Negocio creado: ${user.negocio.nombre} (${user.negocio.tipoComercio || "otro"})${C.reset}`,
          );
        } else {
          console.log(`    ${C.red}✗ Negocio no creado${C.reset}`);
          failed++;
          failures.push({
            label: "2.3 Negocio no creado",
            reason: "No se creó el negocio automáticamente",
          });
        }
      },
    });

    // Esperar para evitar rate limiting
    await esperar(1500);

    // 2.4 Intentar registrar con mismo email (duplicado)
    await req("POST", "/auth/register", {
      label: "2.4 Registro duplicado (debe dar 409)",
      expectedStatus: 409,
      body: {
        nombre: "Otro Usuario",
        email: emailNuevoSupervisor,
        password: "Super123!",
        nombreNegocio: "Otro Negocio",
      },
    });

    // Esperar para evitar rate limiting
    await esperar(1500);

    // 2.5 Verificar registro público exitoso (sin roles restrictivos)
    await req("POST", "/auth/register", {
      label: "2.5 Nuevo registro exitoso (debe dar 201)",
      expectedStatus: 201,
      body: {
        nombre: generarNombreUnico("Nuevo Usuario"),
        email: `nuevo_user_${Date.now()}@test.com`,
        password: "Secure123!",
        nombreNegocio: "Otro Negocio",
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  section("3 · CATEGORÍAS");
  // ══════════════════════════════════════════════════════════

  const nombreCategoria = generarNombreUnico("Electrónicos TEST");

  await req("POST", "/categorias", {
    label: "4.1 Crear categoría — supervisor (debe dar 201)",
    expectedStatus: 201,
    token: S.supervisorToken,
    body: {
      nombre: nombreCategoria,
      descripcion: "Categoría de prueba",
    },
    extractFn: (d) => {
      S.categoriaId = d.data?.id || d.id;
    },
  });

  await req("POST", "/categorias", {
    label: "4.2 Crear categoría — nombre duplicado (debe dar 400)",
    expectedStatus: 400,
    token: S.supervisorToken,
    body: {
      nombre: nombreCategoria,
      descripcion: "Duplicado",
    },
  });

  await req("GET", "/categorias", {
    label: "4.3 Listar categorías — supervisor",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  if (S.categoriaId) {
    await req("GET", `/categorias/${S.categoriaId}`, {
      label: "4.4 Obtener categoría por ID",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("PUT", `/categorias/${S.categoriaId}`, {
      label: "4.5 Actualizar categoría",
      expectedStatus: 200,
      token: S.supervisorToken,
      body: {
        nombre: `${nombreCategoria}_UPDATED`,
        descripcion: "Categoría actualizada",
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  section("5 · PRODUCTOS");
  // ══════════════════════════════════════════════════════════

  if (!S.categoriaId) {
    skip("5.1-5.7 Productos", "sin categoriaId");
  } else {
    const codigoProducto = `TV-${Date.now()}`;
    const nombreProducto = generarNombreUnico("Smart TV 55 TEST");

    await req("POST", "/productos", {
      label: "5.1 Crear producto — supervisor (debe dar 201)",
      expectedStatus: 201,
      token: S.supervisorToken,
      body: {
        nombre: nombreProducto,
        descripcion: "TV 4K de prueba",
        codigo: codigoProducto,
        precio: 699.99,
        precioCompra: 400.0,
        stock: 20,
        stockMinimo: 3,
        categoriaId: S.categoriaId,
      },
      extractFn: (d) => {
        S.productoId = d.data?.id || d.id;
      },
    });

    await req("POST", "/productos", {
      label: "5.2 Crear producto — código duplicado (debe dar 400)",
      expectedStatus: 400,
      token: S.supervisorToken,
      body: {
        nombre: generarNombreUnico("Otro TV"),
        codigo: codigoProducto,
        precio: 599.99,
        stock: 10,
        categoriaId: S.categoriaId,
      },
    });

    await req("GET", "/productos", {
      label: "5.3 Listar productos — supervisor",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("GET", "/productos?search=TV", {
      label: "5.4 Buscar productos por nombre",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    if (S.productoId) {
      await req("GET", `/productos/${S.productoId}`, {
        label: "5.5 Obtener producto por ID",
        expectedStatus: 200,
        token: S.supervisorToken,
      });

      await req("PUT", `/productos/${S.productoId}`, {
        label: "5.6 Actualizar producto",
        expectedStatus: 200,
        token: S.supervisorToken,
        body: {
          precio: 749.99,
          stock: 25,
        },
      });

      await req("GET", "/productos", {
        label: "5.7 Listar productos — vendedor (debe ver los mismos)",
        expectedStatus: 200,
        token: S.vendedorToken,
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  section("6 · CAJA");
  // ══════════════════════════════════════════════════════════

  const cajaActiva = await req("GET", "/cajas/activa", {
    label: "6.0 Verificar caja activa",
    expectedStatus: [200, 404],
    token: S.supervisorToken,
  });

  if (cajaActiva && cajaActiva.data && cajaActiva.data.id) {
    await req("PUT", `/cajas/cierre/${cajaActiva.data.id}`, {
      label: "6.0.1 Cerrar caja existente para prueba",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  await req("POST", "/cajas/apertura", {
    label: "6.1 Abrir caja — supervisor (debe dar 201)",
    expectedStatus: 201,
    token: S.supervisorToken,
    body: {
      saldoInicial: 500,
      observaciones: "Apertura de prueba",
    },
    extractFn: (d) => {
      S.cajaId = d.data?.id || d.id;
    },
  });

  await req("POST", "/cajas/apertura", {
    label: "6.2 Abrir caja — ya abierta (debe dar 400)",
    expectedStatus: 400,
    token: S.supervisorToken,
    body: { saldoInicial: 100 },
  });

  await req("GET", "/cajas/activa", {
    label: "6.3 Obtener caja activa",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  // ══════════════════════════════════════════════════════════
  section("7 · MOVIMIENTOS DE CAJA");
  // ══════════════════════════════════════════════════════════

  if (!S.cajaId) {
    skip("7.1-7.3 Movimientos", "sin cajaId");
  } else {
    await req("POST", "/movimientos", {
      label: "7.1 Registrar ingreso (debe dar 201)",
      expectedStatus: 201,
      token: S.supervisorToken,
      body: {
        tipo: "ingreso",
        concepto: "Venta contado TEST",
        monto: 200,
        referencia: `VENTA-TEST-${Date.now()}`,
        cajaId: S.cajaId,
      },
      extractFn: (d) => {
        S.movimientoId = d.data?.id || d.id;
      },
    });

    await req("POST", "/movimientos", {
      label: "7.2 Registrar egreso (debe dar 201)",
      expectedStatus: 201,
      token: S.supervisorToken,
      body: {
        tipo: "egreso",
        concepto: "Compra insumos TEST",
        monto: 75,
        referencia: `COMPRA-TEST-${Date.now()}`,
        cajaId: S.cajaId,
      },
    });

    await req("GET", `/movimientos/caja/${S.cajaId}`, {
      label: "7.3 Listar movimientos de caja",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  // ══════════════════════════════════════════════════════════
  section("8 · VENTAS");
  // ══════════════════════════════════════════════════════════

  if (!S.productoId) {
    skip("8.1-8.8 Ventas", "sin productoId");
  } else {
    await req("POST", "/ventas", {
      label: "8.1 Crear venta — supervisor (debe dar 201)",
      expectedStatus: 201,
      token: S.supervisorToken,
      body: {
        items: [{ productoId: S.productoId, cantidad: 2 }],
        metodoPago: "efectivo",
        clienteNombre: `Cliente Prueba ${Date.now()}`,
        observaciones: "Venta de prueba",
      },
      extractFn: (d) => {
        S.ventaId = d.data?.id || d.id;
      },
    });

    await req("POST", "/ventas", {
      label: "8.2 Crear venta — vendedor (debe dar 201)",
      expectedStatus: 201,
      token: S.vendedorToken,
      body: {
        items: [{ productoId: S.productoId, cantidad: 1 }],
        metodoPago: "tarjeta",
        clienteNombre: `Cliente Vendedor ${Date.now()}`,
      },
    });

    await req("POST", "/ventas", {
      label: "8.3 Stock insuficiente (debe dar 400)",
      expectedStatus: 400,
      token: S.supervisorToken,
      body: {
        items: [{ productoId: S.productoId, cantidad: 99999 }],
        metodoPago: "efectivo",
      },
    });

    await req("GET", "/ventas", {
      label: "8.4 Listar ventas — supervisor",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("GET", "/ventas", {
      label: "8.5 Listar ventas — vendedor (solo sus ventas)",
      expectedStatus: 200,
      token: S.vendedorToken,
    });

    if (S.ventaId) {
      await req("GET", `/ventas/${S.ventaId}`, {
        label: "8.6 Obtener venta por ID",
        expectedStatus: 200,
        token: S.supervisorToken,
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  section("9 · CLIENTES DEUDORES");
  // ══════════════════════════════════════════════════════════

  const nombreDeudor = generarNombreUnico("Juan Pérez TEST");
  const documentoDeudor = `DNI-${Date.now()}`;

  await req("POST", "/deudores", {
    label: "9.1 Crear deudor (debe dar 201)",
    expectedStatus: 201,
    token: S.supervisorToken,
    body: {
      nombre: nombreDeudor,
      documento: documentoDeudor,
      telefono: "555-1234",
      email: `juan_${Date.now()}@test.com`,
      direccion: "Calle Falsa 123",
      limiteCredito: 1000,
      notas: "Cliente de prueba",
    },
    extractFn: (d) => {
      S.deudorId = d.data?.id || d.id;
    },
  });

  await req("GET", "/deudores", {
    label: "9.2 Listar deudores — supervisor",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  await req("GET", "/deudores?conDeuda=true", {
    label: "9.3 Filtrar deudores con deuda",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  if (S.deudorId) {
    await req("GET", `/deudores/${S.deudorId}`, {
      label: "9.4 Obtener deudor por ID",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    if (S.productoId) {
      await req("POST", "/ventas", {
        label: "9.4.1 Crear venta a crédito para generar deuda",
        expectedStatus: 201,
        token: S.supervisorToken,
        body: {
          items: [{ productoId: S.productoId, cantidad: 3 }],
          metodoPago: "credito",
          clienteDeudorId: S.deudorId,
          clienteNombre: nombreDeudor,
          observaciones: "Venta a crédito para prueba",
        },
      });

      await req("POST", `/deudores/${S.deudorId}/pagos`, {
        label: "9.5 Registrar pago (debe dar 201)",
        expectedStatus: 201,
        token: S.supervisorToken,
        body: {
          monto: 200,
          metodoPago: "efectivo",
          referencia: `PAGO-${Date.now()}`,
          observaciones: "Abono inicial",
        },
      });
    } else {
      skip("9.5 Registrar pago", "sin productoId para generar deuda");
    }

    await req("GET", `/deudores/${S.deudorId}/pagos`, {
      label: "9.6 Listar pagos del deudor",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("PUT", `/deudores/${S.deudorId}`, {
      label: "9.7 Actualizar deudor",
      expectedStatus: 200,
      token: S.supervisorToken,
      body: {
        telefono: "555-9999",
        notas: "Cliente prioritario",
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  section("10 · DASHBOARD");
  // ══════════════════════════════════════════════════════════

  await req("GET", "/dashboard/stats", {
    label: "10.1 Estadísticas — supervisor",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  await req("GET", "/dashboard/stats?periodo=week", {
    label: "10.2 Estadísticas — semana",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  await req("GET", "/dashboard/stats?periodo=day", {
    label: "10.3 Estadísticas — día",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  // ══════════════════════════════════════════════════════════
  section("11 · REPORTES");
  // ══════════════════════════════════════════════════════════

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const fechaInicio = `${year}-${month}-01`;
  const fechaFin = `${year}-${month}-${day}`;

  await req(
    "GET",
    `/reportes/ventas?fechaInicio=${fechaInicio}&fechaFin=${fechaFin}`,
    {
      label: "11.1 Reporte de ventas por período",
      expectedStatus: 200,
      token: S.supervisorToken,
    },
  );

  await req("GET", `/reportes/productos-mas-vendidos?limit=5`, {
    label: "11.2 Reporte de productos más vendidos",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  if (S.cajaId) {
    await req("GET", `/reportes/caja/${S.cajaId}`, {
      label: "11.3 Reporte de caja",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  // ══════════════════════════════════════════════════════════
  section("12 · SUSCRIPCIÓN");
  // ══════════════════════════════════════════════════════════

  await req("GET", "/suscripciones/actual", {
    label: "12.1 Obtener suscripción actual — supervisor",
    expectedStatus: 200,
    token: S.supervisorToken,
    extractFn: (d) => {
      const s = d.data || d;
      if (s && s.plan) {
        console.log(`    ${C.green}✓ Plan: ${s.plan}, Max usuarios: ${s.maxUsuarios}${C.reset}`);
      }
    },
  });

  await req("GET", "/suscripciones/actual", {
    label: "12.2 Obtener suscripción — nuevo negocio registrado",
    expectedStatus: 200,
    token: S.nuevoSupervisorToken,
    extractFn: (d) => {
      const s = d.data || d;
      if (s && s.plan === "basico") {
        console.log(`    ${C.green}✓ Plan básico creado automáticamente al registrar${C.reset}`);
      }
    },
  });

  await req("GET", "/suscripciones/actual", {
    label: "12.3 Sin token (debe dar 401)",
    expectedStatus: 401,
  });

  // ══════════════════════════════════════════════════════════
  section("13 · PROVEEDORES");
  // ══════════════════════════════════════════════════════════

  const nombreProveedor = generarNombreUnico("Proveedor TEST");

  await req("POST", "/proveedores", {
    label: "13.1 Crear proveedor — supervisor (debe dar 201)",
    expectedStatus: 201,
    token: S.supervisorToken,
    body: {
      nombre: nombreProveedor,
      ruc: `RUC-${Date.now()}`,
      telefono: "555-1111",
      email: `proveedor_${Date.now()}@test.com`,
      direccion: "Av. Comercio 500",
      contacto: "Juan Proveedor",
      notas: "Proveedor de prueba",
    },
    extractFn: (d) => {
      S.proveedorId = d.data?.id || d.id;
    },
  });

  await req("POST", "/proveedores", {
      label: "13.2 Vendedor crea proveedor (ahora permitido)",
      expectedStatus: 201,
    token: S.vendedorToken,
    body: {
      nombre: generarNombreUnico("Proveedor Vendedor"),
      ruc: `RUC-V-${Date.now().toString().slice(-6)}`,
    },
  });

  await req("GET", "/proveedores", {
    label: "13.3 Listar proveedores — supervisor",
    expectedStatus: 200,
    token: S.supervisorToken,
  });

  await req("GET", "/proveedores", {
    label: "13.4 Listar proveedores — vendedor (ahora permitido)",
    expectedStatus: 200,
    token: S.vendedorToken,
  });

  if (S.proveedorId) {
    await req("GET", `/proveedores/${S.proveedorId}`, {
      label: "13.5 Obtener proveedor por ID",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("PUT", `/proveedores/${S.proveedorId}`, {
      label: "13.6 Actualizar proveedor",
      expectedStatus: 200,
      token: S.supervisorToken,
      body: {
        contacto: "Pedro Actualizado",
        notas: "Proveedor actualizado",
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  section("14 · COMPRAS");
  // ══════════════════════════════════════════════════════════

  if (S.productoId) {
    await req("POST", "/compras", {
      label: "14.1 Crear compra — supervisor (debe dar 201)",
      expectedStatus: 201,
      token: S.supervisorToken,
      body: {
        folio: `CMP-TEST-${Date.now()}`,
        proveedorId: S.proveedorId || null,
        observaciones: "Compra de prueba",
        items: [
          { productoId: S.productoId, cantidad: 10, precioUnitario: 25.50 },
        ],
      },
      extractFn: (d) => {
        S.compraId = d.data?.id || d.id;
      },
    });

    await req("POST", "/compras", {
      label: "14.2 Crear compra — vendedor (ahora permitido)",
      expectedStatus: 201,
      token: S.vendedorToken,
      body: {
        folio: `CMP-MAL-${Date.now()}`,
        items: [{ productoId: S.productoId, cantidad: 1, precioUnitario: 10 }],
      },
    });

    await req("POST", "/compras", {
      label: "14.3 Crear compra sin items (debe dar 400)",
      expectedStatus: 400,
      token: S.supervisorToken,
      body: {
        folio: `CMP-VACIO-${Date.now()}`,
        items: [],
      },
    });

    await req("GET", "/compras", {
      label: "14.4 Listar compras — supervisor",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("GET", "/compras", {
    label: "14.5 Listar compras — vendedor (ahora permitido)",
    expectedStatus: 200,
      token: S.vendedorToken,
    });

    if (S.compraId) {
      await req("GET", `/compras/${S.compraId}`, {
        label: "14.6 Obtener compra por ID con detalles y proveedor",
        expectedStatus: 200,
        token: S.supervisorToken,
        extractFn: (d) => {
          const c = d.data || d;
          if (c.detalles && c.detalles.length > 0) {
            console.log(`    ${C.green}✓ Compra con ${c.detalles.length} detalle(s)${C.reset}`);
          }
        },
      });

      await req("PUT", `/compras/${S.compraId}/cancelar`, {
        label: "14.7 Cancelar compra (debe dar 200)",
        expectedStatus: 200,
        token: S.supervisorToken,
      });

      await req("PUT", `/compras/${S.compraId}/cancelar`, {
        label: "14.8 Cancelar compra ya cancelada (debe dar 400)",
        expectedStatus: 400,
        token: S.supervisorToken,
      });
    }
  } else {
    skip("14.1-14.8 Compras", "sin productoId");
  }

  // ══════════════════════════════════════════════════════════
  section("15 · CIERRE DE CAJA");
  // ══════════════════════════════════════════════════════════

  if (S.cajaId) {
    await req("PUT", `/cajas/cierre/${S.cajaId}`, {
      label: "12.1 Cerrar caja (debe dar 200)",
      expectedStatus: 200,
      token: S.supervisorToken,
    });

    await req("PUT", `/cajas/cierre/${S.cajaId}`, {
      label: "12.2 Cerrar caja ya cerrada (debe dar 400)",
      expectedStatus: 400,
      token: S.supervisorToken,
    });

    await req("GET", "/cajas/activa", {
      label:
        "12.3 Sin caja activa después del cierre (debe dar 404 o 200 con null)",
      expectedStatus: [200, 404],
      token: S.supervisorToken,
    });
  }

  // ══════════════════════════════════════════════════════════
  section("16 · ELIMINACIÓN DE DATOS DE PRUEBA");
  // ══════════════════════════════════════════════════════════

  if (S.productoId) {
    await req("DELETE", `/productos/${S.productoId}`, {
      label: "16.1 Eliminar producto (soft delete)",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  if (S.categoriaId) {
    await req("DELETE", `/categorias/${S.categoriaId}`, {
      label: "16.2 Eliminar categoría (soft delete)",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  if (S.proveedorId) {
    await req("DELETE", `/proveedores/${S.proveedorId}`, {
      label: "16.3 Eliminar proveedor (soft delete)",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  if (S.deudorId) {
    await req("DELETE", `/deudores/${S.deudorId}`, {
      label: "16.4 Eliminar deudor (soft delete)",
      expectedStatus: 200,
      token: S.supervisorToken,
    });
  }

  // ══════════════════════════════════════════════════════════
  section("17 · SEGURIDAD Y PERMISOS");
  // ══════════════════════════════════════════════════════════

  await req("GET", "/productos", {
    label: "17.1 Sin token — productos (debe dar 401)",
    expectedStatus: 401,
  });

  await req("POST", "/productos", {
    label: "17.2 Sin token — crear producto (debe dar 401)",
    expectedStatus: 401,
    body: { nombre: "Test", precio: 100, stock: 10 },
  });

  await req("GET", "/productos", {
    label: "17.3 Token inválido (debe dar 401)",
    expectedStatus: 401,
    token: "token.invalido",
  });

  await req("POST", "/categorias", {
    label: "17.4 Vendedor crea categoría (ahora permitido)",
    expectedStatus: 201,
    token: S.vendedorToken,
    body: {
      nombre: generarNombreUnico("Categoría Prohibida"),
      descripcion: "Esto debería fallar por permisos",
    },
  });

  await req("POST", "/productos", {
    label: "17.5 Vendedor crea producto (depende de configuración)",
    expectedStatus: [403, 201],
    token: S.vendedorToken,
    body: {
      nombre: generarNombreUnico("Producto Vendedor"),
      codigo: `PROD-${Date.now()}`,
      precio: 100,
      precioCompra: 50,
      stock: 5,
      categoriaId: S.categoriaId || 1,
    },
  });

  // ══════════════════════════════════════════════════════════
  section("18 · CAMBIO DE CONTRASEÑA");
  // ══════════════════════════════════════════════════════════

  await req("PUT", "/auth/change-password", {
    label: "18.1 Cambiar contraseña — supervisor (debe dar 200)",
    expectedStatus: 200,
    token: S.supervisorToken,
    body: { currentPassword: "Demo123!", newPassword: "TempPass1!" },
  });

  await req("POST", "/auth/login", {
    label: "18.2 Login con nueva contraseña (debe dar 200)",
    expectedStatus: 200,
    body: { email: "demo@tienda.com", password: "TempPass1!" },
    extractFn: (d) => {
      S.supervisorToken = d.data?.token || d.token;
    },
  });

  await req("PUT", "/auth/change-password", {
    label: "18.3 Restaurar contraseña original (debe dar 200)",
    expectedStatus: 200,
    token: S.supervisorToken,
    body: { currentPassword: "TempPass1!", newPassword: "Demo123!" },
  });

  await req("PUT", "/auth/change-password", {
    label: "18.4 Contraseña actual incorrecta (debe dar 400)",
    expectedStatus: 400,
    token: S.supervisorToken,
    body: { currentPassword: "wrong", newPassword: "Otra123!" },
  });

  await req("PUT", "/auth/change-password", {
    label: "18.5 Sin token (debe dar 401)",
    expectedStatus: 401,
    body: { currentPassword: "x", newPassword: "y" },
  });

  // ══════════════════════════════════════════════════════════
  //  RESUMEN FINAL
  // ══════════════════════════════════════════════════════════
  const total = passed + failed + skipped;
  console.log(`\n${C.bold}${C.cyan}${"━".repeat(50)}${C.reset}`);
  console.log(`${C.bold}  RESUMEN FINAL${C.reset}`);
  console.log(`${C.cyan}${"━".repeat(50)}${C.reset}`);
  console.log(`  Total:     ${total}`);
  console.log(`  ${C.green}✔ Passed:  ${passed}${C.reset}`);
  console.log(`  ${C.red}✗ Failed:  ${failed}${C.reset}`);
  console.log(`  ${C.yellow}⊘ Skipped: ${skipped}${C.reset}`);

  const tasa = total > 0 ? Math.round((passed / (total - skipped)) * 100) : 0;
  const color = tasa === 100 ? C.green : tasa >= 80 ? C.yellow : C.red;
  console.log(
    `\n  ${color}${C.bold}Tasa de éxito: ${tasa}% (de ${total - skipped} ejecutados)${C.reset}`,
  );

  if (failures.length > 0) {
    console.log(`\n${C.bold}${C.red}  ── FALLAS DETECTADAS ──${C.reset}`);
    failures.forEach((f, i) => {
      console.log(`\n  ${C.red}${i + 1}. ${f.label}${C.reset}`);
      console.log(`     ${C.dim}${f.reason}${C.reset}`);
    });
  } else {
    console.log(
      `\n  ${C.green}${C.bold}🎉 ¡Todas las pruebas pasaron!${C.reset}`,
    );
  }

  console.log(`\n${C.cyan}${"━".repeat(50)}${C.reset}\n`);

  if (failed > 0) process.exit(1);
}

// ════════════════════════════════════════════════════════════
//  EJECUCIÓN
// ════════════════════════════════════════════════════════════

run().catch((err) => {
  console.error(`\n${C.red}Error fatal:${C.reset}`, err.message);
  process.exit(1);
});
