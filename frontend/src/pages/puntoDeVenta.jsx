import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { productosAPI } from "../api/productos";
import { categoriasAPI } from "../api/categorias";
import { ventasAPI } from "../api/ventas";
import { deudoresAPI } from "../api/deudores";
import { useCaja } from "../context/CajaContext";
import { useAuth } from "../context/AuthContext";
import { connectSocket, disconnectSocket } from "../services/socket";
import { useSubmitGuard } from "../hooks/useSubmitGuard";
import CalculadoraPeso from "../components/common/CalculadoraPeso";

const METODOS_PAGO = [
  { value: "efectivo", label: "Efectivo" },
  { value: "tarjeta", label: "Tarjeta" },
  { value: "transferencia", label: "Transferencia" },
  { value: "credito", label: "Crédito" },
  { value: "mixto", label: "Mixto" },
];

function ModalCobro({ total, onConfirm, onClose, isSubmitting }) {
  const [metodoPago, setMetodoPago] = useState("efectivo");
  const [montoEntregado, setMontoEntregado] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [deudores, setDeudores] = useState([]);
  const [deudorSel, setDeudorSel] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const cambio = metodoPago === "efectivo" ? Math.max(0, parseFloat(montoEntregado || 0) - total) : 0;
  const montoValido = metodoPago !== "efectivo" || parseFloat(montoEntregado || 0) >= total;

  useEffect(() => {
    if (metodoPago !== "credito") { setDeudorSel(null); setBusqueda(""); setDeudores([]); return; }
    if (busqueda.length < 1) { setDeudores([]); return; }
    setBuscando(true);
    const timer = setTimeout(() => {
      deudoresAPI.listar({ search: busqueda, limit: 10 }).then((r) => setDeudores(r.data.data || [])).catch(() => {}).finally(() => setBuscando(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [busqueda, metodoPago]);

  const advertencia = deudorSel && deudorSel.limiteCredito
    ? (parseFloat(deudorSel.deudaPendiente || 0) + total) > parseFloat(deudorSel.limiteCredito)
    : false;

  const handleConfirm = () => {
    if (metodoPago === "credito") {
      if (!deudorSel) return;
      onConfirm({ metodoPago, clienteDeudorId: deudorSel.id, deudorNombre: deudorSel.nombre });
    } else {
      if (!montoValido) return;
      onConfirm({ metodoPago, montoEntregado: parseFloat(montoEntregado || total), cambio });
    }
  };

  return (
    <div className="modal-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div className="card" style={{width:"100%",maxWidth:"440px",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div className="card-header">
          <div>
            <h3 style={{margin:0,fontSize:"18px"}}>Procesar Pago</h3>
            <span className="tag" style={{marginTop:"4px",display:"inline-block"}}>Completá los datos de la venta</span>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
        </div>
        <div style={{padding:"0 22px 22px",overflowY:"auto",flex:1}}>
          <div style={{background:"#eff6ff",borderRadius:"12px",padding:"16px",textAlign:"center",marginBottom:"16px",border:"1px solid #dbeafe"}}>
            <p style={{fontSize:"13px",color:"#64748b",marginBottom:"4px"}}>Total a cobrar</p>
            <p style={{fontSize:"32px",fontWeight:700,color:"#1d4ed8"}}>${total.toFixed(2)}</p>
          </div>
          <div className="form-group">
            <label>Método de pago</label>
            <div style={{display:"flex",flexWrap:"wrap",gap:"6px"}}>
              {METODOS_PAGO.map((m) => (
                <button key={m.value} onClick={() => setMetodoPago(m.value)}
                  className={metodoPago === m.value ? "btn-primary" : "btn-secondary"} style={{flex:"1 0 calc(50% - 6px)",fontSize:"12px",padding:"6px 10px"}}>{m.label}</button>
              ))}
            </div>
          </div>
          {metodoPago === "efectivo" && (
            <div className="form-group">
              <label>Monto entregado ($)</label>
               <input ref={inputRef} type="number" min={total} step="0.01" value={montoEntregado} onChange={(e) => setMontoEntregado(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
                placeholder={`Mínimo $${total.toFixed(2)}`} className={!montoValido && montoEntregado ? "error" : ""} />
              {cambio > 0 && (
                <div style={{marginTop:"8px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:"8px",padding:"12px",textAlign:"center"}}>
                  <p style={{fontSize:"13px",color:"#64748b"}}>Cambio a entregar</p>
                  <p style={{fontSize:"24px",fontWeight:700,color:"#16a34a"}}>${cambio.toFixed(2)}</p>
                </div>
              )}
            </div>
          )}
          {metodoPago === "credito" && (
            <div style={{display:"flex",flexDirection:"column",gap:"12px"}}>
              <div className="form-group" style={{margin:0}}>
                <label>Cliente (cuenta corriente)</label>
                <div style={{position:"relative"}}>
                  <i className="fa-solid fa-search" style={{position:"absolute",left:"10px",top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:"14px"}}></i>
                  <input type="text" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscá por nombre o documento..." style={{paddingLeft:"30px"}} />
                  {buscando && <span style={{position:"absolute",right:"10px",top:"50%",transform:"translateY(-50%)",fontSize:"11px",color:"#94a3b8"}}>Buscando...</span>}
                </div>
              </div>
              {deudores.length > 0 && (
                <div style={{border:"1px solid #e2e8f0",borderRadius:"8px",maxHeight:"160px",overflowY:"auto"}}>
                  {deudores.map((d) => {
                    const seleccionado = deudorSel?.id === d.id;
                    return (
                      <button key={d.id} onClick={() => setDeudorSel(d)}
                        style={{width:"100%",textAlign:"left",padding:"10px 14px",border:"none",borderBottom:"1px solid #f1f5f9",background:seleccionado?"#eff6ff":"transparent",cursor:"pointer",display:"block"}}>
                        <p style={{fontWeight:600,fontSize:"14px",color:"#1e293b",margin:0}}>{d.nombre}</p>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:"12px",color:"#64748b"}}>
                          <span>{d.documento || "sin doc."}</span>
                          <span style={{color:parseFloat(d.deudaPendiente||0)>0?"#ef4444":"#16a34a",fontWeight:600}}>
                            Deuda: ${parseFloat(d.deudaPendiente||0).toFixed(2)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {deudorSel && (
                <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:"8px",padding:"12px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                    <div>
                      <p style={{fontWeight:600,color:"#1e293b",margin:0}}>{deudorSel.nombre}</p>
                      <p style={{fontSize:"12px",color:"#64748b",margin:"2px 0 0"}}>Documento: {deudorSel.documento || "-"}</p>
                    </div>
                    <button onClick={() => setDeudorSel(null)} style={{border:"none",background:"none",cursor:"pointer",color:"#94a3b8",padding:"4px"}}><i className="fa-solid fa-times"></i></button>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginTop:"8px",fontSize:"12px"}}>
                    <span>Deuda actual: <strong style={{color:"#dc2626"}}>${parseFloat(deudorSel.deudaPendiente||0).toFixed(2)}</strong></span>
                    <span>Límite: <strong>${parseFloat(deudorSel.limiteCredito||0).toFixed(2)}</strong></span>
                  </div>
                  {advertencia && (
                    <div style={{marginTop:"8px",background:"#fef9c3",border:"1px solid #fde047",borderRadius:"8px",padding:"8px 12px",fontSize:"12px",color:"#854d0e",fontWeight:500}}>
                      <i className="fa-solid fa-exclamation-triangle" style={{marginRight:"4px"}}></i>
                      Esta venta supera el límite de crédito del cliente. Deuda proyectada: ${(parseFloat(deudorSel.deudaPendiente||0)+total).toFixed(2)}
                    </div>
                  )}
                </div>
              )}
              <p style={{fontSize:"12px",color:"#94a3b8",margin:0}}>La venta se agregará a la cuenta corriente del cliente</p>
            </div>
          )}
          <div style={{display:"flex",gap:"12px",marginTop:"16px",paddingTop:"16px",borderTop:"1px solid #e2e8f0"}}>
            <button onClick={onClose} className="btn-secondary" style={{flex:1}} disabled={isSubmitting}>Cancelar</button>
            <button onClick={handleConfirm} disabled={metodoPago==="credito"?!deudorSel:!montoValido||isSubmitting}
              className="btn-success" style={{flex:1}}>
              <i className="fa-solid fa-check"></i> {isSubmitting ? "Procesando..." : "Confirmar Venta"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PuntoDeVenta() {
  const { cajaActiva, loadingCaja } = useCaja();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // React Query — productos cacheados (comparte caché con Productos)
  const { data: productosAll = [] } = useQuery({
    queryKey: ["productos", "all-for-pos"],
    queryFn: () => productosAPI.listar({ limit: 500 }).then((r) => r.data?.data || []),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  const productos = productosAll.filter((p) => p.activo !== false);

  // Categorías con React Query
  const { data: categorias = [] } = useQuery({
    queryKey: ["categorias"],
    queryFn: () => categoriasAPI.listar().then((r) => r.data?.data || []),
    staleTime: 10 * 60 * 1000,
  });

  const [ticket, setTicket] = useState([]);
  const [filtro, setFiltro] = useState("");
  const [categoriaActiva, setCategoriaActiva] = useState("Todas");
  const [modalCobro, setModalCobro] = useState(false);
  const [toast, setToast] = useState(null);
  const [procesando, setProcesando] = useState(false);
  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [calcProducto, setCalcProducto] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const searchRef = useRef(null);
  const agregarProductoRef = useRef(null);

  const { isSubmitting, withGuard } = useSubmitGuard();

  const showToast = useCallback((msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); }, []);
  useEffect(() => {
    const handler = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); searchRef.current?.focus(); } if (e.key === "Escape") setFiltro(""); };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);

  // Conexión socket.io para escaneo remoto
  useEffect(() => {
    if (!user?.negocioId) return;
    const socket = connectSocket(user.negocioId, "pos");
    setSocketConnected(socket.connected);

    socket.on("connect", () => setSocketConnected(true));
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("add-to-cart", ({ product }) => {
      if (agregarProductoRef.current) {
        agregarProductoRef.current(product);
      }
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("add-to-cart");
      disconnectSocket();
    };
  }, [user?.negocioId]);

  const getCategoriaNombre = (catId) => {
    const cat = categorias.find((c) => c.id === catId);
    return cat ? cat.nombre : catId;
  };

  const categoriasMenu = useMemo(() => {
    const catsSet = new Set();
    productos.forEach(p => { if (p.categoriaId) catsSet.add(p.categoriaId); });
    return ["Todas", ...Array.from(catsSet)];
  }, [productos]);

  const productosFiltrados = useMemo(() => productos.filter((p) => {
    const matchCat = categoriaActiva === "Todas" || categoriaActiva === p.categoriaId;
    const matchQ = `${p.nombre} ${p.codigo || ""}`.toLowerCase().includes(filtro.toLowerCase());
    return matchCat && matchQ;
  }), [productos, filtro, categoriaActiva]);

  const conStock = productosFiltrados.filter((p) => (p.stock ?? 0) > 0);
  const sinStock = productosFiltrados.filter((p) => (p.stock ?? 0) <= 0);
  const total = ticket.reduce((s, i) => s + parseFloat(i.precio) * i.qty, 0);

  const agregarProducto = (p) => {
    const stock = p.stock ?? 0;
    setTicket((prev) => {
      const ex = prev.find((i) => i.id === p.id);
      if (ex) { if (ex.qty >= stock) { showToast("Stock insuficiente", "warn"); return prev; } return prev.map((i) => i.id === p.id ? { ...i, qty: i.qty + 1 } : i); }
      return [...prev, { ...p, qty: 1, precio: parseFloat(p.precio) || 0 }];
    });
  };

  // Mantener ref sincronizada con agregarProducto (después de la definición)
  useEffect(() => { agregarProductoRef.current = agregarProducto; }, [agregarProducto]);

  const cambiarQty = (id, delta) => setTicket((prev) => prev.map((i) => { if (i.id !== id) return i; const newQty = i.qty + delta; if (newQty <= 0) return null; if (newQty > (i.stock ?? 0)) { showToast("Stock insuficiente", "warn"); return i; } return { ...i, qty: newQty }; }).filter(Boolean));
  const quitarItem = (id) => setTicket((prev) => prev.filter((i) => i.id !== id));

  const handleConfirmarVenta = async ({ metodoPago, cambio, clienteDeudorId }) => {
    if (!cajaActiva) { showToast("No hay caja abierta. Abrí una caja antes de vender.", "error"); setModalCobro(false); return; }
    await withGuard(async () => {
      setProcesando(true);
      try {
        const body = {
        items: ticket.map((i) => ({
          productoId: i.productoId || i.id,
          cantidad: i.qty,
          ...(i.peso ? { precioUnitario: i.precio, nombre: i.nombre } : {}),
        })),
        metodoPago,
      };
        if (clienteDeudorId) body.clienteDeudorId = clienteDeudorId;
        const res = await ventasAPI.crear(body);
        const advertencia = res.data?.data?.advertenciaLimite;
        setTicket([]); setModalCobro(false);
        const msg = metodoPago === "credito"
          ? "Venta registrada · Cargada a la cuenta del cliente"
          : cambio > 0 ? `Venta registrada · Cambio: $${cambio.toFixed(2)}` : "Venta registrada exitosamente";
        showToast(msg);
        if (advertencia) setTimeout(() => showToast(advertencia, "warn"), 500);
        queryClient.invalidateQueries({ queryKey: ["productos", "all-for-pos"] });
      } catch (err) { showToast(err.response?.data?.message || "Error al registrar la venta", "error"); }
      finally { setProcesando(false); }
    });
  };

  const handleCalcularPeso = ({ productoId, nombre, peso, precio }) => {
    const producto = productos.find((p) => p.id === productoId);
    if (!producto) return;
    const uid = `peso-${productoId}-${Date.now()}`;
    showToast(`⚖️ ${nombre} — $${precio.toFixed(2)}`);
    setTicket((prev) => [...prev, {
      id: uid,
      productoId,
      nombre,
      precio,
      precioUnitario: precio,
      qty: 1,
      stock: 9999,
      peso,
    }]);
    setCalcProducto(null);
  };

  if (loadingCaja) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh"}}><div className="spinner" style={{width:"32px",height:"32px",border:"3px solid #e2e8f0",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} /></div>;

  return (
    <div className="pos-container">
      {toast && <div style={{position:"fixed",top:"16px",left:"50%",transform:"translateX(-50%)",zIndex:100,padding:"12px 20px",borderRadius:"12px",boxShadow:"0 4px 12px rgba(0,0,0,0.15)",color:"#fff",fontSize:"14px",fontWeight:600,display:"flex",alignItems:"center",gap:"8px",background:toast.type==="error"?"#ef4444":toast.type==="warn"?"#f59e0b":"#22c55e"}}>{toast.msg}</div>}

      {modalCobro && <ModalCobro total={total} ticket={ticket} onConfirm={handleConfirmarVenta} onClose={() => setModalCobro(false)} isSubmitting={isSubmitting} />}

      {calcProducto && (
        <CalculadoraPeso
          producto={calcProducto}
          onConfirm={handleCalcularPeso}
          onClose={() => setCalcProducto(null)}
        />
      )}

      {scannerModalOpen && (
        <div className="modal-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}} onClick={() => setScannerModalOpen(false)}>
          <div className="card" style={{width:"100%",maxWidth:"400px"}} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <div>
                <h3 style={{margin:0,fontSize:"18px"}}>📱 Escanear desde celular</h3>
                <span className="tag" style={{marginTop:"4px",display:"inline-block"}}>Conectá el escáner remoto</span>
              </div>
              <button onClick={() => setScannerModalOpen(false)} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
            </div>
            <div style={{padding:"24px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:"16px"}}>
              <div style={{background:"#fff",padding:"16px",borderRadius:"12px",display:"inline-flex"}}>
                {user?.negocioId ? (
                  <QRCodeSVG value={`${window.location.origin}/scanner/${user.negocioId}`} size={180} />
                ) : (
                  <div style={{width:180,height:180,display:"flex",alignItems:"center",justifyContent:"center",color:"#94a3b8",fontSize:"14px"}}>Sin negocio asignado</div>
                )}
              </div>
              <div>
                <p style={{fontSize:"14px",fontWeight:600,color:"var(--kanagawa-fg)",margin:"0 0 4px"}}>Escané este QR con tu celular</p>
                <p style={{fontSize:"12px",color:"var(--kanagawa-comment)",margin:0}}>para conectar el escáner remoto al POS</p>
              </div>
              <div style={{background:"var(--kanagawa-bg)",border:"1px solid var(--kanagawa-border)",borderRadius:"8px",padding:"12px",fontSize:"12px",color:"var(--kanagawa-fg-muted)",textAlign:"left",width:"100%"}}>
                <p style={{margin:"0 0 6px",fontWeight:600}}>Instrucciones:</p>
                <ol style={{margin:0,paddingLeft:"16px",display:"flex",flexDirection:"column",gap:"4px"}}>
                  <li>Abrí la cámara de tu celular y escaneá el código QR</li>
                  <li>Iniciá sesión si es necesario</li>
                  <li>Escané los códigos de barras de los productos</li>
                  <li>Se agregarán automáticamente al carrito del POS</li>
                </ol>
              </div>
              <p style={{fontSize:"11px",color:"var(--kanawa-comment)",margin:0,wordBreak:"break-all"}}>
                URL directa: {window.location.origin}/scanner/{user?.negocioId || "?"}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="pos-left">
        <div className="pos-search-bar">
          <div style={{display:"flex",gap:"8px",alignItems:"center",marginBottom:"8px"}}>
            <div style={{position:"relative",flex:1}}>
              <i className="fa-solid fa-search" style={{position:"absolute",left:"10px",top:"50%",transform:"translateY(-50%)",color:"var(--kanagawa-comment)"}}></i>
              <input ref={searchRef} type="text" value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar producto... (Ctrl+F)" className="pos-search-input" />
              {filtro && <button onClick={() => setFiltro("")} style={{position:"absolute",right:"8px",top:"50%",transform:"translateY(-50%)",border:"none",background:"none",cursor:"pointer",color:"var(--kanagawa-comment)"}}><i className="fa-solid fa-times"></i></button>}
            </div>
            <button onClick={() => setScannerModalOpen(true)} className="btn-secondary" style={{whiteSpace:"nowrap",padding:"8px 12px",fontSize:"12px",display:"flex",alignItems:"center",gap:"6px"}} title="Escanear desde celular">
              <span style={{display:"inline-flex",alignItems:"center",gap:"4px"}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:socketConnected?"#22c55e":"#ef4444",display:"inline-block"}}></span>
                📱 Escanear
              </span>
            </button>
          </div>
          <div className="pos-categories">
            <button onClick={() => setCategoriaActiva("Todas")}
              className={`pos-cat-btn ${categoriaActiva==="Todas"?"active":""}`}>Todas</button>
            {categoriasMenu.slice(1).map((catId) => (
              <button key={catId} onClick={() => setCategoriaActiva(catId)}
                className={`pos-cat-btn ${categoriaActiva===catId?"active":""}`}>{getCategoriaNombre(catId)}</button>
            ))}
          </div>
        </div>

        <div className="pos-scroll">
          {conStock.length === 0 && sinStock.length === 0 ? (
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"300px",color:"var(--kanagawa-comment)",gap:"12px"}}>
              <i className="fa-solid fa-search" style={{fontSize:"32px"}}></i>
              <p style={{fontSize:"14px"}}>No se encontraron productos</p>
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:"24px"}}>
              {conStock.length > 0 && (
                <div className="pos-products">
                  {conStock.map((p) => {
                    const stock = p.stock ?? 0;
                    const stockBajo = stock <= 5;
                    const enTicket = ticket.find((i) => i.id === p.id);
                    const esPesable = p.unidadMedida && /^(kg|kilo|kilogramo|litro|l|lt|g|gramo|ml)$/i.test(p.unidadMedida.trim());
                    let cardClass = "pos-product-card";
                    if (enTicket) cardClass += " en-carrito";
                    else if (stockBajo) cardClass += " stock-bajo";
                    return (
                      <div key={p.id} className={cardClass} onClick={() => agregarProducto(p)}>
                        {enTicket && <span className="badge-cart-qty">{enTicket.qty}</span>}
                        <div className="icon-product">
                          {p.imagen ? <img src={p.imagen} alt={p.nombre} /> : <i className="fa-solid fa-cube"></i>}
                        </div>
                        <div className="name">{p.nombre}</div>
                        <div className="price">${parseFloat(p.precio||0).toFixed(2)}</div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:"4px"}}>
                          <div className="stock" style={{color:stockBajo?"var(--kanagawa-orange)":"var(--kanagawa-green)"}}>📦 {stock} {p.unidadMedida || "unidad"}</div>
                          {esPesable && (
                            <div
                              onClick={(e) => { e.stopPropagation(); setCalcProducto(p); }}
                              style={{cursor:"pointer",fontSize:"14px",color:"var(--kanagawa-blue)",padding:"2px 4px",borderRadius:"4px",lineHeight:1,background:"rgba(137,180,250,0.1)"}}
                              title="Calcular por peso"
                            >⚖️</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {sinStock.length > 0 && (
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"12px"}}>
                    <span style={{fontSize:"12px",fontWeight:600,color:"var(--kanagawa-fg-muted)",textTransform:"uppercase",letterSpacing:"0.5px"}}>Sin stock</span>
                    <div style={{flex:1,height:"1px",background:"var(--kanagawa-border)"}} />
                  </div>
                  <div className="pos-products">
                    {sinStock.map((p) => (
                      <div key={p.id} className="pos-product-card stock-cero">
                        <div className="icon-product">
                          {p.imagen ? <img src={p.imagen} alt={p.nombre} /> : <i className="fa-solid fa-cube"></i>}
                        </div>
                        <div className="name" style={{textDecoration:"line-through",color:"var(--kanagawa-fg-muted)"}}>{p.nombre}</div>
                        <div className="price" style={{color:"var(--kanagawa-comment)"}}>${parseFloat(p.precio||0).toFixed(2)}</div>
                        <div className="stock" style={{color:"var(--kanagawa-red)"}}>Sin stock</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="pos-cart">
        <div className="cart-header">
          <div>
            <h3 style={{fontSize:"16px",fontWeight:700,margin:0,color:"var(--kanagawa-fg)"}}>Ticket</h3>
            <p style={{fontSize:"12px",color:"var(--kanagawa-comment)",margin:"2px 0 0"}}>{ticket.length} artículo{ticket.length !== 1 ? "s" : ""}</p>
          </div>
          <span className="badge-cart">{ticket.length}</span>
        </div>

        <div className="cart-scroll">
          {ticket.length === 0 ? (
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"200px",color:"var(--kanagawa-comment)",gap:"8px"}}>
              <i className="fa-solid fa-cash-register" style={{fontSize:"36px"}}></i>
              <p style={{fontSize:"14px"}}>Seleccioná productos del catálogo</p>
            </div>
          ) : (
            ticket.map((item) => {
              const subtotal = parseFloat(item.precio) * item.qty;
              return (
                <div key={item.id} className="cart-item">
                  <div className="item-info">
                    <div className="details">
                      <p className="name">{item.nombre}</p>
                      {item.peso ? (
                        <p className="unit" style={{color:"var(--kanagawa-blue)"}}>
                          ⚖️ {item.peso >= 1000 ? `${(item.peso/1000).toFixed(2)} kg` : `${item.peso.toFixed(0)} g`}
                        </p>
                      ) : (
                        <p className="unit">${parseFloat(item.precio).toFixed(2)} x {item.unidadMedida || "unidad"}</p>
                      )}
                    </div>
                    {!item.peso && (
                      <div className="qty-control">
                        <button onClick={() => cambiarQty(item.id, -1)}><i className="fa-solid fa-minus" style={{fontSize:"10px"}}></i></button>
                        <input type="number" min={1} max={item.stock ?? 9999}
                          value={item.qty}
                          onChange={(e) => {
                            const v = parseInt(e.target.value) || 1;
                            const stock = item.stock ?? 9999;
                            if (v > stock) { showToast("Stock insuficiente", "warn"); return; }
                            setTicket((prev) => prev.map((i) => i.id === item.id ? { ...i, qty: Math.max(1, v) } : i));
                          }}
                          onBlur={(e) => { if (!e.target.value || parseInt(e.target.value) < 1) setTicket((prev) => prev.map((i) => i.id === item.id ? { ...i, qty: 1 } : i)); }}
                        />
                        <button onClick={() => cambiarQty(item.id, +1)}><i className="fa-solid fa-plus" style={{fontSize:"10px"}}></i></button>
                      </div>
                    )}
                  </div>
                  <span className="item-total">${subtotal.toFixed(2)}</span>
                  <button className="remove-btn" onClick={() => quitarItem(item.id)}><i className="fa-solid fa-times"></i></button>
                </div>
              );
            })
          )}
        </div>

        <div className="cart-footer">
          <div style={{display:"flex",justifyContent:"space-between",fontSize:"14px",color:"var(--kanagawa-fg-muted)",marginBottom:"4px"}}>
            <span>Subtotal</span>
            <span>${total.toFixed(2)}</span>
          </div>
          <div className="cart-total">
            <span>Total</span>
            <span className="amount">${total.toFixed(2)}</span>
          </div>
          <div className="cart-actions">
            {ticket.length > 0 && (
              <button onClick={() => setTicket([])} className="btn-secondary">
                <i className="fa-solid fa-trash"></i> Vaciar
              </button>
            )}
            <button onClick={() => ticket.length > 0 && setModalCobro(true)} disabled={ticket.length === 0 || procesando || isSubmitting}
              className="btn-success" style={{gridColumn:ticket.length===0?"1/-1":""}}>
              <i className="fa-solid fa-cash-register"></i> {procesando || isSubmitting ? "Procesando..." : `Cobrar $${total.toFixed(2)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
