require("dotenv").config();
const sequelize = require("./src/config/database");
const {
  Negocio,
  User,
  Categoria,
  Producto,
  Proveedor,
  ClienteDeudor,
  Venta,
  VentaDetalle,
  Caja,
  MovimientoCaja,
  PagoDeuda,
  Compra,
  CompraDetalle,
  CuentaContable,
  AsientoContable,
  DetalleAsiento,
  CuentaCorrienteDeuda,
  PagoDeudaContabilidad,
} = require("./src/models/index");

// ─── HELPERS ────────────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, n);
}

function randomDate(start, end) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return new Date(s + Math.random() * (e - s));
}

function randomTime(dateStr, minH, maxH) {
  const d = new Date(dateStr);
  const h = rand(minH, maxH);
  d.setHours(h, rand(0, 59), rand(0, 59));
  return d;
}

function isWeekday(d) {
  const day = d.getDay();
  return day >= 1 && day <= 6;
}

function dateToStr(d) {
  return d.toISOString().slice(0, 10);
}

// ─── STATIC DATA ────────────────────────────────────────────────────────────

const CATEGORY_NAMES = [
  "Bebidas", "Alimentos", "Limpieza", "Higiene", "Golosinas",
  "Lácteos", "Carnes", "Verdulería", "Snacks", "Conservas",
  "Bebidas Alcohólicas", "Electrónica", "Mascotas", "Tabaco", "Panadería",
];

const PRODUCTS = [
  // Bebidas
  { nombre: "Coca-Cola 500ml", precio: 1800, categoria: "Bebidas", unidad: "unidad" },
  { nombre: "Coca-Cola 1.5L", precio: 3200, categoria: "Bebidas", unidad: "unidad" },
  { nombre: "Agua Mineral 500ml", precio: 900, categoria: "Bebidas", unidad: "unidad" },
  { nombre: "Agua Mineral 2.25L", precio: 1800, categoria: "Bebidas", unidad: "unidad" },
  { nombre: "Sprite 500ml", precio: 1600, categoria: "Bebidas", unidad: "unidad" },
  // Bebidas Alcohólicas
  { nombre: "Fernet Branca 750ml", precio: 6500, categoria: "Bebidas Alcohólicas", unidad: "unidad" },
  { nombre: "Cerveza Quilmes 473ml", precio: 2200, categoria: "Bebidas Alcohólicas", unidad: "unidad" },
  { nombre: "Cerveza Quilmes 1L", precio: 3800, categoria: "Bebidas Alcohólicas", unidad: "unidad" },
  { nombre: "Vino Malbec 750ml", precio: 4200, categoria: "Bebidas Alcohólicas", unidad: "unidad" },
  { nombre: "Cerveza Patagonia 473ml", precio: 2800, categoria: "Bebidas Alcohólicas", unidad: "unidad" },
  // Alimentos
  { nombre: "Yerba Mate 1kg", precio: 3500, categoria: "Alimentos", unidad: "unidad" },
  { nombre: "Arroz 1kg", precio: 1800, categoria: "Alimentos", unidad: "unidad" },
  { nombre: "Aceite de Girasol 900ml", precio: 3200, categoria: "Alimentos", unidad: "unidad" },
  { nombre: "Fideos Spaghetti 500g", precio: 1400, categoria: "Alimentos", unidad: "unidad" },
  { nombre: "Azúcar 1kg", precio: 2100, categoria: "Alimentos", unidad: "unidad" },
  { nombre: "Harina 1kg", precio: 1200, categoria: "Alimentos", unidad: "unidad" },
  { nombre: "Sal 500g", precio: 800, categoria: "Alimentos", unidad: "unidad" },
  // Lácteos
  { nombre: "Leche La Serenísima 1L", precio: 1500, categoria: "Lácteos", unidad: "unidad" },
  { nombre: "Queso Cremoso xkg", precio: 8500, categoria: "Lácteos", unidad: "kg" },
  { nombre: "Manteca 200g", precio: 2800, categoria: "Lácteos", unidad: "unidad" },
  { nombre: "Yogur Serenísimo x12", precio: 3600, categoria: "Lácteos", unidad: "unidad" },
  { nombre: "Queso Cacique 200g", precio: 3200, categoria: "Lácteos", unidad: "unidad" },
  // Limpieza
  { nombre: "Papel Higiénico x4", precio: 2200, categoria: "Limpieza", unidad: "pack" },
  { nombre: "Detergente Líquido 1L", precio: 1900, categoria: "Limpieza", unidad: "unidad" },
  { nombre: "Lavandina 1L", precio: 1100, categoria: "Limpieza", unidad: "unidad" },
  { nombre: "Jabón en Barra x3", precio: 1500, categoria: "Limpieza", unidad: "pack" },
  { nombre: "Esponja Pack x3", precio: 1200, categoria: "Limpieza", unidad: "pack" },
  // Higiene
  { nombre: "Shampoo Pantene 400ml", precio: 3400, categoria: "Higiene", unidad: "unidad" },
  { nombre: "Jabón Dove x3", precio: 2600, categoria: "Higiene", unidad: "pack" },
  { nombre: "Crema Dental Colgate 90g", precio: 1800, categoria: "Higiene", unidad: "unidad" },
  // Golosinas
  { nombre: "Chocolate Milka 100g", precio: 2800, categoria: "Golosinas", unidad: "unidad" },
  { nombre: "Caramelo Sugus x12", precio: 900, categoria: "Golosinas", unidad: "unidad" },
  { nombre: "Galletitas Oreo x6", precio: 1600, categoria: "Golosinas", unidad: "unidad" },
  // Snacks
  { nombre: "Papas Fritas Lays 120g", precio: 1800, categoria: "Snacks", unidad: "unidad" },
  { nombre: "Pocillo Cheetos 80g", precio: 1500, categoria: "Snacks", unidad: "unidad" },
  // Conservas
  { nombre: "Atún Gomes 170g", precio: 2200, categoria: "Conservas", unidad: "unidad" },
  { nombre: "Arvejas La Campagnola 300g", precio: 1400, categoria: "Conservas", unidad: "unidad" },
  { nombre: "Tomate perita 400g", precio: 1300, categoria: "Conservas", unidad: "unidad" },
  // Carnes
  { nombre: "Pollo Entero xkg", precio: 2800, categoria: "Carnes", unidad: "kg" },
  { nombre: "Carne Picada xkg", precio: 5200, categoria: "Carnes", unidad: "kg" },
  // Verdulería
  { nombre: "Tomate xkg", precio: 1600, categoria: "Verdulería", unidad: "kg" },
  { nombre: "Lechuga xkg", precio: 1200, categoria: "Verdulería", unidad: "kg" },
  { nombre: "Banana xkg", precio: 2000, categoria: "Verdulería", unidad: "kg" },
  { nombre: "Naranja xkg", precio: 1400, categoria: "Verdulería", unidad: "kg" },
  // Electrónica
  { nombre: "Pilas AA x4", precio: 2400, categoria: "Electrónica", unidad: "pack" },
  { nombre: "Cable USB-C 1m", precio: 3200, categoria: "Electrónica", unidad: "unidad" },
  // Mascotas
  { nombre: "Alimento Cat Chow 1kg", precio: 4800, categoria: "Mascotas", unidad: "unidad" },
  // Tabaco
  { nombre: "Cigarrillos Marlboro x10", precio: 3600, categoria: "Tabaco", unidad: "pack" },
  // Panadería
  { nombre: "Pan Lactal x6", precio: 1800, categoria: "Panadería", unidad: "unidad" },
  { nombre: "Medialunas x6", precio: 2400, categoria: "Panadería", unidad: "unidad" },
];

