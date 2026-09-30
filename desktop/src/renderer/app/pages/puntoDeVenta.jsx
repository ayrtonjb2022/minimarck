  import { useState, useEffect, useMemo, useRef, useCallback } from "react";
  import { NavLink } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { productosAPI } from "../api/productos";
import { categoriasAPI } from "../api/categorias";
import { ventasAPI } from "../api/ventas";
import { deudoresAPI } from "../api/deudores";
import { mensajeDeError } from "../api/ipc";
import { useCaja } from "../context/CajaContext";
import { useTheme } from "../context/ThemeContext";
import { useSubmitGuard } from "../hooks/useSubmitGuard";
import CalculadoraPeso from "../components/common/CalculadoraPeso";
import BoletaPago from "../components/common/BoletaPago";
import { formatCentavos, formatCantidad } from "../utils/formatters";
// `src/shared/` es el módulo que main y el renderer comparten para no discrepar sobre plata y
// cantidades. Desde `src/renderer/app/pages/` son tres niveles arriba, NO cuatro: un `..` de más
// apunta a `desktop/shared/`, que no existe, y el error sólo aparece al resolver, no al parsear.
import { lineTotalCentavos, toMilli, escalaUnidad, QTY_SCALE, MAX_MILLI } from "../../../shared/qty";
import { toCents } from "../../../shared/money";


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

// `escalaUnidad` NO se redefine acá: se importa de src/shared/qty.js. La copia local de este
// archivo además aceptaba "lt"/"litro", que el CHECK de 001_init.sql no permite, así que las
// dos versiones discrepaban sobre qué unidades existen.

/**
 * EL TOTAL DEL TICKET, EN CENTAVOS, CON LA MISMA ARITMÉTICA QUE EL LEDGER.
 *
 * `round2` — que la web tenía acá y este archivo ya NO tiene — redondea la mitad hacia
 * +Infinity, así que `round2(-0.5)` es `-0`: un crédito y un débito de igual magnitud redondean
 * en direcciones opuestas. Ese es el motivo por el que el total sale de
 * `lineTotalCentavos(precioCentavos, qtyMilli)` — una multiplicación y una división exacta por
 * 1000, ambas enteras, exactamente el cálculo que hace `ventas.repo.js` al escribir la venta. La
 * pantalla y el libro no pueden dar totales distintos, y no queda ninguna función de redondeo
 * suelta en el archivo que alguien pueda volver a usar por costumbre.
 */
const totalDelTicket = (ticket) =>
  ticket.reduce((sum, i) => sum + lineTotalCentavos(i.precioCentavos, i.qtyMilli), 0);

/**
 * El modal de pago. `totalCentavos` ES el total del ticket en centavos enteros — el POS lo calcula
 * con el mismo `lineTotalCentavos` con el que el repositorio escribe la venta, y este componente
 * nunca lo vuelve a derivar.
 *
 * TODO EL DINERO DE ACA DENTRO ES CENTAVOS, INCLUIDO EL QUE ESCRIBE EL CAJERO. El input guarda un
 * string, el número que importa es `toCents(montoEntregado)`, y el cambio es una resta de dos
 * enteros. La web hacía `parseFloat(monto) - total` sobre pesos y después `toFixed(2)`, y eso no
 * puede representar 10,005 — justo el tipo de importe que una caja entrega en una venta de $10,00
 * con $20,01 recibidos.
 */
