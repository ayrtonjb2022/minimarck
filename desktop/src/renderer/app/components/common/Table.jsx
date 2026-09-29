import React from "react";

const normalizePagination = (p) => {
  const page = p.page || p.currentPage || 1;
  const limit = p.limit || 20;
  const total = p.total || 0;
  const totalPages = p.totalPages || p.pageCount || 1;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return { currentPage: page, totalPages, total, from, to };
};

const Table = ({
  columns,
  data,
  loading,
  onRowClick,
  pagination,
  onPageChange,
  className = "",
}) => {
  if (loading) {
    return (
          <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
        <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: 32, color: "#7e9cd8" }}></i>
      </div>
    );
  }

  const p = pagination ? normalizePagination(pagination) : null;

  return (
    <div className={`table-container ${className}`}>
      <table>
        <thead>
            <tr style={{ borderBottom: "1px solid #363432" }}>
            {columns.map((col, index) => (
              <th key={index} style={{ padding: "10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#8992a7", width: col.width }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data?.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 32, textAlign: "center", color: "#6a6a6b" }}>
                No hay datos disponibles
              </td>
            </tr>
          ) : (
            data?.map((row, rowIndex) => (
              <tr key={row.id ?? rowIndex} onClick={() => onRowClick?.(row)}
                className="table-row" style={{ cursor: onRowClick ? "pointer" : "default" }}>
                {columns.map((col, colIndex) => (
                  <td key={colIndex} className="td">
                    {col.cell ? col.cell(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {p && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid #363432" }}>
          <div style={{ fontSize: 13, color: "#8992a7" }}>
            Mostrando {p.from} - {p.to} de {p.total}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => onPageChange?.(p.currentPage - 1)}
              disabled={p.currentPage === 1}
              className="btn-secondary" style={{ padding: "6px 10px", fontSize: 13 }}>
              <i className="fa-solid fa-chevron-left"></i>
            </button>
            <span style={{ fontSize: 13, color: "#8992a7" }}>{p.currentPage} / {p.totalPages}</span>
            <button
              onClick={() => onPageChange?.(p.currentPage + 1)}
              disabled={p.currentPage === p.totalPages}
              className="btn-secondary" style={{ padding: "6px 10px", fontSize: 13 }}>
              <i className="fa-solid fa-chevron-right"></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Table;