const PROVEEDORES = [
  { nombre: "Distribuidora del Sur", ruc: "30-71234567-9", email: "ventas@disursur.com.ar", contacto: "Roberto Méndez" },
  { nombre: "La Serenísima", ruc: "30-54321098-1", email: "comercial@laserenisima.com.ar", contacto: "Laura Fernández" },
  { nombre: "Mastellone Hermanos", ruc: "30-67890123-4", email: "pedidos@mastellone.com.ar", contacto: "Carlos García" },
  { nombre: "Pepsico Argentina", ruc: "30-78901234-5", email: "ventas@pepsico.com.ar", contacto: "Marina López" },
  { nombre: "Almacenes Argentinos", ruc: "30-89012345-6", email: "distribucion@almargentinos.com.ar", contacto: "Pedro Ramírez" },
  { nombre: "Distribuidora Norte", ruc: "30-90123456-7", email: "ventas@disnorte.com.ar", contacto: "Andrea Torres" },
];

const CLIENTES_DEUDORES = [
  { nombre: "Juan Carlos Pérez", documento: "28456789", telefono: "11-5555-1001", limiteCredito: 100000 },
  { nombre: "María Elena Gómez", documento: "30123456", telefono: "11-5555-1002", limiteCredito: 80000 },
  { nombre: "Carlos Alberto Díaz", documento: "27987654", telefono: "11-5555-1003", limiteCredito: 150000 },
  { nombre: "Luciana Martínez", documento: "33456789", telefono: "11-5555-1004", limiteCredito: 60000 },
  { nombre: "Fernando Rodríguez", documento: "31765432", telefono: "11-5555-1005", limiteCredito: 120000 },
];

