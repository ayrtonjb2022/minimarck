import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { contabilidadAPI } from "../api/contabilidad";
import { mensajeDeError } from "../api/ipc";
import { toast } from "react-toastify";
import PanelContable from "./contabilidad/PanelContable";
import Cuentas from "./contabilidad/Cuentas";
import Asientos from "./contabilidad/Asientos";
import Deudas from "./contabilidad/Deudas";

/**
 * Contabilidad — the screen for the ledger the shop has been writing since its first sale.
 *
 * ── WHY THIS SECTION EXISTED AS A HOLE ────────────────────────────────────────────────────────
 *
 * Fifteen `contabilidad.*` operations have been in the frozen contract from the start, and none of
 * them had a handler. Meanwhile `cuentas.repo.js` wrote a balanced journal entry inside every sale,
 * purchase, debtor payment and till movement — so the shop carried a real double-entry ledger that
 * no screen could open, and `App.jsx` listed `/contabilidad` as "son 15 operaciones del contrato y
 * ninguna esta". The data was real and unreachable, which is the same defect as a catalogue with no
 * catalogue screen.
 *
 * ── THE FOUR TABS, AND WHY THEY ARE TABS ──────────────────────────────────────────────────────
 *
 * They are four readings of ONE thing, in the order an owner asks about it:
 *
 *   Panel        where does the shop stand right now
 *   Cuentas      the chart, and whether the ledger balances at all
 *   Libro diario every entry, and the form to write one by hand
 *   Deudas       what the shop owes, and paying it
 *
 * A tab rather than four menu entries because nobody reads the journal without having looked at the
 * panel first, and the panel is what makes a number in the journal worth chasing.
 *
 * ── WHAT LOADS WHEN ───────────────────────────────────────────────────────────────────────────
 *
 * The panel and the balance are read on mount and re-read when the tab that shows them becomes
 * active, because a sale rung up in the POS changes both. The chart is loaded ONCE and passed down,
 * because the entry form needs it to offer accounts and re-reading it per tab would be a second
 * answer to a question that has not changed. `Asientos` and `Deudas` load their own lists: they are
 * paged, they have their own filters, and hoisting that state here would make this file the place
 * every detail of every list lives.
 */

const TABS = [
  { clave: "panel", nombre: "Panel", icono: "fa-gauge-high" },
  { clave: "cuentas", nombre: "Plan de cuentas", icono: "fa-scale-balanced" },
  { clave: "libro", nombre: "Libro diario", icono: "fa-file-invoice-dollar" },
  { clave: "deudas", nombre: "Deudas", icono: "fa-coins" }
];

const Contabilidad = () => {
  // The tab lives in the URL so a reload, a deep link or the back button all land where the
  // operator was. `Reportes` does the same thing for the same reason, and the chapter is that a
  // tab in `useState` is a screen that forgets which report you were reading the moment the window
  // reloads — which on a till happens every time somebody hits F5.
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.clave === params.get("tab")) ? params.get("tab") : "panel";
  const setTab = (clave) => setParams(clave === "panel" ? {} : { tab: clave }, { replace: false });

  const [panel, setPanel] = useState(null);
  const [balance, setBalance] = useState(null);
  const [cuentas, setCuentas] = useState([]);
  const [cargandoPanel, setCargandoPanel] = useState(true);
  const [cargandoBalance, setCargandoBalance] = useState(true);
  const [cargandoCuentas, setCargandoCuentas] = useState(true);

  const cargarPanel = useCallback(async () => {
    setCargandoPanel(true);
    try {
      setPanel(await contabilidadAPI.dashboard());
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo leer el panel contable"));
    } finally {
      setCargandoPanel(false);
    }
  }, []);

  const cargarBalance = useCallback(async () => {
    setCargandoBalance(true);
    try {
      setBalance(await contabilidadAPI.balance());
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo leer el balance"));
    } finally {
      setCargandoBalance(false);
    }
  }, []);

  const cargarCuentas = useCallback(async () => {
    setCargandoCuentas(true);
    try {
      setCuentas((await contabilidadAPI.listarCuentas()) ?? []);
    } catch (err) {
      toast.error(mensajeDeError(err, "No se pudo leer el plan de cuentas"));
    } finally {
      setCargandoCuentas(false);
    }
  }, []);

  // The chart is read once: the entry form needs it, and it changes only if somebody else writes
  // to the database, which on a single-writer local file means another process.
  useEffect(() => {
    cargarCuentas();
  }, [cargarCuentas]);

  // The panel and the balance are re-read when their tab is opened, so a sale rung up in the POS
  // between two visits is reflected. Reading them on mount only would show a stale ledger to the
  // operator who just came from selling.
  useEffect(() => {
    if (tab === "panel") cargarPanel();
    if (tab === "cuentas") {
      cargarBalance();
      cargarCuentas();
    }
  }, [tab, cargarPanel, cargarBalance, cargarCuentas]);

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--kanagawa-fg-muted)", margin: 0 }}>
          El libro lo escriben solos las ventas, las compras, los cobros y los movimientos de caja.
          Acá se lo lee, se cargan los asientos que sólo sabe una persona, y se registran las deudas
          de la tienda.
        </p>
      </div>

      <div className="mm-tabs" role="tablist" aria-label="Secciones de contabilidad">
        {TABS.map((t) => (
          <button
            key={t.clave}
            type="button"
            role="tab"
            aria-selected={tab === t.clave}
            className={`mm-tab ${tab === t.clave ? "activa" : ""}`}
            onClick={() => setTab(t.clave)}
            data-testid={`tab-${t.clave}`}
          >
            <i className={`fa-solid ${t.icono}`} aria-hidden="true"></i> {t.nombre}
            {t.clave === "cuentas" && balance && !balance.cuadra ? (
              <i
                className="fa-solid fa-triangle-exclamation"
                style={{ color: "var(--kanagawa-red)", marginLeft: 6 }}
                title="El libro está descuadrado"
                aria-hidden="true"
              ></i>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "panel" ? <PanelContable datos={panel} cargando={cargandoPanel} /> : null}

      {tab === "cuentas" ? (
        <>
          {/*
            The chart is READ-ONLY here, and that is a decision rather than an omission.
            `createAccount`/`updateAccount`/`deleteAccount` all have handlers and all work, but a
            chart of accounts is the taxonomy every entry is expressed in, and `asegurarPlan`
            guarantees the 24 accounts the sale path posts to by CODE. A screen that let somebody
            rename `1.1.01 Caja` or delete `4.1.01 Ventas` would break sales in a way whose symptom
            (a sale that fails with "cuenta no encontrada") appears nowhere near its cause. The
            operations are reachable from the contract for whoever needs them administratively; the
            everyday screen reads.
          */}
          <Cuentas balance={balance} cargando={cargandoBalance} />
        </>
      ) : null}

      {tab === "libro" ? (
        <Asientos cuentas={cuentas} cargandoCuentas={cargandoCuentas} />
      ) : null}

      {tab === "deudas" ? <Deudas /> : null}
    </div>
  );
};

export default Contabilidad;