function ModalCobro({ totalCentavos, onConfirm, onClose, isSubmitting }) {
  const [metodoPago, setMetodoPago] = useState("efectivo");
  const [montoEntregado, setMontoEntregado] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [deudores, setDeudores] = useState([]);
  const [deudorSel, setDeudorSel] = useState(null);
  const [buscando, setBuscando] = useState(false);
  // The payment receipt, when the operator asks for it. Null means closed. It is loaded here
  // rather than in a route because this is the only place a shop is looking at a debtor while
  // deciding how much cash to hand over.
  const [boleta, setBoleta] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const abrirBoleta = async () => {
    if (!deudorSel) return;
    try {
      // The balance rides along on the debtor row (`deudaPendienteCentavos`, from the view);
      // only the history needs a second call. A failure here shows a receipt with the balance
      // and no history rather than nothing at all, because the balance is the number people
      // actually came for.
      const res = await deudoresAPI.pagos(deudorSel.id);
      setBoleta({ deudor: deudorSel, pagos: res?.pagos ?? [] });
    } catch {
      setBoleta({ deudor: deudorSel, pagos: [] });
    }
  };

  // `toCents` LANZA con cualquier cosa no parseable, y un "2." a medio teclear es exactamente
  // eso. Un cajero escribiendo "20" tiene que ver todavía sin cambio y sin error, así que un
  // parseo inválido es CERO acá, y es `montoValido` lo que se niega a confirmar.
  const entregadoCentavos = (() => {
    try {
      return toCents(montoEntregado || '0', 'monto entregado');
    } catch {
      return 0;
    }
  })();

  const cambioCentavos =
    metodoPago === "efectivo" ? Math.max(0, entregadoCentavos - totalCentavos) : 0;
  const montoValido = metodoPago !== "efectivo" || entregadoCentavos >= totalCentavos;

  useEffect(() => {
    if (metodoPago !== "credito") { setDeudorSel(null); setBusqueda(""); setDeudores([]); return; }
    if (busqueda.length < 1) { setDeudores([]); return; }
    setBuscando(true);
    const timer = setTimeout(() => {
      // Respuesta DIRECTA del IPC: el handler devuelve `{ filas }`, no el sobre `{data:{data}}`
      // de axios que esta línea tenía que desenvolver en la web.
      deudoresAPI.listar({ search: busqueda, limit: 10 })
        .then((r) => setDeudores(r.filas || []))
        .catch(() => {})
        .finally(() => setBuscando(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [busqueda, metodoPago]);

  // El límite de crédito es un techo sobre la deuda RESULTANTE, así que esto compara la deuda que
  // la venta IBA a crear contra el límite, ambos en centavos. Comparar pesos contra centavos es un
  // error de 100x que dejaría pasar a un cliente $100 por encima de lo pactado.
  const advertencia = deudorSel?.limiteCreditoCentavos != null
    ? (deudorSel.deudaPendienteCentavos + totalCentavos) > deudorSel.limiteCreditoCentavos
    : false;

  const handleConfirm = () => {
    if (metodoPago === "credito") {
      if (!deudorSel) return;
      onConfirm({ metodoPago, clienteDeudorId: deudorSel.id, deudorNombre: deudorSel.nombre });
    } else {
      if (!montoValido) return;
      // The change is SHOWN to the cashier, never SENT to the repository. `cambioCentavos` is
      // what this screen believes the change is; the value that gets persisted is the one
      // `ventas.repo.js` subtracts inside the sale transaction from the tender and the total
      // IT computed. Handing this number over would let a tampered payload name the change, so
      // the payload carries the tender alone and the handler reads the change back off the
      // response (`venta.montoCambioCentavos`) to show the operator what was actually stored.
      onConfirm({
        metodoPago,
        montoEntregadoCentavos: entregadoCentavos || totalCentavos,
      });
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
            <p style={{fontSize:"32px",fontWeight:700,color:"#1d4ed8"}}>{formatCentavos(totalCentavos)}</p>
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
               <input ref={inputRef} type="text" inputMode="decimal" value={montoEntregado} onChange={(e) => setMontoEntregado(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
                placeholder={`Mínimo ${formatCentavos(totalCentavos)}`} className={!montoValido && montoEntregado ? "error" : ""} />
              {cambioCentavos > 0 && (
                <div style={{marginTop:"8px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:"8px",padding:"12px",textAlign:"center"}}>
                  <p style={{fontSize:"13px",color:"#64748b"}}>Cambio a entregar</p>
                  <p style={{fontSize:"24px",fontWeight:700,color:"#16a34a"}}>{formatCentavos(cambioCentavos)}</p>
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
                    <p style={{margin:"4px 0 0",fontSize:"12px",color:"#64748b"}}>Deuda actual: <strong style={{color:"#dc2626"}}>{formatCentavos(deudorSel.deudaPendienteCentavos)}</strong></p>
                    <p style={{margin:"2px 0 0",fontSize:"12px",color:"#1e293b"}}>Nueva deuda: <strong>{formatCentavos(deudorSel.deudaPendienteCentavos + totalCentavos)}</strong></p>
                  </div>
                  {deudorSel.deudaPendienteCentavos > 0 && (
                    <div style={{marginTop:"6px",background:"#fef9c3",border:"1px solid #fde047",borderRadius:"8px",padding:"8px 12px",fontSize:"12px",color:"#854d0e",fontWeight:500}}>
                      <i className="fa-solid fa-exclamation-triangle" style={{marginRight:"4px"}}></i>
                      Tiene deuda pendiente
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={abrirBoleta}
                    className="btn-secondary"
                    style={{marginTop:"8px",width:"100%"}}
                  >
                    <i className="fa-solid fa-receipt" style={{marginRight:"6px"}}></i>
                    Ver boleta de pago
                  </button>
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
                          <span style={{color:d.deudaPendienteCentavos>0?"#ef4444":"#16a34a",fontWeight:600}}>
                            Deuda: {formatCentavos(d.deudaPendienteCentavos)}
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
                    <span>Deuda actual: <strong style={{color:"#dc2626"}}>{formatCentavos(deudorSel.deudaPendienteCentavos)}</strong></span>
                    <span>Límite: <strong>{deudorSel.limiteCreditoCentavos != null ? formatCentavos(deudorSel.limiteCreditoCentavos) : "sin límite"}</strong></span>
                  </div>
                  {advertencia && (
                    <div style={{marginTop:"8px",background:"#fef9c3",border:"1px solid #fde047",borderRadius:"8px",padding:"8px 12px",fontSize:"12px",color:"#854d0e",fontWeight:500}}>
                      <i className="fa-solid fa-exclamation-triangle" style={{marginRight:"4px"}}></i>
                      Esta venta supera el límite de crédito del cliente. Deuda proyectada: {formatCentavos(deudorSel.deudaPendienteCentavos + totalCentavos)}
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

      {/* The receipt, over the payment screen. Its own overlay (z-index 210) so it sits above the
          modal underneath it, and it is rendered LAST so a later sibling wins the paint order. */}
      {boleta && (
        <div
          role="dialog"
          aria-label="Boleta de pago"
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)",zIndex:210,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px",overflowY:"auto"}}
        >
          <div style={{background:"#fff",borderRadius:"12px",padding:"18px",width:"100%",maxWidth:"460px"}}>
            <BoletaPago
              deudor={boleta.deudor}
              pagos={boleta.pagos}
              onClose={() => setBoleta(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Abrir la caja con su fondo inicial.
 *
 * El monto se tipea en PESOS y viaja como pesos: `cajas.repo.js` lo pasa por `toCents` y lo
 * escribe entero. Lo importante es que el input NO es `type="number"` — un `number` con
 * `step="0.01"` acepta notación exponencial y valores que el parser decimal rechaza, y el cajero
 * vería un error de formato sin entender por qué. `toCents` es el que dice qué es un monto válido.
 */
function ModalAperturaCaja({ onConfirm, onClose }) {
  const [saldoInicial, setSaldoInicial] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [guardando, setGuardando] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleConfirm = async () => {
    if (guardando) return;
    setGuardando(true);
    const res = await onConfirm(saldoInicial || '0', observaciones.trim() || undefined);
    setGuardando(false);
    if (res?.success) onClose();
  };

  return (
    <div className="modal-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div className="card" style={{width:"100%",maxWidth:"400px"}}>
        <div className="card-header">
          <div>
            <h3 style={{margin:0,fontSize:"18px"}}>Abrir caja</h3>
            <span className="tag" style={{marginTop:"4px",display:"inline-block"}}>Contá el efectivo inicial</span>
          </div>
          <button onClick={onClose} className="btn-secondary" style={{padding:"6px 10px"}}><i className="fa-solid fa-times"></i></button>
        </div>
        <div style={{padding:"22px",display:"flex",flexDirection:"column",gap:"14px"}}>
          <div className="form-group" style={{margin:0}}>
            <label>Fondo inicial ($)</label>
            <input ref={inputRef} type="text" inputMode="decimal" value={saldoInicial}
              onChange={(e) => setSaldoInicial(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
              placeholder="Ej: 5000" />
          </div>
          <div className="form-group" style={{margin:0}}>
            <label>Observaciones (opcional)</label>
            <input type="text" value={observaciones} onChange={(e) => setObservaciones(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
              placeholder="Ej: turno mañana" />
          </div>
          <div style={{display:"flex",gap:"12px"}}>
            <button onClick={onClose} className="btn-secondary" style={{flex:1}} disabled={guardando}>Cancelar</button>
            <button onClick={handleConfirm} className="btn-primary" style={{flex:1}} disabled={guardando}>
              {guardando ? "Abriendo..." : "Abrir caja"}
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

  // El precio se pasa a CENTAVOS una vez, al tipearlo, y el costo estimado se descompone en
  // enteros desde ahí. La web hacía `precioNum / (1 + margen/100)` en float y recién después
  // redondeaba, así que el costo de una venta libre a $1.000 con 30% era 769,2307… y terminaba
  // en un centavo que no era de nadie.
  const precioCentavos = (() => {
    try { return toCents(precio || '0', 'precio'); } catch { return 0; }
  })();
  const precioValido = precioCentavos > 0;
  const costoCentavos = precioValido ? Math.round(precioCentavos / (1 + margen / 100)) : 0;
  const gananciaCentavos = precioValido ? precioCentavos - costoCentavos : 0;
  const valido = nombre.trim().length > 0 && precioValido;

  const handleConfirm = () => {
    if (!valido) return;
    onConfirm({
      id: `libre-${Date.now()}-${++idCounterRef.current}`,
      nombre: nombre.trim(),
      precioCentavos,
      costoUnitarioCentavos: costoCentavos,
      qtyMilli: QTY_SCALE,
      stockMilli: MAX_MILLI,
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
                <p style={{fontSize:"16px",fontWeight:700,color:"#1d4ed8",margin:0}}>{formatCentavos(costoCentavos)}</p>
              </div>
              <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:"8px",padding:"10px 12px",textAlign:"center"}}>
                <p style={{fontSize:"12px",color:"#64748b",margin:"0 0 2px"}}>Ganancia estimada</p>
                <p style={{fontSize:"16px",fontWeight:700,color:"#16a34a",margin:0}}>{formatCentavos(gananciaCentavos)}</p>
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
  // El prorrateo se hace en CENTAVOS y recién al enviar se divide por 100. `productos.crear` sí
  // espera pesos decimales (el repo los pasa por `toCents`), pero derivarlos de un float ya
  // redondeado es dejar que el error entre por la puerta de atrás: la fracción de medio kilo de un
  // producto de $1.234,56 tiene que dar 617,28, no 617,28 después de dos `round2`.
  const precioNuevoCentavos = Math.round((producto.precioCentavos ?? 0) * fractionOfBase);
  const costoCreaCentavos = Math.round((producto.precioCompraCentavos ?? 0) * fractionOfBase);
  const costoBaseCentavos = producto.precioCompraCentavos ?? 0;
  const margenBase = costoBaseCentavos > 0
    ? (((producto.precioCentavos ?? 0) - costoBaseCentavos) / costoBaseCentavos) * 100
    : 0;

  const handleCrear = async () => {
    if (bloqueado || !valido || creando) return;
    setCreando(true);
    try {
      await onConfirm({
        nombre: `${producto.nombre} ${valorNum}${unidad}`,
        precio: precioNuevoCentavos / 100,
        precioCompra: costoCreaCentavos / 100,
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
              <span>Precio: <strong>{formatCentavos(producto.precioCentavos)}</strong></span>
              <span>Costo: <strong>{formatCentavos(costoBaseCentavos)}</strong></span>
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
                <p style={{fontSize:"16px",fontWeight:700,color:"#1d4ed8",margin:0}}>{formatCentavos(precioNuevoCentavos)}</p>
              </div>
              <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:"8px",padding:"10px 12px",textAlign:"center"}}>
                <p style={{fontSize:"12px",color:"#64748b",margin:"0 0 2px"}}>Costo estimado</p>
                <p style={{fontSize:"16px",fontWeight:700,color:"#dc2626",margin:0}}>{formatCentavos(costoCreaCentavos)}</p>
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
  const { cajaActiva, loadingCaja, abrirCaja } = useCaja();
  const queryClient = useQueryClient();

  // React Query — productos cacheados (comparte caché con Productos)
  // Respuesta DIRECTA del IPC: `productos.list` devuelve `{ filas, total }`. El `r.data?.data` de
  // la web era el desarrollo del sobre de axios, y en el desktop no existe ese sobre: desenvolver
  // `undefined` a `|| []` convertiría un fallo en un catálogo vacío silencioso.
  const { data: productosAll = [] } = useQuery({
    queryKey: ["productos", "all-for-pos"],
    queryFn: () => productosAPI.listar({ limit: 500 }).then((r) => r.filas || []),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  const productos = productosAll.filter((p) => p.activo !== false);

  // Categorías con React Query
  const { data: categorias = [] } = useQuery({
    queryKey: ["categorias"],
    queryFn: () => categoriasAPI.listar().then((r) => r.filas || []),
    staleTime: 10 * 60 * 1000,
  });

  const [ticket, setTicket] = useState([]);
  const [filtro, setFiltro] = useState("");
  const [categoriaActiva, setCategoriaActiva] = useState("Todas");
  const [modalCobro, setModalCobro] = useState(false);
  const [toast, setToast] = useState(null);
  const [procesando, setProcesando] = useState(false);
  const [modalAperturaCaja, setModalAperturaCaja] = useState(false);
  const [calcProducto, setCalcProducto] = useState(null);
  const [modalVentaLibre, setModalVentaLibre] = useState(false);
  const [modalFraccionar, setModalFraccionar] = useState(null);
  const searchRef = useRef(null);
  // Última venta enviada: { key, items }. Sobrevive a un error de red ambiguo
  // para que el reintento deduplique en el servidor (ver ticketKey más abajo).
  const ultimoEnvioRef = useRef(null);
  // F2 is the key a till actually gets pressed, and the payment screen used to be reachable only
  // by clicking a button with the mouse, so a cashier working the scanner had to break the flow to
  // go take the money. The keydown listener is registered ONCE (empty deps, below) so that F2
  // does not tear down and rebuild on every keystroke in the ticket — which also means it cannot
  // close over `ticket`/`procesando`, or the guard it reads would be the one from mount time. The
  // live condition therefore lives in a ref that each render refreshes, and the handler reads it
  // at the instant the key arrives. Same rule as `ultimoEnvioRef`: write during render, read in
  // the event.
  const cobroListoRef = useRef(false);
  // Same one-shot-listener problem as above, for Escape: the modal's open state has to be readable
  // at the moment the key arrives.
  const modalCobroRef = useRef(false);

  const { isSubmitting, withGuard } = useSubmitGuard();
  // The theme is the APP's, not the POS panel's: `useTheme` owns the class on <html> so the
  // sales list, the tables and the top bar move with it. The old local state set
  // `pos-theme-light` on this one container, which meant the operator flipped the till to
  // light and the rest of the app stayed dark. The toggle below now calls the same
  // `toggleTheme` the top bar does, so the two controls can never disagree.
  const { theme: posTheme, toggleTheme } = useTheme();

  const showToast = useCallback((msg, type = "success", duration = 3500) => { setToast({ msg, type }); setTimeout(() => setToast(null), duration); }, []);

  // Written on every render, read by the F2 handler below. The button's own guard is
  // `ticket.length > 0 && !procesando && !isSubmitting`, and F2 must obey the SAME rule: a key
  // that opens a screen the button would refuse to open is a worse bug than a key that does
  // nothing, because the cashier finds out after typing the tender.
  cobroListoRef.current = ticket.length > 0 && !procesando && !isSubmitting;
  modalCobroRef.current = modalCobro;

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); searchRef.current?.focus(); }
      // Escape backs out of whatever is in front of the operator, nearest first: the payment
      // screen if it is up, otherwise the product filter. Before this, Escape cleared the filter
      // from BEHIND an open modal, which meant the fastest way out of a mistaken tender was to
      // find the small X with the mouse.
      if (e.key === "Escape") {
        if (modalCobroRef.current) setModalCobro(false);
        else setFiltro("");
      }
      // F2 opens the payment screen. `preventDefault` because F2 is a system key on some
      // Windows layouts (it renames the window in Explorer) and letting it through would fight
      // the cashier mid-sale. Held keys are ignored: pressing F2 and holding it should open the
      // screen once, not re-fire on auto-repeat.
      if (e.key === "F2" && !e.repeat) {
        e.preventDefault();
        if (cobroListoRef.current) setModalCobro(true);
      }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);

  // NO HAY SOCKET. La web abría un socket.io al negocio para recibir escaneos desde el celular vía
  // un QR, y `disconnectSocket` lo cerraba al desmontar. En el desktop el escáner es un teclado: el
  // input de búsqueda ya está en el foco y el Enter del hardware llega por acá. Un socket sería
  // una conexión de red a un servidor que este build no tiene, y un `connectSocket` colgado sería
  // un POS que no arranca en la caja. El botón que abría el QR se fue con esto.

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

  // `stock` era un entero de UNIDADES en la web. Acá `stockMilli` es milésimas: un kg de queso con
  // stock 1500 es 1,5 kg. Comparar contra 0 no cambia, pero cualquier umbral posterior tiene que
  // compararse contra el mismo milésimo que el decremento.
  const conStock = productosFiltrados.filter((p) => (p.stockMilli ?? 0) > 0);
  const sinStock = productosFiltrados.filter((p) => (p.stockMilli ?? 0) <= 0);

  // El total, en centavos, con la aritmética de `shared/qty`. La web hacía
  // `s + parseFloat(i.precio) * i.qty` sobre pesos: 3 × 33,33 son 99,99 y el ticket podía mostrar
  // un centavo menos que lo que se cobraba.
  const totalCentavos = useMemo(() => totalDelTicket(ticket), [ticket]);

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

  /**
   * Sumar al ticket, en milésimas.
   *
   * Un producto NO pesable arranca en 1000 (una unidad) y avanza de a 1000. Un pesable arranca
   * igual — 1 kg, 1 L — y el peso exacto lo fija la balanza después. Un producto con
   * `stockMilli` de 1500 sólo admite UN item de 1000: el chequeo compara milésimas contra
   * milésimas, así que no hay forma de vender 2 kg de algo que tiene 1,5.
   */
  const agregarProducto = (p) => {
    const stockMilli = p.stockMilli ?? 0;
    setTicket((prev) => {
      const ex = prev.find((i) => i.id === p.id);
      if (ex) {
        const nuevaQty = ex.qtyMilli + QTY_SCALE;
        if (nuevaQty > stockMilli) { showToast("Stock insuficiente", "warn"); return prev; }
        return prev.map((i) => (i.id === p.id ? { ...i, qtyMilli: nuevaQty } : i));
      }
      if (stockMilli < QTY_SCALE) { showToast("Stock insuficiente", "warn"); return prev; }
      return [...prev, { ...p, qtyMilli: QTY_SCALE, precioCentavos: p.precioCentavos ?? 0 }];
    });
  };

  /**
   * EL ESCÁNER DE BARRAS.
   *
   * Un lector de barras NO es una cámara ni un socket: es un teclado que escribe el código y
   * después manda Enter. Por eso el Enter es el evento, y por eso tiene que agregar el producto
   * acá y no sólo filtrar la grilla.
   *
   * Sin esto, escanear 20 artículos de una compra de aut-service significaba 20 clics: el
   * `Enter` en la web no hacía nada porque nadie lo escuchaba. Y como el input filtra por
   * `nombre codigo`, un código suelto que coincide con un producto tiene que agregarlo SÍ O SÍ.
   *
   * `preventDefault` porque sin él el Enter de un input dentro de un form submitearía; y el campo
   * se limpia después para que el siguiente escaneo no concatene al anterior.
   */
  const manejarEnterBusqueda = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const codigo = filtro.trim();
    if (!codigo) return;
    const exacto = productos.find(
      (p) => (p.codigo || "").toLowerCase() === codigo.toLowerCase(),
    );
    if (exacto) {
      agregarProducto(exacto);
      setFiltro("");
    } else {
      showToast(`Sin coincidencia para "${codigo}"`, "warn");
    }
  };

  const cambiarQty = (id, delta) =>
    setTicket((prev) =>
      prev
        .map((i) => {
          if (i.id !== id) return i;
          const nuevaQty = i.qtyMilli + delta * QTY_SCALE;
          if (nuevaQty <= 0) return null;
          if (nuevaQty > (i.stockMilli ?? 0)) { showToast("Stock insuficiente", "warn"); return i; }
          return { ...i, qtyMilli: nuevaQty };
        })
        .filter(Boolean),
    );
  const quitarItem = (id) => setTicket((prev) => prev.filter((i) => i.id !== id));

  /**
   * LOS DIVISORES EN ESTE BLOQUE, Y POR QUÉ NO PIERDEN UN CENTAVO.
   *
   * `ventas.repo.js` NO espera enteros: llama `toMilli(item.cantidad)` y `toCents(item.precioUnitario)`,
   * o sea, parsea DECIMALES en unidad base. Por eso el ticket vive en milésimas y centavos pero
   * viaja dividido por 1000 y por 100.
   *
   * Dividir un entero por 1000 o por 100 produce un número con a lo sumo 3 o 2 decimales, y
   * `String()` de ese número devuelve la cadena más corta que vuelve al mismo valor — así que
   * `String(1234/1000) === "1.234"` y `toMilli` la reconstruye como 1234 exacto. El round-trip no
   * pierde nada porque la escala coincide con la del módulo, no por suerte.
   *
   * Y el CAMBIO NO VIAJA. `montoCambio = montoRecibido - total` lo calcula el repo, en enteros,
   * dentro de la transacción (línea 339). Mandarlo desde acá sería mandar un número que nadie lee
   * y que puede no coincidir con el que se guardó. `cambioCentavos` es sólo para el cartel de
   * confirmación, y aun así el valor que se muestra es el que volvió del servidor.
   */
  const handleConfirmarVenta = async ({ metodoPago, montoEntregadoCentavos, clienteDeudorId, deudorNombre }) => {
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
              cantidadMilli: i.qtyMilli,
              precioUnitarioCentavos: i.precioCentavos ?? null,
              costoUnitarioCentavos: i.costoUnitarioCentavos ?? null,
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
              ? { nombre: i.nombre, cantidad: i.qtyMilli / QTY_SCALE, precioUnitario: i.precioCentavos / 100, costoUnitario: i.costoUnitarioCentavos / 100 }
              : { productoId: i.productoId || i.id, cantidad: i.qtyMilli / QTY_SCALE, ...(i.pesado ? { precioUnitario: i.precioCentavos / 100, nombre: i.nombre, costoUnitario: i.costoUnitarioCentavos / 100 } : {}) }
          )),
          metodoPago,
          idempotencyKey: key,
        };
        // El monto entregado se manda siempre que el cajero haya tipeado algo, aunque sea el
        // exacto: `monto_recibido_centavos` es lo que el arqueo de caja compara contra el
        // efectivo del cajón. El repo trata 0 o vacío como AUSENTE, que es un caso distinto.
        if (metodoPago === "efectivo" && montoEntregadoCentavos > 0) {
          body.montoRecibido = montoEntregadoCentavos / 100;
        }
        if (clienteDeudorId) body.clienteDeudorId = clienteDeudorId;
        // Congelar key + snapshot del ticket al ENVIAR: si la respuesta se
        // pierde, el reintento reusa esta MISMA key → el servidor deduplica.
        ultimoEnvioRef.current = { key, items: ticket };
        const res = await ventasAPI.crear(body);
        // Respuesta DIRECTA: `{ venta, duplicado, advertenciaLimite? }`. El `res.data?.data` de la
        // web era el sobre de axios; acá `res.data` no existe y toda esta rama daba `undefined`.
        const venta = res.venta;
        const duplicado = res.duplicado === true;
        const advertencia = res.advertenciaLimite;
        const ventaId = venta?.id;
        // En el caso duplicado el servidor devuelve la venta YA registrada con su folio y su
        // total REAL: mostrarlos en vez del ticket actual (que tras un reintento puede no
        // coincidir). Los montos se leen de la respuesta, no se recalculan.
        const totalMostrado = venta?.totalCentavos ?? totalCentavos;
        const cambioMostrado = venta?.montoCambioCentavos ?? 0;
        const idMostradoVenta = venta?.folio || ventaId;
        vaciarTicket(); setModalCobro(false);
        const methodLabel = metodoPago === "efectivo" ? "Efectivo" : metodoPago === "tarjeta" ? "Tarjeta" : metodoPago === "transferencia" ? "Transferencia" : "Fiado";
        const cabecera = duplicado ? `Venta #${idMostradoVenta} ya registrada` : `Venta #${ventaId} registrada`;
        let saleMsg;
        if (metodoPago === "credito") {
          saleMsg = `${cabecera}\nFiado a: ${deudorNombre || "cliente"}\nTotal: ${formatCentavos(totalMostrado)}`;
        } else if (cambioMostrado > 0) {
          saleMsg = `${cabecera}\n${methodLabel}: ${formatCentavos(totalMostrado)}\nCambio: ${formatCentavos(cambioMostrado)}`;
        } else {
          saleMsg = `${cabecera}\n${methodLabel}: ${formatCentavos(totalMostrado)}`;
        }
        showToast(saleMsg, "success", 5000);
        if (advertencia) setTimeout(() => showToast(advertencia, "warn"), 500);
        queryClient.invalidateQueries({ queryKey: ["productos", "all-for-pos"] });
      } catch (err) { showToast(mensajeDeError(err, "Error al registrar la venta"), "error"); }
      finally { setProcesando(false); }
    });
  };

  /**
   * Pesar, y VENDER lo que pesó.
   *
   * Acá está la diferencia entre medio kilo y un kilo. La web guardaba la línea con `qty: 1` y
   * el peso en un campo aparte, y ajustaba sólo el COSTO prorrateado: el `ventas_detalles.cantidad`
   * era 1, la balanza de stock bajaba 1, y la venta de 500 g de algo que vale $1.000 el kilo
   * cobraba $1.000 y consumía un kilo entero de stock. El comentario del repo lo dice en la línea
   * 18: la cantidad es la que sale de la balanza.
   *
   * Ahora `qtyMilli` ES el peso en gramos: 500 g de queso entra como 500, el envío divide por 1000
   * a 0,5, y `toMilli` en el repo vuelve a 500 — la misma cifra que ve la balanza. Y
   * `precioCentavos` es el precio del KILO COMPLETO, porque el total de la línea lo calcula el
   * repo como `lineTotalCentavos(precio, cantidadMilli)`; mandar el precio ya prorroteado lo
   * multiplicaría por 0,5 otra vez y cobraría $250.
   */
  const handleCalcularPeso = ({ productoId, nombre, peso, precio }) => {
    const producto = productos.find((p) => p.id === productoId);
    if (!producto) return;
    const unidadBase = (producto.unidadMedida || "").trim().toLowerCase();
    // Guarda defensiva (el botón de la balanza solo se muestra para kg/L, pero si llega
    // una unidad g/ml bloquear: el costo prorrateado saldría ×1000 inflado).
    if (escalaUnidad(unidadBase) !== 1000) {
      showToast("Este producto no admite cálculo por peso (solo unidades kg/L)", "warn");
      setCalcProducto(null);
      return;
    }
    const uid = `peso-${productoId}-${Date.now()}`;
    // THE SCALE REPORTS GRAMS; `toMilli` PARSES BASE UNITS. Handing it 500 meant `toMilli(500)`
    // read "five hundred kilos" and returned 500000, so half a kilo of a $2.000/kg product was
    // written as 500 kg and billed $1.000.000,00. Nothing threw: 500000 is a perfectly valid
    // number of milli. The ticket said "500 kg" and the till charged a million pesos, and the
    // only reason this is fixed is that a test weighed a kilo.
    //
    // Grams -> base units -> milli is the one conversion this line is allowed to make, and it
    // goes through the shared parser so the three-decimal rule and the error messages stay in
    // one place. `toFixed(3)` is not a rounding choice: it is the scale's resolution, and a
    // product cannot be sold by a fraction of a gram.
    const pesoMilli = toMilli((peso / QTY_SCALE).toFixed(3), `peso de ${nombre}`);
    if (pesoMilli < 1) {
      showToast("El peso tiene que ser mayor a 0", "warn");
      setCalcProducto(null);
      return;
    }
    // Costo PRORRATEADO por la fracción vendida: el peso viene en gramos y la escala de la unidad
    // base (kg/L → 1000) da la fracción de la unidad base. El costo va en CENTAVOS y se prorratea
    // en enteros; `round2` quedan fuera porque redondea la mitad hacia +Infinity.
    const costoUnitarioCentavos = Math.round(
      (producto.precioCompraCentavos ?? 0) * (pesoMilli / QTY_SCALE) / (escalaUnidad(unidadBase) / QTY_SCALE),
    );
    // El toast muestra el SUBTOTAL de la línea — el precio por kilo aplicado a medio kilo — que es
    // lo que el cajero va a ver cobrar. Sale del mismo `lineTotalCentavos` que usa el ticket y el
    // repo, así que los tres números no pueden discrepar.
    showToast(`${nombre} — ${formatCentavos(lineTotalCentavos(producto.precioCentavos, pesoMilli))}`);
    setTicket((prev) => [...prev, {
      id: uid,
      productoId,
      nombre,
      precioCentavos: producto.precioCentavos,
      costoUnitarioCentavos,
      qtyMilli: pesoMilli,
      stockMilli: producto.stockMilli ?? 0,
      peso: pesoMilli,
      pesado: true,
    }]);
    setCalcProducto(null);
  };

  const handleAgregarVentaLibre = (item) => {
    setTicket((prev) => [...prev, item]);
    setModalVentaLibre(false);
    showToast(`Venta libre: ${item.nombre} — ${formatCentavos(lineTotalCentavos(item.precioCentavos, item.qtyMilli))}`);
  };

  const handleCrearFraccion = async (data) => {
    try {
      const res = await productosAPI.crear(data);
      // Respuesta DIRECTA: el handler devuelve el producto. El `res.data?.data` era el sobre de
      // axios, así que «Fraccionar» creaba el producto en la base y después fallaba con
      // «Respuesta inválida del servidor» sin llegar a agregarlo al ticket: la venta se perdía
      // con el producto ya creado. Mismo error que la línea 760.
      const nuevo = res;
      if (!nuevo?.id) throw new Error("Respuesta inválida del servidor");
      agregarProducto(nuevo);
      setModalFraccionar(null);
      showToast(`✅ Producto creado: ${nuevo.nombre}`, "success", 4000);
      queryClient.invalidateQueries({ queryKey: ["productos", "all-for-pos"] });
    } catch (err) {
      showToast(err.response?.data?.message || "Error al crear el producto", "error");
    }
  };

  if (loadingCaja) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh"}}><div className="spinner" style={{width:"32px",height:"32px",border:"3px solid #e2e8f0",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} /></div>;

  /**
   * SIN CAJA NO HAY POS.
   *
   * La web dejaba cargar todo y sólo fallaba al confirmar: el cajero armaba un ticket de veinte
   * artículos, cobraba, y recién ahí aparecía el error. En el desktop `ventas.create` exige una
   * caja abierta (es lo que hace que el arqueo cierre), así que un ticket entero se puede armar y
   * no se puede cobrar.
   *
   * Por eso el bloqueo va ACÁ, antes de la grilla, y no en el botón: no tiene sentido mostrar
   * productos que no se pueden vender. Y el botón es de apertura, no de login — no hay usuario
   * que autenticarse, hay una caja que abrir con su fondo inicial.
   */
  if (!cajaActiva) {
    return (
      <div className="pos-container" style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",padding:"24px"}}>
        <div className="card" style={{maxWidth:"420px",width:"100%",textAlign:"center",padding:"32px"}}>
          <h2 style={{margin:"0 0 8px",fontSize:"20px"}}>No hay caja abierta</h2>
          <p style={{margin:"0 0 20px",fontSize:"14px",color:"#64748b",lineHeight:1.5}}>
            Para cobrar hace falta una caja abierta con su fondo inicial. Abrila para empezar a vender.
          </p>
          <button onClick={() => setModalAperturaCaja(true)} className="btn-primary" style={{width:"100%"}}>
            Abrir caja
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pos-container">
      {toast && <div style={{position:"fixed",top:"16px",left:"50%",transform:"translateX(-50%)",zIndex:100,padding:"12px 20px",borderRadius:"12px",boxShadow:"0 4px 12px rgba(0,0,0,0.15)",color:"#fff",fontSize:"14px",fontWeight:600,display:"flex",alignItems:"center",gap:"8px",whiteSpace:"pre-line",background:toast.type==="error"?"#ef4444":toast.type==="warn"?"#f59e0b":"#22c55e"}}>{toast.msg}</div>}

      {modalCobro && <ModalCobro totalCentavos={totalCentavos} onConfirm={handleConfirmarVenta} onClose={() => setModalCobro(false)} isSubmitting={isSubmitting} />}

      {modalAperturaCaja && <ModalAperturaCaja onConfirm={abrirCaja} onClose={() => setModalAperturaCaja(false)} />}

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

      {/* SE QUITÓ EL MODAL DE ESCANEO POR CELULAR, Y NO ES UNA SIMPLIFICACIÓN.
          El QR generaba una URL `window.location.origin/scanner/<negocioId>` — en el desktop
          `window.location.origin` es `app://bundle`, un esquema que no existe en el celular de
          nadie. El QR además era la puerta de entrada del socket.io que ya no hay. Dejarlo
          puesto era mostrar al cajero un código que escaneaba a la nada, y peor: eliminaba el
          `Cobrar` del flujo normal para caer en un camino muerto.

          El escáner de barras sigue siendo soportado, y mejor que antes: es un teclado USB y lo
          maneja `manejarEnterBusqueda` sobre el input de búsqueda. Lo que no existe es la
          sesión remota por red, que es una feature web, no una capacidad de caja. */}

      <div className="pos-left">
        <div className="pos-search-bar">
          <div style={{display:"flex",gap:"8px",alignItems:"center",marginBottom:"8px"}}>
            <div style={{position:"relative",flex:1}}>
              <i className="fa-solid fa-search" style={{position:"absolute",left:"10px",top:"50%",transform:"translateY(-50%)",color:"var(--kanagawa-comment)"}}></i>
              {/* `onKeyDown` con Enter es el ESCÁNER. Un lector de barras es un teclado: escribe
                  el código y manda Enter. Sin este handler el escaneo sólo filtraba la grilla y
                  había que hacer clic a mano cada artículo — que es como el POS no «tenía»
                  soporte de códigos de barras en la práctica. */}
              <input ref={searchRef} type="text" value={filtro} onChange={(e) => setFiltro(e.target.value)}
                onKeyDown={manejarEnterBusqueda} placeholder="Buscar o escanear código de barras... (Ctrl+F)" className="pos-search-input" autoFocus />
              {filtro && <button onClick={() => setFiltro("")} style={{position:"absolute",right:"8px",top:"50%",transform:"translateY(-50%)",border:"none",background:"none",cursor:"pointer",color:"var(--kanagawa-comment)"}}><i className="fa-solid fa-times"></i></button>}
            </div>
            <button onClick={toggleTheme} className="theme-toggle" title={posTheme === "light" ? "Modo oscuro" : "Modo claro"} aria-label={posTheme === "light" ? "Cambiar a modo oscuro" : "Cambiar a modo claro"}>
              <i className={`fa-solid ${posTheme === "light" ? "fa-moon" : "fa-sun"}`} aria-hidden="true"></i>
            </button>
            {/* LA SALIDA DEL PUNTO DE VENTA. Antes no existía ninguna.
                `/pos` se renderiza FUERA de `app-layout` — es una pantalla de ancho completo, sin la
                barra lateral que tienen el resto de las pantallas — y este archivo no tenía ni un
                `NavLink`, ni un `useNavigate`, ni un botón de "volver". Consecuencia real, no
                teórica: la app abre acá (`/index.html` redirige a `/pos`), así que después de
                cobrar el cajero se quedaba sin forma de llegar a la lista de ventas, que es
                justamente donde vive la cancelación de una venta. Salir era reiniciar la app.

                Va como `NavLink` y no como `<a href>` para que sea navegación del router, sin
                recargar el documento: recargar la app en mitad de un ticket abierto perdería el
                ticket. El ticket vive en estado del componente, y por eso un `a` normal aquí
                habría sido un peor bug que el que arregla. */}
            <NavLink to="/ventas" className="btn-secondary" style={{display:"inline-flex",alignItems:"center",gap:"6px",whiteSpace:"nowrap"}}>
              <i className="fa-solid fa-receipt" aria-hidden="true"></i> Ventas
            </NavLink>
            {/* El botón de «escanear desde el celular» y su punto rojo/verde se fueron con el
                socket: no hay servidor al que conectarse, y un punto rojo fijo en la barra del POS
                le diría al cajero que algo está roto cuando lo único roto era una feature web. */}
            <button onClick={() => setModalVentaLibre(true)} className="btn-secondary" style={{whiteSpace:"nowrap",padding:"8px 12px",fontSize:"12px"}} title="Vender un producto que no está en el inventario">
              Venta libre
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
                    const stockMilli = p.stockMilli ?? 0;
                    const enTicket = ticket.find((i) => i.id === p.id);
                    // `esPesable` viene GENERADO por la base (`es_pesable`) y no se re-deriva acá:
                    // la escala la usa también la guarda de la balanza y el badge, y si cada uno
                    // calcula su propia respuesta del `unidad_medida` terminan discrepando.
                    const esPesable = p.esPesable;
                    let cardClass = "pos-product-card";
                    if (enTicket) cardClass += " en-carrito";
                    else if (stockMilli <= 5 * QTY_SCALE) cardClass += " stock-bajo";
                    return (
                      <div key={p.id} className={cardClass} onClick={() => agregarProducto(p)}>
                        {enTicket && <span className="badge-cart-qty">{formatCantidad(enTicket.qtyMilli, { unidad: p.unidadMedida })}</span>}
                        <div className="icon-product">
                          {p.imagen ? <img src={p.imagen} alt={p.nombre} /> : <i className="fa-solid fa-cube"></i>}
                        </div>
                        <div className="name">{p.nombre}</div>
                        <div className="price">{formatCentavos(p.precioCentavos)}</div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:"4px"}}>
                          <div className="stock" style={{color:stockMilli <= 5 * QTY_SCALE ? "var(--kanagawa-orange)" : "var(--kanagawa-green)"}}>
                            {formatCantidad(stockMilli, { unidad: p.unidadMedida })}
                          </div>
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
                        <div className="price" style={{color:"var(--kanagawa-comment)"}}>{formatCentavos(p.precioCentavos)}</div>
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
              // El subtotal de la línea se calcula con la MISMA función que el total del ticket y
              // que el repo usa al escribir. La web hacía `parseFloat(item.precio) * item.qty` y
              // después `toFixed(2)` para mostrar: si tres líneas de $33,33 dan $99,99, la línea
              // mostraba un centavo que el total no tenía.
              const subtotalCentavos = lineTotalCentavos(item.precioCentavos, item.qtyMilli);
              return (
                <div key={item.id} className="cart-item">
                  <div className="item-info">
                    <div className="details">
                      <p className="name">{item.nombre}</p>
                      {item.pesado ? (
                        <p className="unit" style={{color:"var(--kanagawa-blue)"}}>
                          {formatCantidad(item.qtyMilli, { unidad: item.unidadMedida || "kg" })}
                        </p>
                      ) : (
                        <p className="unit">{formatCentavos(item.precioCentavos)} x {item.unidadMedida || "unidad"}</p>
                      )}
                    </div>
                    {/* Una línea pesada NO tiene control de cantidad: los gramos los puso la
                        balanza y el +/− los cambiaría de a 1 kg, que es exactamente el error que
                        hacía que medio kilo se vendiera como un kilo. Para eso está la balanza. */}
                    {!item.pesado && (
                      <div className="qty-control">
                        <button onClick={() => cambiarQty(item.id, -1)}><i className="fa-solid fa-minus" style={{fontSize:"10px"}}></i></button>
                        <input type="number" min={1} max={Math.floor((item.stockMilli ?? 0) / QTY_SCALE)}
                          value={item.qtyMilli / QTY_SCALE}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10) || 1;
                            const max = Math.floor((item.stockMilli ?? 0) / QTY_SCALE);
                            if (v > max) { showToast("Stock insuficiente", "warn"); return; }
                            setTicket((prev) => prev.map((i) => i.id === item.id ? { ...i, qtyMilli: v * QTY_SCALE } : i));
                          }}
                          onBlur={(e) => {
                            if (!e.target.value || parseInt(e.target.value, 10) < 1) {
                              setTicket((prev) => prev.map((i) => i.id === item.id ? { ...i, qtyMilli: QTY_SCALE } : i));
                            }
                          }}
                        />
                        <button onClick={() => cambiarQty(item.id, +1)}><i className="fa-solid fa-plus" style={{fontSize:"10px"}}></i></button>
                      </div>
                    )}
                  </div>
                  <span className="item-total">{formatCentavos(subtotalCentavos)}</span>
                  <button className="remove-btn" onClick={() => quitarItem(item.id)}><i className="fa-solid fa-times"></i></button>
                </div>
              );
            })
          )}
        </div>

        <div className="cart-footer">
          <div style={{display:"flex",justifyContent:"space-between",fontSize:"14px",color:"var(--kanagawa-fg-muted)",marginBottom:"4px"}}>
            <span>Subtotal</span>
            <span>{formatCentavos(totalCentavos)}</span>
          </div>
          <div className="cart-total">
            <span>Total</span>
            <span className="amount">{formatCentavos(totalCentavos)}</span>
          </div>
          <div className="cart-actions">
            {ticket.length > 0 && (
              <button onClick={vaciarTicket} className="btn-secondary">
                <i className="fa-solid fa-trash"></i> Vaciar
              </button>
            )}
            <button onClick={() => ticket.length > 0 && setModalCobro(true)} disabled={ticket.length === 0 || procesando || isSubmitting}
              className="btn-success" style={{gridColumn:ticket.length===0?"1/-1":""}}>
              <i className="fa-solid fa-cash-register"></i> {procesando || isSubmitting ? "Procesando..." : `Cobrar ${formatCentavos(totalCentavos)}`}
            </button>
          </div>
          {/* The hint a cashier actually needs. The shortcut existed nowhere in the UI before this,
              so the only way to learn it was to read the source. */}
          {ticket.length > 0 && !procesando && !isSubmitting && (
            <div className="cart-hint" style={{textAlign:"center",fontSize:"11px",color:"var(--kanagawa-fg-muted)",marginTop:"6px"}}>
              <kbd style={{fontFamily:"inherit",border:"1px solid var(--kanagawa-border-dim)",borderRadius:"4px",padding:"1px 5px"}}>F2</kbd>
              {" "}para cobrar · <kbd style={{fontFamily:"inherit",border:"1px solid var(--kanagawa-border-dim)",borderRadius:"4px",padding:"1px 5px"}}>Esc</kbd>
              {" "}para cerrar
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