const CUENTAS_CONTABLES = [
  // Activo
  { codigo: "1.1.01", nombre: "Caja", tipo: "activo", desc: "Efectivo en caja" },
  { codigo: "1.1.02", nombre: "Banco", tipo: "activo", desc: "Cuentas bancarias" },
  { codigo: "1.1.03", nombre: "MercadoPago", tipo: "activo", desc: "Cuenta MercadoPago" },
  { codigo: "1.2.01", nombre: "Mercaderías", tipo: "activo", desc: "Stock de mercaderías" },
  { codigo: "1.3.01", nombre: "Clientes (Deudores)", tipo: "activo", desc: "Créditos a clientes" },
  { codigo: "1.4.01", nombre: "Equipos y Rodados", tipo: "activo", desc: "Equipamiento del negocio" },
  // Pasivo
  { codigo: "2.1.01", nombre: "Proveedores (Acreedores)", tipo: "pasivo", desc: "Deudas con proveedores" },
  { codigo: "2.2.01", nombre: "Préstamo MercadoPago", tipo: "pasivo", desc: "Préstamo MercadoPago" },
  { codigo: "2.2.02", nombre: "Préstamo Bancario", tipo: "pasivo", desc: "Préstamo bancario" },
  { codigo: "2.2.03", nombre: "Préstamo Personal", tipo: "pasivo", desc: "Préstamo a persona" },
  { codigo: "2.3.01", nombre: "Impuestos a Pagar", tipo: "pasivo", desc: "Impuestos adeudados" },
  { codigo: "2.4.01", nombre: "Sueldos a Pagar", tipo: "pasivo", desc: "Sueldos adeudados" },
  // Capital
  { codigo: "3.1.01", nombre: "Capital Social", tipo: "capital", desc: "Capital aportado" },
  { codigo: "3.2.01", nombre: "Resultados Acumulados", tipo: "capital", desc: "Resultados de ejercicios anteriores" },
  // Ingreso
  { codigo: "4.1.01", nombre: "Ventas", tipo: "ingreso", desc: "Ingresos por ventas" },
  { codigo: "4.2.01", nombre: "Otros Ingresos", tipo: "ingreso", desc: "Otros ingresos" },
  // Gasto
  { codigo: "5.1.01", nombre: "Costo de Mercadería Vendida", tipo: "gasto", desc: "Costo de mercadería vendida" },
  { codigo: "5.2.01", nombre: "Sueldos y Cargas Sociales", tipo: "gasto", desc: "Sueldos y cargas" },
  { codigo: "5.2.02", nombre: "Alquiler", tipo: "gasto", desc: "Alquiler del local" },
  { codigo: "5.2.03", nombre: "Servicios (Luz, Gas, Internet)", tipo: "gasto", desc: "Servicios básicos" },
  { codigo: "5.2.04", nombre: "Impuestos y Tasas", tipo: "gasto", desc: "Impuestos municipales y nacionales" },
  { codigo: "5.3.01", nombre: "Gastos Bancarios", tipo: "gasto", desc: "Comisiones bancarias" },
  { codigo: "5.3.02", nombre: "Mantenimiento y Reparaciones", tipo: "gasto", desc: "Mantenimiento del local" },
];

// ─── SEED ───────────────────────────────────────────────────────────────────

