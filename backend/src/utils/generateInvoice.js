const PDFDocument = require("pdfkit");

const generateInvoicePDF = (venta, detalles, user) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      let buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // Header
      doc.fontSize(20).text("MINIMARCK", { align: "center" });
      doc.fontSize(12).text("Factura de Venta", { align: "center" });
      doc.moveDown();

      // Info
      doc.fontSize(10);
      doc.text(`Folio: ${venta.folio}`);
      doc.text(`Fecha: ${new Date(venta.createdAt).toLocaleDateString()}`);
      doc.text(`Vendedor: ${user.nombre}`);
      doc.text(`Método de Pago: ${venta.metodoPago}`);
      doc.moveDown();

      // Table header
      doc.fontSize(10).text("Producto", 50, doc.y);
      doc.text("Cantidad", 300, doc.y);
      doc.text("Precio", 400, doc.y);
      doc.text("Subtotal", 480, doc.y);
      doc.moveDown();

      // Table rows
      detalles.forEach((detalle) => {
        const y = doc.y;
        doc.text(detalle.Producto.nombre, 50, y);
        doc.text(detalle.cantidad.toString(), 300, y);
        doc.text(`$${detalle.precioUnitario}`, 400, y);
        doc.text(`$${detalle.subtotal}`, 480, y);
        doc.moveDown();
      });

      doc.moveDown();
      doc.text(`Subtotal: $${venta.subtotal}`, { align: "right" });
      doc.text(`Descuento: $${venta.descuento}`, { align: "right" });
      doc.text(`Total: $${venta.total}`, { align: "right" });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

module.exports = { generateInvoicePDF };
