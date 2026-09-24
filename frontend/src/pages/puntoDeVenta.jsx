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
import { formatCurrency } from "../utils/formatters";

const METODOS_PAGO = [
  { value: "efectivo", label: "Efectivo" },
  { value: "tarjeta", label: "Tarjeta" },
  { value: "transferencia", label: "Transferencia" },
  { value: "credito", label: "Crédito" },
  // "mixto" se mantiene en el ENUM del modelo (compatibilidad), pero el UI no
  // debe ofrecerlo: no hay desglose efectivo/crédito y el backend lo rechaza.
];

const MARGENES_VENTA_LIBRE = [30, 35, 40];

// Familias de unidades para fraccionar un producto pesable
const FAMILIAS_UNIDAD_FRACCION = [
  { base: /^(l|lt|litro|litros)$/i, opciones: ["ml", "L"] },
  { base: /^(kg|kilo|kilos|kilogramo)$/i, opciones: ["g", "kg"] },
  { base: /^(g|gramo)$/i, opciones: ["g", "kg"] },
  { base: /^ml$/i, opciones: ["ml", "L"] },
];

// Escala a la unidad mínima (ml o g): L/kg → 1000, ml/g → 1
const escalaUnidad = (u) => (/^(l|lt|litro|litros|kg|kilo|kilos|kilogramo)$/i.test(u.trim()) ? 1000 : 1);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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
              {deudorSel && (
                <div>
                  <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:"8px",padding:"12px 14px"}}>
                    <p style={{margin:0,fontSize:"13px",color:"#1e293b",fontWeight:600}}>Cliente: {deudorSel.nombre}</p>
                    <p style={{margin:"4px 0 0",fontSize:"12px",color:"#64748b"}}>Deuda actual: <strong style={{color:"#dc2626"}}>${parseFloat(deudorSel.deudaPendiente||0).toFixed(2)}</strong></p>
                    <p style={{margin:"2px 0 0",fontSize:"12px",color:"#1e293b"}}>Nueva deuda: <strong>${(parseFloat(deudorSel.deudaPendiente||0)+total).toFixed(2)}</strong></p>
                  </div>
                  {parseFloat(deudorSel.deudaPendiente||0) > 0 && (
                    <div style={{marginTop:"6px",background:"#fef9c3",border:"1px solid #fde047",borderRadius:"8px",padding:"8px 12px",fontSize:"12px",color:"#854d0e",fontWeight:500}}>
                      <i className="fa-solid fa-exclamation-triangle" style={{marginRight:"4px"}}></i>
                      Tiene deuda pendiente
                    </div>
                  )}
                </div>
              )}
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