async function seed() {
  console.log("🔄 Syncing database (no force, no alter)...");
  await sequelize.sync();
  console.log("✅ Database synced\n");

  const existingNegocio = await Negocio.findOne();
  if (existingNegocio) {
    console.log("⚠️  Data already exists. Clearing all tables...");
    // Destroy in reverse dependency order
    await PagoDeudaContabilidad.destroy({ where: {} });
    await DetalleAsiento.destroy({ where: {} });
    await AsientoContable.destroy({ where: {} });
    await CuentaCorrienteDeuda.destroy({ where: {} });
    await CuentaContable.destroy({ where: {} });
    await PagoDeuda.destroy({ where: {} });
    await ClienteDeudor.destroy({ where: {} });
    await MovimientoCaja.destroy({ where: {} });
    await VentaDetalle.destroy({ where: {} });
    await Venta.destroy({ where: {} });
    await CompraDetalle.destroy({ where: {} });
    await Compra.destroy({ where: {} });
    await Caja.destroy({ where: {} });
    await Producto.destroy({ where: {} });
    await Proveedor.destroy({ where: {} });
    await Categoria.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Negocio.destroy({ where: {} });
    console.log("🗑️  All data cleared\n");
  }

  // ── 1. NEGOCIO ──────────────────────────────────────────────────────
  console.log("📦 Creating Negocio...");
  const negocio = await Negocio.create({
    nombre: "Mini Marck - Sucursal Centro",
    ruc: "30-71234567-9",
    direccion: "Av. San Martín 1234, Piso 1",
    telefono: "11-4444-5555",
    email: "info@minimarck.com.ar",
    tipoComercio: "despensa",
    activo: true,
  });
  console.log(`  ✅ Negocio created: ${negocio.nombre} (ID: ${negocio.id})`);

  // ── 2. USERS ────────────────────────────────────────────────────────
  console.log("👤 Creating Users...");
  const admin = await User.create({
    nombre: "Admin Mini Marck",
    email: "admin@minimarck.com.ar",
    password: "admin123",
    rol: "admin",
    negocioId: negocio.id,
    activo: true,
  });
  const cajero = await User.create({
    nombre: "María López",
    email: "cajero@minimarck.com.ar",
    password: "cajero123",
    rol: "cajero",
    negocioId: negocio.id,
    activo: true,
  });
  console.log(`  ✅ Users created: Admin (${admin.id}) + Cajero (${cajero.id})`);

  // ── 3. CATEGORIES ───────────────────────────────────────────────────
  console.log("📂 Creating Categories...");
  const catRecords = await Categoria.bulkCreate(
    CATEGORY_NAMES.map((nombre) => ({
      nombre,
      userId: admin.id,
      negocioId: negocio.id,
      activo: true,
    }))
  );
  const catMap = {};
  catRecords.forEach((c) => (catMap[c.nombre] = c.id));
  console.log(`  ✅ ${catRecords.length} categories created`);

  // ── 4. PRODUCTS ─────────────────────────────────────────────────────
  console.log("🏷️  Creating Products...");
  const usedCodes = new Set();
  function makeCode(nombre, idx) {
    let base = nombre
      .replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .substring(0, 3)
      .toUpperCase();
    if (base.length < 3) base = base.padEnd(3, "X");
    let code = base;
    let suffix = 1;
    while (usedCodes.has(code)) {
      code = base.substring(0, 2) + String(suffix);
      suffix++;
    }
    usedCodes.add(code);
    return code;
  }

  const productRecords = PRODUCTS.map((p, i) => ({
    nombre: p.nombre,
    codigo: makeCode(p.nombre, i),
    precio: p.precio,
    precioCompra: Math.round(p.precio * randFloat(0.5, 0.65)),
    stock: rand(5, 60),
    stockMinimo: 5,
    categoriaId: catMap[p.categoria],
    unidadMedida: p.unidad,
    negocioId: negocio.id,
    userId: admin.id,
    activo: true,
    tieneIva: p.precio > 3000,
    ivaPorcentaje: p.precio > 3000 ? 21.0 : null,
  }));
  const productRecordsCreated = await Producto.bulkCreate(productRecords);
  const products = productRecordsCreated.map((p) => p.get({ plain: true }));
  console.log(`  ✅ ${products.length} products created`);

  // ── 5. PROVEEDORES ──────────────────────────────────────────────────
  console.log("🚚 Creating Proveedores...");
  const proveedores = await Proveedor.bulkCreate(
    PROVEEDORES.map((p) => ({
      nombre: p.nombre,
      ruc: p.ruc,
      email: p.email,
      contacto: p.contacto,
      negocioId: negocio.id,
      activo: true,
    }))
  );
  console.log(`  ✅ ${proveedores.length} proveedores created`);

  // ── 6. CLIENTES DEUDORES ────────────────────────────────────────────
  console.log("📋 Creating Clientes Deudores...");
  const deudores = await ClienteDeudor.bulkCreate(
    CLIENTES_DEUDORES.map((c) => ({
      nombre: c.nombre,
      documento: c.documento,
      telefono: c.telefono,
      limiteCredito: c.limiteCredito,
      deudaTotal: 0,
      deudaPendiente: 0,
      userId: admin.id,
      negocioId: negocio.id,
      activo: true,
    }))
  );
  console.log(`  ✅ ${deudores.length} clientes deudores created`);

  // ── 7. CAJAS (Mon-Sat, March-August 2026) ──────────────────────────
  console.log("💰 Creating Cajas...");
  const cajasAbiertas = [50000, 80000, 100000, 120000];
  const startDate = new Date("2026-03-01");
  const endDate = new Date("2026-08-31");
  const cajasData = [];
  const cajasMap = {}; // dateStr -> caja record

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    if (!isWeekday(d)) continue;
    const dateStr = dateToStr(d);
    const apertura = randomTime(dateStr, 8, 9);
    const cierre = randomTime(dateStr, 19, 21);
    const saldoInicial = pick(cajasAbiertas);
    const totalIngresos = rand(80000, 250000);
    cajasData.push({
      fechaApertura: apertura,
      fechaCierre: cierre,
      saldoInicial,
      saldoFinal: saldoInicial + totalIngresos,
      totalIngresos,
      totalEgresos: rand(0, 15000),
      estado: "cerrada",
      userId: admin.id,
      usuarioApertura: admin.id,
      usuarioCierre: pick([admin.id, cajero.id]),
      negocioId: negocio.id,
    });
  }
  const cajasRecords = await Caja.bulkCreate(cajasData);
  cajasRecords.forEach((c) => {
    cajasMap[dateToStr(c.fechaApertura)] = c.get({ plain: true });
  });
  console.log(`  ✅ ${cajasRecords.length} cajas created (Mon-Sat, Mar-Aug 2026)`);

  // ── 8. VENTAS + DETALLES + MOVIMIENTOS ─────────────────────────────
  console.log("🛒 Creating Ventas...");
  let ventaCount = 0;
  let detalleCount = 0;
  let movimientoCount = 0;
  let folioVenta = 1;
  const allVentas = [];
  const allDetalles = [];
  const allMovimientos = [];

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    if (!isWeekday(d)) continue;
    const dateStr = dateToStr(d);
    const caja = cajasMap[dateStr];
    if (!caja) continue;

    const dayOfWeek = d.getDay();
    const numVentas = dayOfWeek === 5 ? rand(12, 20) : dayOfWeek === 6 ? rand(10, 18) : rand(5, 12);
    let cajaSaldo = parseFloat(caja.saldoInicial);

    for (let v = 0; v < numVentas; v++) {
      const numItems = rand(1, 4);
      const saleProducts = pickN(products, numItems);
      let subtotalVenta = 0;

      const detalles = saleProducts.map((p) => {
        const qty = p.unidadMedida === "kg" ? randFloat(0.5, 3) : rand(1, 5);
        const sub = Math.round(qty * parseFloat(p.precio) * 100) / 100;
        subtotalVenta += sub;
        return {
          cantidad: qty,
          precioUnitario: parseFloat(p.precio),
          nombreProducto: p.nombre,
          descuento: 0,
          subtotal: sub,
          productoId: p.id,
        };
      });

      const totalVenta = Math.round(subtotalVenta * 100) / 100;
      const r = Math.random();
      const metodoPago = r < 0.85 ? "efectivo" : r < 0.95 ? "tarjeta" : "credito";
      const deudorId = metodoPago === "credito" ? pick(deudores).id : null;
      const ventaHora = randomTime(dateStr, 8, 20);

      const venta = {
        folio: `VTA-${String(folioVenta++).padStart(5, "0")}`,
        fecha: ventaHora,
        subtotal: totalVenta,
        iva: 0,
        descuento: 0,
        total: totalVenta,
        metodoPago,
        estado: "completada",
        userId: pick([admin.id, cajero.id]),
        negocioId: negocio.id,
        cajaId: caja.id,
        deudorId,
      };
      allVentas.push(venta);
      ventaCount++;

      for (const det of detalles) {
        allDetalles.push({ ...det, ventaIdx: ventaCount - 1 });
        detalleCount++;
      }

      if (metodoPago === "efectivo") {
        const mov = {
          tipo: "ingreso",
          concepto: `Venta ${venta.folio}`,
          monto: totalVenta,
          saldoAnterior: cajaSaldo,
          saldoNuevo: Math.round((cajaSaldo + totalVenta) * 100) / 100,
          cajaId: caja.id,
          userId: venta.userId,
          negocioId: negocio.id,
          ventaIdx: ventaCount - 1,
        };
        allMovimientos.push(mov);
        movimientoCount++;
        cajaSaldo = mov.saldoNuevo;
      }
    }
  }

  console.log(`  ⏳ Bulk creating ${ventaCount} ventas...`);
  const ventasRecords = await Venta.bulkCreate(allVentas);
  console.log(`  ⏳ Bulk creating ${detalleCount} venta detalles...`);
  const detallesWithVentaId = allDetalles.map((d, i) => ({
    cantidad: d.cantidad,
    precioUnitario: d.precioUnitario,
    nombreProducto: d.nombreProducto,
    descuento: d.descuento,
    subtotal: d.subtotal,
    productoId: d.productoId,
    ventaId: ventasRecords[d.ventaIdx].id,
  }));
  await VentaDetalle.bulkCreate(detallesWithVentaId);

  console.log(`  ⏳ Bulk creating ${movimientoCount} movimientos...`);
  const movimientosWithCajaId = allMovimientos.map((m) => ({
    tipo: m.tipo,
    concepto: m.concepto,
    monto: m.monto,
    saldoAnterior: m.saldoAnterior,
    saldoNuevo: m.saldoNuevo,
    cajaId: m.cajaId,
    userId: m.userId,
    negocioId: m.negocioId,
    ventaId: ventasRecords[m.ventaIdx].id,
  }));
  await MovimientoCaja.bulkCreate(movimientosWithCajaId);

  console.log(
    `  ✅ ${ventaCount} ventas, ${detalleCount} detalles, ${movimientoCount} movimientos created`
  );

  // ── 9. COMPRAS + DETALLES ───────────────────────────────────────────
  console.log("📦 Creating Compras...");
  let compraCount = 0;
  let compraDetalleCount = 0;
  const allCompras = [];
  const allCompraDetalles = [];

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    if (!isWeekday(d)) continue;
    const day = d.getDate();
    if (day !== 1 && day !== 15) continue;

    const numCompras = rand(2, 4);
    for (let c = 0; c < numCompras; c++) {
      const proveedor = pick(proveedores);
      const numItems = rand(3, 8);
      const compraProducts = pickN(products, numItems);
      let subtotalCompra = 0;

      const detalles = compraProducts.map((p) => {
        const qty = rand(5, 30);
        const sub = Math.round(qty * parseFloat(p.precioCompra) * 100) / 100;
        subtotalCompra += sub;
        return {
          cantidad: qty,
          precioUnitario: parseFloat(p.precioCompra),
          subtotal: sub,
          productoId: p.id,
        };
      });

      const totalCompra = Math.round(subtotalCompra * 100) / 100;
      const compra = {
        folio: `CMP-${String(compraCount + 1).padStart(4, "0")}`,
        fecha: randomTime(dateToStr(d), 10, 16),
        subtotal: totalCompra,
        iva: Math.round(totalCompra * 0.21 * 100) / 100,
        descuento: 0,
        total: totalCompra,
        estado: "completada",
        proveedorId: proveedor.id,
        userId: admin.id,
        negocioId: negocio.id,
      };
      allCompras.push(compra);
      compraCount++;

      for (const det of detalles) {
        allCompraDetalles.push({ ...det, compraIdx: compraCount - 1 });
        compraDetalleCount++;
      }
    }
  }

  console.log(`  ⏳ Bulk creating ${compraCount} compras...`);
  const comprasRecords = await Compra.bulkCreate(allCompras);
  console.log(`  ⏳ Bulk creating ${compraDetalleCount} compra detalles...`);
  const compraDetallesWithId = allCompraDetalles.map((d) => ({
    cantidad: d.cantidad,
    precioUnitario: d.precioUnitario,
    subtotal: d.subtotal,
    productoId: d.productoId,
    compraId: comprasRecords[d.compraIdx].id,
  }));
  await CompraDetalle.bulkCreate(compraDetallesWithId);
  console.log(`  ✅ ${compraCount} compras, ${compraDetalleCount} detalles created`);

  // ── 10. PAGOS DE DEUDA (clientes) ──────────────────────────────────
  console.log("💳 Creating Pagos de Deuda (clientes)...");
  let pagoDeudaCount = 0;
  const allPagosDeuda = [];

  for (const deudor of deudores) {
    const numPagos = rand(3, 8);
    for (let i = 0; i < numPagos; i++) {
      allPagosDeuda.push({
        monto: rand(5000, 30000),
        fecha: randomDate(startDate, endDate),
        metodoPago: pick(["efectivo", "transferencia", "tarjeta"]),
        referencia: `Pago ${i + 1} - ${deudor.nombre}`,
        deudorId: deudor.id,
        userId: admin.id,
        negocioId: negocio.id,
      });
      pagoDeudaCount++;
    }
  }
  await PagoDeuda.bulkCreate(allPagosDeuda);
  console.log(`  ✅ ${pagoDeudaCount} pagos de deuda created`);

  // ── 11. CUENTAS CONTABLES ──────────────────────────────────────────
  console.log("📒 Creating Cuentas Contables...");
  const cuentasRecords = await CuentaContable.bulkCreate(
    CUENTAS_CONTABLES.map((c) => ({
      codigo: c.codigo,
      nombre: c.nombre,
      tipo: c.tipo,
      descripcion: c.desc,
      negocioId: negocio.id,
      userId: admin.id,
      activo: true,
    }))
  );
  const cuentaMap = {};
  cuentasRecords.forEach((c) => (cuentaMap[c.codigo] = c.id));
  console.log(`  ✅ ${cuentasRecords.length} cuentas contables created`);

  // ── 12. ASIENTOS CONTABLES ─────────────────────────────────────────
  console.log("📒 Creating Asientos Contables...");
  let asientoCount = 0;
  let detalleAsientoCount = 0;
  const allAsientos = [];
  const allDetalleAsientos = [];

  // Asiento de apertura
  allAsientos.push({
    fecha: new Date("2026-03-01T10:00:00"),
    descripcion: "Asiento de apertura - Capital inicial del negocio",
    tipo: "apertura",
    montoTotal: 600000,
    negocioId: negocio.id,
    userId: admin.id,
  });
  asientoCount++;

  // Monthly asientos
  const months = [
    { label: "Marzo 2026", start: "2026-03-01", end: "2026-03-31" },
    { label: "Abril 2026", start: "2026-04-01", end: "2026-04-30" },
    { label: "Mayo 2026", start: "2026-05-01", end: "2026-05-31" },
    { label: "Junio 2026", start: "2026-06-01", end: "2026-06-30" },
    { label: "Julio 2026", start: "2026-07-01", end: "2026-07-31" },
    { label: "Agosto 2026", start: "2026-08-01", end: "2026-08-31" },
  ];

  for (const month of months) {
    const totalVentasMes = rand(800000, 2000000);
    const totalCostoMes = Math.round(totalVentasMes * randFloat(0.5, 0.6));
    const fechaAsiento = new Date(`${month.start}T18:00:00`);

    // 12a. Asiento de ventas del mes
    allAsientos.push({
      fecha: fechaAsiento,
      descripcion: `Registro de ventas - ${month.label}`,
      tipo: "ingreso",
      montoTotal: totalVentasMes,
      negocioId: negocio.id,
      userId: admin.id,
    });
    allDetalleAsientos.push(
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["1.1.01"],
        debe: totalVentasMes * 0.85,
        haber: 0,
        descripcion: `Ingresos por ventas ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["1.1.03"],
        debe: totalVentasMes * 0.15,
        haber: 0,
        descripcion: `Ingresos MP ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["4.1.01"],
        debe: 0,
        haber: totalVentasMes,
        descripcion: `Ventas ${month.label}`,
        negocioId: negocio.id,
      }
    );
    asientoCount++;
    detalleAsientoCount += 3;

    // 12b. Asiento de costo de mercadería vendida
    allAsientos.push({
      fecha: fechaAsiento,
      descripcion: `Costo de mercadería vendida - ${month.label}`,
      tipo: "egreso",
      montoTotal: totalCostoMes,
      negocioId: negocio.id,
      userId: admin.id,
    });
    allDetalleAsientos.push(
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["5.1.01"],
        debe: totalCostoMes,
        haber: 0,
        descripcion: `CMV ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["1.2.01"],
        debe: 0,
        haber: totalCostoMes,
        descripcion: `Salida mercaderías ${month.label}`,
        negocioId: negocio.id,
      }
    );
    asientoCount++;
    detalleAsientoCount += 2;

    // 12c. Asiento de gastos fijos
    const gastos = {
      sueldos: 350000,
      alquiler: 180000,
      servicios: 45000,
      impuestos: 25000,
    };
    const totalGastos = gastos.sueldos + gastos.alquiler + gastos.servicios + gastos.impuestos;
    allAsientos.push({
      fecha: fechaAsiento,
      descripcion: `Gastos fijos del mes - ${month.label}`,
      tipo: "egreso",
      montoTotal: totalGastos,
      negocioId: negocio.id,
      userId: admin.id,
    });
    allDetalleAsientos.push(
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["5.2.01"],
        debe: gastos.sueldos,
        haber: 0,
        descripcion: `Sueldos ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["5.2.02"],
        debe: gastos.alquiler,
        haber: 0,
        descripcion: `Alquiler ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["5.2.03"],
        debe: gastos.servicios,
        haber: 0,
        descripcion: `Servicios ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["5.2.04"],
        debe: gastos.impuestos,
        haber: 0,
        descripcion: `Impuestos ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["1.1.01"],
        debe: 0,
        haber: totalGastos * 0.6,
        descripcion: `Egreso caja ${month.label}`,
        negocioId: negocio.id,
      },
      {
        asientoContableIdx: asientoCount,
        cuentaContableId: cuentaMap["1.1.02"],
        debe: 0,
        haber: totalGastos * 0.4,
        descripcion: `Egreso banco ${month.label}`,
        negocioId: negocio.id,
      }
    );
    asientoCount++;
    detalleAsientoCount += 6;
  }

  console.log(`  ⏳ Bulk creating ${asientoCount} asientos contables...`);
  const asientosCreated = await AsientoContable.bulkCreate(allAsientos);
  console.log(`  ⏳ Bulk creating ${detalleAsientoCount} detalles asiento...`);
  const detallesAsientoWithId = allDetalleAsientos.map((d) => ({
    cuentaContableId: d.cuentaContableId,
    debe: d.debe,
    haber: d.haber,
    descripcion: d.descripcion,
    asientoContableId: asientosCreated[d.asientoContableIdx].id,
    negocioId: d.negocioId,
  }));
  await DetalleAsiento.bulkCreate(detallesAsientoWithId);
  console.log(
    `  ✅ ${asientoCount} asientos, ${detalleAsientoCount} detalles created`
  );

  // ── 13. CUENTAS CORRIENTES DEUDAS (business debts) ─────────────────
  console.log("🏦 Creating Cuentas Corrientes Deudas...");
  const deudas = await CuentaCorrienteDeuda.bulkCreate([
    {
      nombre: "Préstamo MercadoPago - Línea de Crédito",
      tipo: "prestamo_mp",
      montoOriginal: 500000,
      saldoPendiente: 500000 - 48000 * 6,
      tasaInteres: 4.5,
      cuotasTotales: 12,
      cuotasPagadas: 6,
      montoCuota: 48000,
      fechaInicio: new Date("2026-01-15"),
      fechaVencimiento: new Date("2027-01-15"),
      estado: "activo",
      notas: "Préstamo aprobado vía MercadoPago. Cuota mensual fija.",
      negocioId: negocio.id,
      userId: admin.id,
    },
    {
      nombre: "Préstamo Bancario - Banco Nación",
      tipo: "prestamo_bancario",
      montoOriginal: 1200000,
      saldoPendiente: 1200000 - 65000 * 8,
      tasaInteres: 3.8,
      cuotasTotales: 24,
      cuotasPagadas: 8,
      montoCuota: 65000,
      fechaInicio: new Date("2025-06-01"),
      fechaVencimiento: new Date("2027-06-01"),
      estado: "activo",
      notas: "Préstamo para ampliación de local. Tasa fija.",
      negocioId: negocio.id,
      userId: admin.id,
    },
    {
      nombre: "Préstamo Personal - Pedro González",
      tipo: "prestamo_personal",
      montoOriginal: 200000,
      saldoPendiente: 200000 - 38000 * 3,
      tasaInteres: 5.0,
      cuotasTotales: 6,
      cuotasPagadas: 3,
      montoCuota: 38000,
      fechaInicio: new Date("2026-04-01"),
      fechaVencimiento: new Date("2026-10-01"),
      estado: "activo",
      contactoNombre: "Pedro González",
      contactoTelefono: "11-6666-7777",
      notas: "Préstamo entre particulares. Sin garantía.",
      negocioId: negocio.id,
      userId: admin.id,
    },
  ]);
  console.log(`  ✅ ${deudas.length} cuentas corrientes deudas created`);

  // ── 14. PAGOS DEUDA CONTABILIDAD ───────────────────────────────────
  console.log("💰 Creating Pagos Deuda Contabilidad...");
  let pagoDeudaContCount = 0;
  const allPagosDeudaCont = [];

  const debtConfigs = [
    { deuda: deudas[0], cuotasPagadas: 6, cuotaMonto: 48000, fechaInicio: "2026-01-15" },
    { deuda: deudas[1], cuotasPagadas: 8, cuotaMonto: 65000, fechaInicio: "2025-06-01" },
    { deuda: deudas[2], cuotasPagadas: 3, cuotaMonto: 38000, fechaInicio: "2026-04-01" },
  ];

  for (const cfg of debtConfigs) {
    for (let i = 1; i <= cfg.cuotasPagadas; i++) {
      const fechaPago = new Date(cfg.fechaInicio);
      fechaPago.setMonth(fechaPago.getMonth() + i);
      allPagosDeudaCont.push({
        cuentaCorrienteDeudaId: cfg.deuda.id,
        monto: cfg.cuotaMonto,
        fecha: fechaPago,
        metodoPago: i % 2 === 0 ? "transferencia" : "débito automático",
        numeroCuota: i,
        observaciones: `Cuota ${i}/${cfg.deuda.cuotasTotales} - Pago registrado`,
        negocioId: negocio.id,
        userId: admin.id,
      });
      pagoDeudaContCount++;
    }
  }
  await PagoDeudaContabilidad.bulkCreate(allPagosDeudaCont);
  console.log(`  ✅ ${pagoDeudaContCount} pagos deuda contabilidad created`);

  // ─── SUMMARY ─────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(50));
  console.log("📊 SEED SUMMARY");
  console.log("═".repeat(50));
  console.log(`  Negocio:          1`);
  console.log(`  Users:            2 (Admin + Cajero)`);
  console.log(`  Categorías:       ${catRecords.length}`);
  console.log(`  Productos:        ${products.length}`);
  console.log(`  Proveedores:      ${proveedores.length}`);
  console.log(`  Clientes Deudores:${deudores.length}`);
  console.log(`  Cajas:            ${cajasRecords.length}`);
  console.log(`  Ventas:           ${ventaCount}`);
  console.log(`  Venta Detalles:   ${detalleCount}`);
  console.log(`  Movimientos Caja: ${movimientoCount}`);
  console.log(`  Compras:          ${compraCount}`);
  console.log(`  Compra Detalles:  ${compraDetalleCount}`);
  console.log(`  Pagos Deuda:      ${pagoDeudaCount}`);
  console.log(`  Cuentas Contables:${cuentasRecords.length}`);
  console.log(`  Asientos:         ${asientoCount}`);
  console.log(`  Detalle Asientos: ${detalleAsientoCount}`);
  console.log(`  Ctas Ctes Deudas: ${deudas.length}`);
  console.log(`  Pago Deuda Contab:${pagoDeudaContCount}`);
  console.log("═".repeat(50));
  console.log("✅ Seed completed successfully!\n");
}

// ─── RUN ────────────────────────────────────────────────────────────────────

seed()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Seed failed:", err);
    await sequelize.close();
    process.exit(1);
  });
