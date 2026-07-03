import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const exportExcel = (data, columns, filename) => {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Reporte");
  const colWidths = columns.map((c) => ({ wch: Math.max((c.header || "").length * 2, 15) }));
  ws["!cols"] = colWidths;
  XLSX.writeFile(wb, `${filename}.xlsx`);
};

export const exportPDF = (title, columns, rows, filename, negocio) => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  // Encabezado: empresa izq, MiniMarck der
  doc.setFontSize(18);
  doc.setFont(undefined, "bold");
  doc.text(negocio?.nombre || "Mi Negocio", margin, 20);

  doc.setFontSize(8);
  doc.setFont(undefined, "normal");
  doc.setTextColor(100, 116, 139);
  if (negocio?.ruc) doc.text(`RUC: ${negocio.ruc}`, margin, 27);
  if (negocio?.telefono) doc.text(`Tel: ${negocio.telefono}`, margin, negocio?.ruc ? 33 : 27);

  // MiniMarck branding a la derecha
  doc.setFontSize(16);
  doc.setFont(undefined, "bold");
  doc.setTextColor(59, 130, 246);
  doc.text("MiniMarck", pageWidth - margin, 20, { align: "right" });

  doc.setFontSize(7);
  doc.setFont(undefined, "normal");
  doc.setTextColor(148, 163, 184);
  doc.text("minimarck.app", pageWidth - margin, 26, { align: "right" });

  // Línea divisoria
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(margin, 38, pageWidth - margin, 38);

  // Título del reporte
  doc.setFontSize(13);
  doc.setFont(undefined, "bold");
  doc.setTextColor(15, 23, 42);
  doc.text(title, margin, 47);

  // Subtítulo con período
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  doc.setTextColor(100, 116, 139);
  doc.text(`Período: ${filename.split("-").slice(1).join(" - ")}`, margin, 54);
  const locale = import.meta.env.VITE_CURRENCY_LOCALE || "es-CL";
  doc.text(`Generado: ${new Date().toLocaleDateString(locale, { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`, pageWidth - margin, 54, { align: "right" });

  // Tabla
  const head = [columns.map((c) => c.header)];
  const body = rows.map((r) => columns.map((c) => c.cell ? c.cell(r) : r[c.key] ?? "-"));
  autoTable(doc, {
    head,
    body,
    startY: 60,
    theme: "grid",
    headStyles: { fillColor: [59, 130, 246], textColor: [255, 255, 255], fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    styles: { cellPadding: 4 },
    margin: { bottom: 24 },
    didDrawPage: (data) => {
      // Footer con número de página
      const pageCount = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(`Pág. ${data.pageNumber} de ${pageCount}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 10, { align: "right" });
      doc.text(`Generado por MiniMarck`, margin, doc.internal.pageSize.getHeight() - 10);
    },
  });

  doc.save(`${filename}.pdf`);
};