function ModalVentaLibre({ onConfirm, onClose }) {
  const [nombre, setNombre] = useState("");
  const [precio, setPrecio] = useState("");
  const [margen, setMargen] = useState(30);
  const inputRef = useRef(null);
  const idCounterRef = useRef(0); // evita colisiones de id en el mismo milisegundo
  useEffect(() => { inputRef.current?.focus(); }, []);

  const precioNum = parseFloat(precio);
  const precioValido = precioNum > 0;
  const costo = precioValido ? precioNum / (1 + margen / 100) : 0;
  const ganancia = precioValido ? precioNum - costo : 0;
  const valido = nombre.trim().length > 0 && precioValido;

  const handleConfirm = () => {
    if (!valido) return;
    onConfirm({
      id: `libre-${Date.now()}-${++idCounterRef.current}`,
      nombre: nombre.trim(),
      precio: precioNum,
      costoUnitario: round2(costo),
      qty: 1,
      stock: 9999,
      esVentaLibre: true,
    });
  };

  return (
    <div className="modal-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div className="card" style={{width:"100%",maxWidth:"420px",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div className="card-header">
          <div>
            <h3 style={{margin:0,fontSize:"18px"}}>⚡ Venta libre</h3>
            <span className="tag" style={{marginTop:"4px",display:"inline-block"}}>Vendé algo que no está en el inventario</span>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
        </div>
        <div style={{padding:"0 22px 22px",overflowY:"auto",flex:1}}>
          <div className="form-group">
            <label>Nombre</label>
            <input ref={inputRef} type="text" value={nombre} onChange={(e) => setNombre(e.target.value)}
              placeholder="Ej: Queso medio kilo" onKeyDown={(e) => e.key === "Enter" && handleConfirm()} />
          </div>
          <div className="form-group">
            <label>Precio de venta ($)</label>
            <input type="number" min="0.01" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)}
              placeholder="Ej: 3500" onKeyDown={(e) => e.key === "Enter" && handleConfirm()} />
          </div>
          <div className="form-group">
            <label>Margen</label>
            <div style={{display:"flex",gap:"6px"}}>
              {MARGENES_VENTA_LIBRE.map((m) => (
                <button key={m} onClick={() => setMargen(m)}
                  className={margen === m ? "btn-primary" : "btn-secondary"} style={{flex:1,fontSize:"12px",padding:"6px 10px"}}>{m}%</button>
              ))}
            </div>
          </div>
          {precioValido && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"16px"}}>
              <div style={{background:"#eff6ff",border:"1px solid #dbeafe",borderRadius:"8px",padding:"10px 12px",textAlign:"center"}}>
                <p style={{fontSize:"12px",color:"#64748b",margin:"0 0 2px"}}>Costo estimado</p>
                <p style={{fontSize:"16px",fontWeight:700,color:"#1d4ed8",margin:0}}>${costo.toFixed(2)}</p>
              </div>
              <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:"8px",padding:"10px 12px",textAlign:"center"}}>
                <p style={{fontSize:"12px",color:"#64748b",margin:"0 0 2px"}}>Ganancia estimada</p>
                <p style={{fontSize:"16px",fontWeight:700,color:"#16a34a",margin:0}}>${ganancia.toFixed(2)}</p>
              </div>
            </div>
          )}
          <div style={{display:"flex",gap:"12px",marginTop:"16px",paddingTop:"16px",borderTop:"1px solid #e2e8f0"}}>
            <button onClick={onClose} className="btn-secondary" style={{flex:1}}>Cancelar</button>
            <button onClick={handleConfirm} disabled={!valido} className="btn-success" style={{flex:1}}>
              <i className="fa-solid fa-check"></i> Agregar al ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalFraccionar({ producto, onConfirm, onClose }) {
  const [valor, setValor] = useState("");
  const [creando, setCreando] = useState(false);
  const unidadBase = (producto.unidadMedida || "").trim().toLowerCase();
  // Guarda defensiva: solo unidades de masa/volumen escaladas x1000 (kg/L).
  // Con escala 1 (g/ml) la fracción del producto base sale mal y el costo
  // quedaría ×1000 inflado; el botón ✂️ ya no se muestra, pero si el modal se
  // abre igual, se bloquea con un mensaje claro.
  const bloqueado = escalaUnidad(unidadBase) !== 1000;
  const familia = FAMILIAS_UNIDAD_FRACCION.find((f) => f.base.test(producto.unidadMedida || ""));
  const opciones = familia ? familia.opciones : ["unidad"];
  const [unidad, setUnidad] = useState(opciones[0]);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const valorNum = parseFloat(valor);
  const fractionOfBase = !isNaN(valorNum) && valorNum > 0 ? (valorNum * escalaUnidad(unidad)) / (1 * escalaUnidad(unidadBase)) : 0;
  // La fracción debe ser mayor a 0 y no superar la unidad base del producto
  const valido = !bloqueado && fractionOfBase > 0 && fractionOfBase <= 1;
  const precioBase = parseFloat(producto.precio || 0);
  const costoBase = parseFloat(producto.precioCompra || 0);
  const costoCrea = round2(costoBase * fractionOfBase);
  const precioNuevo = round2(precioBase * fractionOfBase);
  const margenBase = costoBase > 0 ? ((precioBase - costoBase) / costoBase) * 100 : 0;

  const handleCrear = async () => {
    if (bloqueado || !valido || creando) return;
    setCreando(true);
    try {
      await onConfirm({
        nombre: `${producto.nombre} ${valorNum}${unidad}`,
        precio: precioNuevo,
        precioCompra: costoCrea,
        stock: 10,
        stockMinimo: 5,
        categoriaId: producto.categoriaId,
        // Se envía en minúsculas para respetar el ENUM de unidad_medida en la base
        unidadMedida: unidad.toLowerCase(),
      });
    } finally {
      setCreando(false);
    }
  };

  return (
    <div className="modal-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div className="card" style={{width:"100%",maxWidth:"420px",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div className="card-header">
          <div>
            <h3 style={{margin:0,fontSize:"18px"}}>✂️ Fraccionar producto</h3>
            <span className="tag" style={{marginTop:"4px",display:"inline-block"}}>Creá un nuevo producto desde una fracción</span>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
        </div>
        <div style={{padding:"0 22px 22px",overflowY:"auto",flex:1}}>
          <div style={{background:"#eff6ff",borderRadius:"12px",padding:"14px 16px",marginBottom:"16px",border:"1px solid #dbeafe"}}>
            <p style={{fontSize:"14px",fontWeight:700,color:"#1e293b",margin:0}}>{producto.nombre}</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px",marginTop:"8px",fontSize:"12px",color:"#475569"}}>
              <span>Unidad base: <strong>{producto.unidadMedida || "unidad"}</strong></span>
              <span>Precio: <strong>${precioBase.toFixed(2)}</strong></span>
              <span>Costo: <strong>${costoBase.toFixed(2)}</strong></span>
              <span>Margen: <strong>{margenBase.toFixed(1)}%</strong></span>
            </div>
          </div>
          {bloqueado && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "10px 12px", fontSize: "12px", color: "#dc2626", fontWeight: 500, marginBottom: "12px" }}>
              <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: "4px" }}></i>
              El fraccionado solo está disponible para productos cuya base es kg o litros (masa/volumen ×1000); las unidades tipo g/ml no se pueden fraccionar
            </div>
          )}
          <div className="form-group">
            <label>Valor de la fracción</label>
            <input ref={inputRef} type="number" min="0" step="0.01" value={valor} onChange={(e) => setValor(e.target.value)}
              placeholder={`Ej: 100 (${opciones[0] === "unidad" ? "unidad" : `en ${opciones[0]}`})`} />
          </div>
          <div className="form-group">
            <label>Unidad de la fracción</label>
            <select value={unidad} onChange={(e) => setUnidad(e.target.value)}>
              {opciones.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          {valor !== "" && !valido && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "10px 12px", fontSize: "12px", color: "#dc2626", fontWeight: 500, marginBottom: "12px" }}>
              <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: "4px" }}></i>
              La fracción debe ser mayor a 0 y no superar la unidad base del producto
            </div>
          )}
          {valido && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"16px"}}>
              <div style={{background:"#eff6ff",border:"1px solid #dbeafe",borderRadius:"8px",padding:"10px 12px",textAlign:"center"}}>
                <p style={{fontSize:"12px",color:"#64748b",margin:"0 0 2px"}}>Precio nuevo</p>
                <p style={{fontSize:"16px",fontWeight:700,color:"#1d4ed8",margin:0}}>${precioNuevo.toFixed(2)}</p>
              </div>
              <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:"8px",padding:"10px 12px",textAlign:"center"}}>
                <p style={{fontSize:"12px",color:"#64748b",margin:"0 0 2px"}}>Costo estimado</p>
                <p style={{fontSize:"16px",fontWeight:700,color:"#dc2626",margin:0}}>${costoCrea.toFixed(2)}</p>
              </div>
              <p style={{fontSize:"12px",color:"#64748b",margin:0,gridColumn:"1/-1",textAlign:"center"}}>
                Fracción: {fractionOfBase.toFixed(4)} del producto base · Margen base: {margenBase.toFixed(1)}%
              </p>
            </div>
          )}
          <div style={{display:"flex",gap:"12px",marginTop:"16px",paddingTop:"16px",borderTop:"1px solid #e2e8f0"}}>
            <button onClick={onClose} className="btn-secondary" style={{flex:1}} disabled={creando}>Cancelar</button>
            <button onClick={handleCrear} disabled={!valido || creando} className="btn-primary" style={{flex:1}}>
              {creando ? "Creando..." : "Crear producto"}
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
  const [modalVentaLibre, setModalVentaLibre] = useState(false);
  const [modalFraccionar, setModalFraccionar] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const searchRef = useRef(null);
  const agregarProductoRef = useRef(null);
  // Última venta enviada: { key, items }. Sobrevive a un error de red ambiguo
  // para que el reintento deduplique en el servidor (ver ticketKey más abajo).
  const ultimoEnvioRef = useRef(null);

  const { isSubmitting, withGuard } = useSubmitGuard();
  const [posTheme, setPosTheme] = useState(() => localStorage.getItem("pos-theme") || "light");
  const toggleTheme = useCallback(() => {
    setPosTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem("pos-theme", next);
      return next;
    });
  }, []);

  const showToast = useCallback((msg, type = "success", duration = 3500) => { setToast({ msg, type }); setTimeout(() => setToast(null), duration); }, []);
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

  // Vaciar el ticket también libera la key congelada: la próxima venta arranca
  // con una key nueva. Es el único camino (junto al éxito de una venta) que
  // regenera la clave de idempotencia.
  const vaciarTicket = () => {
    ultimoEnvioRef.current = null;
    setTicket([]);
  };

  // Una clave de idempotencia por venta enviada. Mientras la ÚLTIMA venta no se
  // confirme (éxito/clear), se reusa SIEMPRE la misma key — incluso si editan el
  // ticket tras un fallo de red: si la venta ya se registró en el servidor pero
  // la respuesta se perdió, una key nueva + ticket editado crearía una venta
  // duplicada. El backend deduplica por (negocio_id, idempotency_key).
  const ticketKey = useMemo(() => {
    if (ultimoEnvioRef.current) {
      return ultimoEnvioRef.current.key;
    }
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `tk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }, [ticket]);

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

  const handleConfirmarVenta = async ({ metodoPago, cambio, clienteDeudorId, deudorNombre }) => {
    if (!cajaActiva) { showToast("No hay caja abierta. Abrí una caja antes de vender.", "error"); setModalCobro(false); return; }
    await withGuard(async () => {
      setProcesando(true);
      try {
        // Fingerprint estable del ticket: solo los campos que el servidor
        // persiste (excluye el `id` volátil de las líneas peso/venta libre).
        const fingerprint = (items) =>
          JSON.stringify(
            items.map((i) => ({
              productoId: i.productoId || (i.esVentaLibre ? null : i.id) || null,
              cantidad: i.qty,
              precioUnitario: i.precioUnitario ?? i.precio ?? null,
              costoUnitario: i.costoUnitario ?? null,
              esVentaLibre: !!i.esVentaLibre,
              nombre: i.nombre ?? null,
            })),
          );
        // Si tras un fallo de red el cajero EDITÓ el ticket, el reintento NO
        // puede reusar la key congelada: el servidor deduplicaría contra la
        // venta ORIGINAL y los items editados nunca se venderían. Se rota a
        // una key nueva y el ticket editado se registra como venta nueva.
        let key = ticketKey;
        if (
          ultimoEnvioRef.current &&
          fingerprint(ticket) !== fingerprint(ultimoEnvioRef.current.items)
        ) {
          ultimoEnvioRef.current = null;
          key =
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `tk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
        const body = {
        items: ticket.map((i) => (
          i.esVentaLibre
            ? { nombre: i.nombre, cantidad: i.qty, precioUnitario: i.precio, costoUnitario: i.costoUnitario }
            : { productoId: i.productoId || i.id, cantidad: i.qty, ...(i.peso ? { precioUnitario: i.precio, nombre: i.nombre, costoUnitario: i.costoUnitario } : {}) }
        )),
        metodoPago,
        idempotencyKey: key,
      };
        if (clienteDeudorId) body.clienteDeudorId = clienteDeudorId;
        // Congelar key + snapshot del ticket al ENVIAR: si la respuesta se
        // pierde, el reintento reusa esta MISMA key → el servidor deduplica.
        ultimoEnvioRef.current = { key, items: ticket };
        const res = await ventasAPI.crear(body);
        const advertencia = res.data?.data?.advertenciaLimite;
        const duplicado = res.data?.data?.duplicado === true;
        const ventaId = res.data?.data?.id || res.data?.data?.venta?.id;
        // En el caso duplicado el servidor devuelve { venta, duplicado: true }
        // con el folio y el total REALMENTE registrados: mostrarlos en el toast
        // en vez del ticket actual (que tras un reintento puede no coincidir).
        const ventaDuplicada = duplicado ? res.data?.data?.venta : null;
        const totalMostrado = ventaDuplicada
          ? parseFloat(ventaDuplicada.total ?? total)
          : total;
        const idMostradoVenta = ventaDuplicada?.folio || ventaId;
        vaciarTicket(); setModalCobro(false);
        const methodLabel = metodoPago === "efectivo" ? "Efectivo" : metodoPago === "tarjeta" ? "Tarjeta" : metodoPago === "transferencia" ? "Transferencia" : "Fiado";
        const cabecera = duplicado ? `🔁 Venta #${idMostradoVenta} ya registrada` : `✅ Venta #${ventaId} registrada`;
        let saleMsg;
        if (metodoPago === "credito") {
          saleMsg = `${cabecera}\nFiado a: ${deudorNombre || "cliente"}\nTotal: ${formatCurrency(totalMostrado)}`;
        } else if (cambio > 0) {
          saleMsg = `${cabecera}\n${methodLabel}: ${formatCurrency(totalMostrado)}\nCambio: ${formatCurrency(cambio)}`;
        } else {
          saleMsg = `${cabecera}\n${methodLabel}: ${formatCurrency(totalMostrado)}`;
        }
        showToast(saleMsg, "success", 5000);
        if (advertencia) setTimeout(() => showToast(advertencia, "warn"), 500);
        queryClient.invalidateQueries({ queryKey: ["productos", "all-for-pos"] });
      } catch (err) { showToast(err.response?.data?.message || "Error al registrar la venta", "error"); }
      finally { setProcesando(false); }
    });
  };

  const handleCalcularPeso = ({ productoId, nombre, peso, precio }) => {
    const producto = productos.find((p) => p.id === productoId);
    if (!producto) return;
    const unidadBase = (producto.unidadMedida || "").trim().toLowerCase();
    // Guarda defensiva (el botón ⚖️ solo se muestra para kg/L, pero si llega
    // una unidad g/ml bloquear: el costo prorrateado saldría ×1000 inflado).
    if (escalaUnidad(unidadBase) !== 1000) {
      showToast("Este producto no admite cálculo por peso (solo unidades kg/L)", "warn");
      setCalcProducto(null);
      return;
    }
    const uid = `peso-${productoId}-${Date.now()}`;
    // Costo PRORRATEADO por la fracción vendida: peso viene en gramos y la
    // escala de la unidad base (kg/L → 1000, g/ml → 1) da la fracción de la
    // unidad base. stock es INT, así que cantidad queda en 1 (una unidad) y
    // solo se corrige el costo, no el decremento.
    const fraction = peso / escalaUnidad(unidadBase);
    const costoUnitario = round2(parseFloat(producto.precioCompra || 0) * fraction);
    showToast(`⚖️ ${nombre} — $${precio.toFixed(2)}`);
    setTicket((prev) => [...prev, {
      id: uid,
      productoId,
      nombre,
      precio,
      precioUnitario: precio,
      costoUnitario,
      qty: 1,
      stock: 9999,
      peso,
    }]);
    setCalcProducto(null);
  };

  const handleAgregarVentaLibre = (item) => {
    setTicket((prev) => [...prev, item]);
    setModalVentaLibre(false);
    showToast(`⚡ ${item.nombre} — $${item.precio.toFixed(2)}`);
  };

  const handleCrearFraccion = async (data) => {
    try {
      const res = await productosAPI.crear(data);
      const nuevo = res.data?.data;
      if (!nuevo) throw new Error("Respuesta inválida del servidor");
      agregarProducto(nuevo);
      setModalFraccionar(null);
      showToast(`✅ Producto creado: ${nuevo.nombre}`, "success", 4000);
      queryClient.invalidateQueries({ queryKey: ["productos", "all-for-pos"] });
    } catch (err) {
      showToast(err.response?.data?.message || "Error al crear el producto", "error");
    }
  };

  if (loadingCaja) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh"}}><div className="spinner" style={{width:"32px",height:"32px",border:"3px solid #e2e8f0",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} /></div>;

  return (
    <div className={`pos-container pos-theme-${posTheme}`}>
      {toast && <div style={{position:"fixed",top:"16px",left:"50%",transform:"translateX(-50%)",zIndex:100,padding:"12px 20px",borderRadius:"12px",boxShadow:"0 4px 12px rgba(0,0,0,0.15)",color:"#fff",fontSize:"14px",fontWeight:600,display:"flex",alignItems:"center",gap:"8px",whiteSpace:"pre-line",background:toast.type==="error"?"#ef4444":toast.type==="warn"?"#f59e0b":"#22c55e"}}>{toast.msg}</div>}

      {modalCobro && <ModalCobro total={total} ticket={ticket} onConfirm={handleConfirmarVenta} onClose={() => setModalCobro(false)} isSubmitting={isSubmitting} />}

      {modalVentaLibre && (
        <ModalVentaLibre onConfirm={handleAgregarVentaLibre} onClose={() => setModalVentaLibre(false)} />
      )}

      {modalFraccionar && (
        <ModalFraccionar producto={modalFraccionar} onConfirm={handleCrearFraccion} onClose={() => setModalFraccionar(null)} />
      )}

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
            <button onClick={toggleTheme} className="pos-theme-toggle" title={posTheme === "light" ? "Modo oscuro" : "Modo claro"}>
              <i className={`fa-solid ${posTheme === "light" ? "fa-moon" : "fa-sun"}`}></i>
            </button>
            <button onClick={() => setScannerModalOpen(true)} className="btn-secondary" style={{whiteSpace:"nowrap",padding:"8px 12px",fontSize:"12px",display:"flex",alignItems:"center",gap:"6px"}} title="Escanear desde celular">
              <span style={{display:"inline-flex",alignItems:"center",gap:"4px"}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:socketConnected?"#22c55e":"#ef4444",display:"inline-block"}}></span>
                📱 Escanear
              </span>
            </button>
            <button onClick={() => setModalVentaLibre(true)} className="btn-secondary" style={{whiteSpace:"nowrap",padding:"8px 12px",fontSize:"12px"}} title="Vender un producto que no está en el inventario">
              ⚡ Venta libre
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
                    const esPesable = p.unidadMedida && escalaUnidad(p.unidadMedida) === 1000;
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
                            <div style={{display:"flex",gap:"2px"}}>
                              <div
                                onClick={(e) => { e.stopPropagation(); setCalcProducto(p); }}
                                style={{cursor:"pointer",fontSize:"14px",color:"var(--kanagawa-blue)",padding:"2px 4px",borderRadius:"4px",lineHeight:1,background:"rgba(137,180,250,0.1)"}}
                                title="Calcular por peso"
                              >⚖️</div>
                              <div
                                onClick={(e) => { e.stopPropagation(); setModalFraccionar(p); }}
                                style={{cursor:"pointer",fontSize:"14px",color:"var(--kanagawa-blue)",padding:"2px 4px",borderRadius:"4px",lineHeight:1,background:"rgba(137,180,250,0.1)"}}
                                title="Fraccionar"
                              >✂️</div>
                            </div>
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
              <button onClick={vaciarTicket} className="btn-secondary">
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
