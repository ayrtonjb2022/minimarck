/**
 * The demo catalogue. ONE definition, two consumers.
 *
 * WHY A SHARED MODULE. The catalogue used to live only inside `scripts/db-demo.mjs`, which meant the
 * only way to get a product into a fresh install was to open a terminal on the developer's machine
 * and run an npm script. That is not a first-run experience for a shop: a real owner double-clicks
 * `MiniMarck Setup.exe`, and has no npm, no repo, and no reason to believe a terminal is involved.
 * With an empty catalogue the POS rendered "No se encontraron productos" and every product card,
 * every cash sale, the barcode scanner and the scale were all unreachable — the app looked broken
 * when in fact it was simply empty.
 *
 * So the catalogue is defined here, once, and imported by BOTH `scripts/db-demo.mjs` (the terminal
 * route, still useful for a developer) and the renderer's first-run button (the route the shop
 * actually has). Two copies of this list would drift, and the day they did, the button would load a
 * catalogue that the script no longer matched — which is the kind of bug that only shows up on
 * someone else's machine.
 *
 * WHY THE PRICES AND QUANTITIES ARE IN PESOS AND WHOLE UNITS. `productos.crear` parses pesos to
 * integer centavos and units to integer thousandths at the domain boundary; nothing above that line
 * is allowed to know about centavos. Keeping the raw values in the same shape the web API used
 * means this list is a fixture of INPUTS, not of storage.
 *
 * WHY ONE PRODUCT IS WEIGHED, DELIBERATELY. `Queso artesanal` is sold by the kilo. The scale is the
 * part of this app with the longest history of silent arithmetic bugs, and a demo catalogue with
 * nothing to weigh would let every one of them pass unnoticed. A weighed product in the demo is not
 * decoration; it is the cheapest regression test that a human will ever run.
 */
export const CATALOGO_DEMO = [
  { nombre: 'Queso artesanal', codigo: '7790123000015', precio: 2000, costo: 1200, stock: 12, unidad: 'kg' },
  { nombre: 'Pan de molde', codigo: '7790123000022', precio: 850, costo: 500, stock: 40, unidad: 'unidad' },
  { nombre: 'Leche entera 1 L', codigo: '7790123000039', precio: 1200, costo: 900, stock: 60, unidad: 'unidad' },
  { nombre: 'Gaseosa 500 ml', codigo: '7790123000046', precio: 900, costo: 650, stock: 144, unidad: 'unidad' },
  { nombre: 'Fideos 500 g', codigo: '7790123000053', precio: 750, costo: 480, stock: 80, unidad: 'unidad' },
  { nombre: 'Aceite 900 ml', codigo: '7790123000060', precio: 2400, costo: 1900, stock: 24, unidad: 'unidad' }
]

/**
 * Translate a demo entry into the argument shape `productos.crear` expects.
 *
 * Exported so the renderer and the CLI cannot drift on the FIELD NAMES either. `stockMinimo` is 1 kg
 * for the weighed product and 5 units for the rest: below that, the POS card turns orange, and the
 * demo should show that behaviour on exactly one product so it is recognizable when real stock
 * alerts arrive.
 */
export const demoToProductoInput = (p) => ({
  nombre: p.nombre,
  codigo: p.codigo,
  precio: p.precio,
  precioCompra: p.costo,
  stock: p.stock,
  unidadMedida: p.unidad,
  stockMinimo: p.unidad === 'kg' ? 1 : 5
})
