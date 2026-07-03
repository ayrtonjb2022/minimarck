import { useState, useEffect } from "react";
import { cajasAPI } from "../api/cajas";
import { movimientosAPI } from "../api/movimientos";
import { useCaja } from "../context/CajaContext";
import { toast } from "react-toastify";

const fmt = (n) => `$${parseFloat(n ?? 0).toFixed(2)}`;
const LOCALE = import.meta.env.VITE_CURRENCY_LOCALE || "es-CL";
const fmtFecha = (f) => f ? new Date(f).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const fmtHora = (f) => f ? new Date(f).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }) : "—";
const calcSaldoActual = (c) => {
  if (c.estado === "cerrada" && c.saldoFinal != null) return parseFloat(c.saldoFinal);
  return parseFloat(c.saldoInicial ?? 0) + parseFloat(c.totalIngresos ?? 0) - parseFloat(c.totalEgresos ?? 0);
};

function BadgeEstado({ estado }) {
  return (
    <span className={`status ${estado === "abierta" ? "active-s" : "inactive-s"}`}>
      <span className="dot"></span>{estado === "abierta" ? "Abierta" : "Cerrada"}
    </span>
  );
}

function ModalMovimiento({ tipo, cajaId, onClose, onSubmit }) {
  const [concepto, setConcepto] = useState("");
  const [monto, setMonto] = useState("");
  const [guardando, setGuardando] = useState(false);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!concepto || concepto.length < 3) return;
    if (!monto || parseFloat(monto) <= 0) return;
    setGuardando(true);
    try {
      await movimientosAPI.crear({ tipo, concepto, monto: parseFloat(monto), cajaId });
      onSubmit();
    } catch (err) {
      toast.error(err.response?.data?.message || "Error al guardar movimiento");
    } finally { setGuardando(false); }
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div className="card" style={{width:"100%",maxWidth:"420px"}}>
        <div className="card-header">
          <h3 style={{margin:0,fontSize:"18px"}}>{tipo === "ingreso" ? "Registrar Ingreso" : "Registrar Egreso"}</h3>
          <button onClick={onClose} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
        </div>
        <form onSubmit={handleSave}>
          <div className="form-group">
            <label>Concepto *</label>
            <input type="text" value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej: Venta mostrador" required />
          </div>
          <div className="form-group">
            <label>Monto *</label>
            <input type="number" value={monto} onChange={(e) => setMonto(e.target.value)} step="0.01" min="0.01" placeholder="0.00" required />
          </div>
          <div style={{display:"flex",gap:"10px",marginTop:"16px",paddingTop:"16px",borderTop:"1px solid #e2e8f0"}}>
            <button type="button" className="btn-secondary" onClick={onClose} style={{flex:1}}>Cancelar</button>
            <button type="submit" className={tipo === "ingreso" ? "btn-primary" : "btn-danger"} style={{flex:1}} disabled={guardando}>
              {guardando ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModalDetalle({ caja, onClose, onCerrar }) {
  if (!caja) return null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div className="card" style={{width:"100%",maxWidth:"500px",maxHeight:"90vh",display:"flex",flexDirection:"column"}}>
        <div className="card-header">
          <div>
            <h3 style={{margin:0,fontSize:"18px"}}>Detalle de Caja #{caja.id}</h3>
            <p style={{fontSize:"13px",color:"#64748b",margin:"2px 0 0"}}>{fmtFecha(caja.fechaApertura)} · Apertura: {fmtHora(caja.fechaApertura)}</p>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
        </div>
        <div style={{padding:"0 22px 22px",overflowY:"auto",flex:1}}>
          <BadgeEstado estado={caja.estado} />
          <div className="stats-grid" style={{marginTop:"12px",marginBottom:0}}>
            <div className="stat-card"><div className="label">Saldo inicial <i className="fa-solid fa-coins"></i></div><div className="value" style={{fontSize:"22px"}}>{fmt(caja.saldoInicial)}</div></div>
            <div className="stat-card"><div className="label">Ingresos <i className="fa-solid fa-arrow-up"></i></div><div className="value" style={{fontSize:"22px",color:"#16a34a"}}>{fmt(caja.totalIngresos)}</div></div>
            <div className="stat-card"><div className="label">Egresos <i className="fa-solid fa-arrow-down"></i></div><div className="value" style={{fontSize:"22px",color:"#dc2626"}}>{fmt(caja.totalEgresos)}</div></div>
            <div className="stat-card"><div className="label">Saldo actual <i className="fa-solid fa-wallet"></i></div><div className="value" style={{fontSize:"22px",color:"#2563eb"}}>{fmt(calcSaldoActual(caja))}</div></div>
          </div>
          {caja.movimientos?.length > 0 && (
            <div style={{marginTop:"16px"}}>
              <h4 style={{fontSize:"14px",fontWeight:600,marginBottom:"8px"}}>Movimientos ({caja.movimientos.length})</h4>
              <div style={{maxHeight:"200px",overflowY:"auto",border:"1px solid #f1f5f9",borderRadius:"8px"}}>
                {caja.movimientos.map((m) => (
                  <div key={m.id} style={{display:"flex",justifyContent:"space-between",padding:"8px 12px",borderBottom:"1px solid #f1f5f9",fontSize:"14px"}}>
                    <span>{m.concepto}</span>
                    <span style={{fontWeight:700,color:m.tipo==="ingreso"?"#16a34a":"#dc2626"}}>{m.tipo==="ingreso"?"+":"-"}{fmt(m.monto)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:"10px",padding:"16px 22px",borderTop:"1px solid #e2e8f0"}}>
          <button onClick={onClose} className="btn-secondary" style={{flex:1}}>Cerrar</button>
          {caja.estado === "abierta" && (
            <button onClick={() => { onCerrar(caja.id); onClose(); }} className="btn-danger" style={{flex:1}}>Cerrar Caja</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Caja() {
  const { cajaActiva, cerrarCaja, verificarCaja } = useCaja();

  const [cajas, setCajas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detalle, setDetalle] = useState(null);
  const [modalMov, setModalMov] = useState(null);
  const [movimientosHoy, setMovimientosHoy] = useState([]);
  const [toast, setToast] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [saldoGeneral, setSaldoGeneral] = useState(null);

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const cargarMovimientosHoy = async () => {
    if (!cajaActiva) return;
    try {
      const res = await movimientosAPI.listarPorCaja(cajaActiva.id, { limit: 100 });
      setMovimientosHoy(res.data?.data || []);
    } catch {}
  };

  const cargar = async (p = 1) => {
    setLoading(true);
    try {
      const listRes = await cajasAPI.listar({ page: p, limit: 10 });
      const d = listRes.data;
      setCajas(d.data || []);
      setTotalPages(d.pagination?.totalPages || 1);
      setPage(p);
    } catch { showToast("Error al cargar las cajas", "error"); }
    finally { setLoading(false); }
  };

  const cargarSaldoGeneral = async () => {
    try { const r = await cajasAPI.saldoGeneral(); setSaldoGeneral(r.data?.data); } catch {}
  };

  useEffect(() => { verificarCaja(); cargar(); cargarSaldoGeneral(); }, []);
  useEffect(() => { if (cajaActiva) cargarMovimientosHoy(); cargarSaldoGeneral(); }, [cajaActiva]);

  const handleCerrar = async (id) => {
    if (!confirm("¿Estás seguro de cerrar la caja?")) return;
    const result = await cerrarCaja(id);
    if (result.success) {
      showToast("Caja cerrada correctamente");
      cargar();
      setMovimientosHoy([]);
    } else {
      showToast(result.error || "Error al cerrar la caja", "error");
    }
  };

  const verDetalle = async (caja) => {
    if (caja.movimientos) { setDetalle(caja); return; }
    try { const r = await cajasAPI.obtener(caja.id); setDetalle(r.data?.data); }
    catch { setDetalle(caja); }
  };

  const handleMovSubmit = () => {
    setModalMov(null);
    cargarMovimientosHoy();
    cargar();
  };

  return (
    <div>
      {toast && <div style={{position:"fixed",top:"16px",left:"50%",transform:"translateX(-50%)",zIndex:100,padding:"12px 20px",borderRadius:"12px",boxShadow:"0 4px 12px rgba(0,0,0,0.15)",color:"#fff",fontSize:"14px",fontWeight:600,background:toast.type==="error"?"#ef4444":"#22c55e"}}>{toast.msg}</div>}
      {detalle && <ModalDetalle caja={detalle} onClose={() => setDetalle(null)} onCerrar={handleCerrar} />}
      {modalMov && <ModalMovimiento tipo={modalMov} cajaId={cajaActiva?.id} onClose={() => setModalMov(null)} onSubmit={handleMovSubmit} />}

      {cajaActiva && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="label"><span>Estado Caja</span> <i className="fa-solid fa-cash-register"></i></div>
              <div className="value" style={{fontSize:"24px"}}><BadgeEstado estado={cajaActiva.estado} /></div>
            </div>
            <div className="stat-card">
              <div className="label"><span>Monto Inicial</span> <i className="fa-solid fa-coins"></i></div>
              <div className="value">{fmt(cajaActiva.saldoInicial)}</div>
            </div>
            <div className="stat-card">
              <div className="label"><span>Ventas del día</span> <i className="fa-solid fa-arrow-up"></i></div>
              <div className="value" style={{color:"#16a34a"}}>{fmt(cajaActiva.totalIngresos)}</div>
            </div>
            <div className="stat-card">
              <div className="label"><span>Monto Final</span> <i className="fa-solid fa-wallet"></i></div>
              <div className="value" style={{color:"#2563eb"}}>{fmt(calcSaldoActual(cajaActiva))}</div>
            </div>
          </div>
          {saldoGeneral && (
            <div className="stats-grid" style={{marginTop:8}}>
              <div className="stat-card" style={{background:"linear-gradient(135deg, #1e293b, #334155)", color:"#fff"}}>
                <div className="label" style={{color:"#94a3b8"}}><span>Saldo General</span> <i className="fa-solid fa-piggy-bank"></i></div>
                <div className="value" style={{fontSize:"22px"}}>{fmt(saldoGeneral.saldoGeneral)}</div>
                <div style={{display:"flex",gap:16,fontSize:11,color:"#94a3b8",marginTop:4}}>
                  <span>Cajas cerradas: {fmt(saldoGeneral.saldoCerradas)}</span>
                  <span>Caja actual: {fmt(saldoGeneral.saldoAbierta)}</span>
                </div>
              </div>
            </div>
          )}

          <div className="card" style={{marginBottom:"20px"}}>
            <div className="card-header">
              <h3 style={{margin:0}}>Acciones de Caja</h3>
              <span className="tag" style={{fontSize:"12px"}}>Caja #{cajaActiva.id}</span>
            </div>
            <div style={{display:"flex",gap:"10px",flexWrap:"wrap"}}>
              <button className="btn-primary" onClick={() => setModalMov("ingreso")}>
                <i className="fa-solid fa-plus"></i> Registrar Ingreso
              </button>
              <button className="btn-danger" onClick={() => setModalMov("egreso")}>
                <i className="fa-solid fa-minus"></i> Registrar Egreso
              </button>
              <button className="btn-success" onClick={() => handleCerrar(cajaActiva.id)}>
                <i className="fa-solid fa-check"></i> Cerrar Caja
              </button>
            </div>
          </div>

          <div className="table-container">
            <div className="table-header">
              <h3 style={{margin:0}}>Movimientos de hoy</h3>
              <span className="tag" style={{fontSize:"12px"}}>{movimientosHoy.length} registros</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Concepto</th>
                  <th>Monto</th>
                  <th>Hora</th>
                </tr>
              </thead>
              <tbody>
                {movimientosHoy.length === 0 ? (
                  <tr><td colSpan={4} style={{textAlign:"center",padding:"24px",color:"#94a3b8"}}>No hay movimientos registrados hoy</td></tr>
                ) : (
                  movimientosHoy.map((m) => (
                    <tr key={m.id}>
                      <td><span className={`status ${m.tipo === "ingreso" ? "paid" : "cancelled"}`}><span className="dot"></span>{m.tipo === "ingreso" ? "Ingreso" : "Egreso"}</span></td>
                      <td>{m.concepto}</td>
                      <td style={{fontWeight:600,color:m.tipo==="ingreso"?"#16a34a":"#dc2626"}}>{m.tipo === "ingreso" ? "+" : "-"}{fmt(m.monto)}</td>
                      <td>{fmtHora(m.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {cajaActiva && (
        <p style={{fontSize:"14px",color:"#64748b",marginBottom:"16px"}}>
          Abierta el {fmtFecha(cajaActiva.fechaApertura)} a las {fmtHora(cajaActiva.fechaApertura)}
        </p>
      )}

      <div className="table-container">
        <div className="table-header">
          <h3 style={{margin:0}}>Historial de Cajas</h3>
        </div>
        {loading ? (
          <div style={{display:"flex",justifyContent:"center",padding:"48px"}}>
            <div style={{width:"32px",height:"32px",border:"3px solid #e2e8f0",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} />
          </div>
        ) : cajas.length === 0 ? (
          <div style={{textAlign:"center",padding:"48px",color:"#94a3b8"}}>
            <p style={{fontSize:"16px",fontWeight:500}}>No hay cajas registradas</p>
          </div>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Fecha</th>
                  <th>Apertura</th>
                  <th>Cierre</th>
                  <th>S. Inicial</th>
                  <th>Ingresos</th>
                  <th>Egresos</th>
                  <th>S. Final</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cajas.map((c) => (
                  <tr key={c.id}>
                    <td style={{fontWeight:500,color:"#64748b"}}>#{c.id}</td>
                    <td>{fmtFecha(c.fechaApertura)}</td>
                    <td>{fmtHora(c.fechaApertura)}</td>
                    <td>{c.estado === "cerrada" ? fmtHora(c.fechaCierre) : "—"}</td>
                    <td style={{fontWeight:500}}>{fmt(c.saldoInicial)}</td>
                    <td style={{color:"#16a34a",fontWeight:500}}>{fmt(c.totalIngresos)}</td>
                    <td style={{color:"#dc2626",fontWeight:500}}>{fmt(c.totalEgresos)}</td>
                    <td style={{color:"#2563eb",fontWeight:700}}>{fmt(c.saldoFinal)}</td>
                    <td><BadgeEstado estado={c.estado} /></td>
                    <td><button onClick={() => verDetalle(c)} className="btn-primary" style={{padding:"4px 12px",fontSize:"12px"}}>Ver</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{display:"flex",justifyContent:"center",gap:"8px",padding:"16px",borderTop:"1px solid #e9edf2"}}>
                <button onClick={() => cargar(page - 1)} disabled={page === 1}
                  className="btn-secondary" style={{padding:"6px 14px",fontSize:"13px"}}><i className="fa-solid fa-chevron-left"></i></button>
                <span style={{padding:"6px 14px",fontSize:"13px",color:"#64748b"}}>{page} / {totalPages}</span>
                <button onClick={() => cargar(page + 1)} disabled={page === totalPages}
                  className="btn-secondary" style={{padding:"6px 14px",fontSize:"13px"}}><i className="fa-solid fa-chevron-right"></i></button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
