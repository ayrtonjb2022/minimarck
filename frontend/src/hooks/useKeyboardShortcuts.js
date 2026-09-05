import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Hook de atajos de teclado para el Punto de Venta.
 *
 * @param {Object} params
 * @param {Array}    params.cart              - Array de items del ticket
 * @param {Function} params.setCart           - Setter del ticket
 * @param {Function} params.onConfirmSale     - Abre modal de cobro (sin metodo pre-seleccionado)
 * @param {Function} params.onQuickSale       - Abre modal de cobro con metodo pre-seleccionado
 * @param {React.RefObject} params.searchInputRef - Ref del input de busqueda
 * @param {boolean}  params.isModalOpen       - Si hay algun modal abierto
 * @param {Function} params.setIsModalOpen    - Setter de modal abierto
 * @param {Object}   params.searchResults     - Resultados de busqueda (para navegacion)
 * @param {number}   params.selectedSearchIndex - Indice seleccionado en resultados
 * @param {Function} params.setSelectedSearchIndex - Setter
 * @param {Function} params.onSelectSearchResult  - Callback al presionar Enter en un resultado
 * @param {Function} params.onShowShortcuts    - Callback para mostrar ayuda de atajos
 */
export default function useKeyboardShortcuts({
  cart,
  setCart,
  onConfirmSale,
  onQuickSale,
  searchInputRef,
  isModalOpen,
  setIsModalOpen,
  searchResults = [],
  selectedSearchIndex,
  setSelectedSearchIndex,
  onSelectSearchResult,
  onShowShortcuts,
}) {
  const [selectedCartIndex, setSelectedCartIndex] = useState(-1);

  // Detectar touch device — shortcuts no aplican en moviles
  const isTouchDevice =
    typeof window !== "undefined" &&
    ("ontouchstart" in window.navigator || navigator.maxTouchPoints > 0);

  // Guardar referencia del cart length para closures
  const cartRef = useRef(cart);
  cartRef.current = cart;

  const selectedCartIndexRef = useRef(selectedCartIndex);
  selectedCartIndexRef.current = selectedCartIndex;

  const selectedSearchIndexRef = useRef(selectedSearchIndex);
  selectedSearchIndexRef.current = selectedSearchIndex;

  // Ajustar selectedCartIndex cuando cambia el cart
  useEffect(() => {
    if (cart.length === 0) {
      setSelectedCartIndex(-1);
    } else if (selectedCartIndex >= cart.length) {
      setSelectedCartIndex(cart.length - 1);
    }
  }, [cart.length, selectedCartIndex]);

  // Ajustar selectedSearchIndex cuando cambian resultados
  useEffect(() => {
    if (searchResults.length === 0) {
      setSelectedSearchIndex(-1);
    } else if (selectedSearchIndex >= searchResults.length) {
      setSelectedSearchIndex(searchResults.length - 1);
    }
  }, [searchResults.length, selectedSearchIndex, setSelectedSearchIndex]);

  const handler = useCallback(
    (e) => {
      if (isTouchDevice) return;

      const searchInput = searchInputRef?.current;
      const searchFocused = document.activeElement === searchInput;
      const isInputFocused =
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        document.activeElement?.tagName === "SELECT";

      // --- Modal abierto: solo Escape cierra ---
      if (isModalOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setIsModalOpen(false);
        }
        return;
      }

      // --- Search input enfocado ---
      if (searchFocused) {
        if (e.key === "Escape") {
          e.preventDefault();
          searchInput.blur();
          setSelectedSearchIndex(-1);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedSearchIndex((prev) =>
            searchResults.length > 0
              ? Math.min(prev + 1, searchResults.length - 1)
              : 0
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedSearchIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const idx = selectedSearchIndexRef.current;
          if (idx >= 0 && idx < searchResults.length) {
            onSelectSearchResult(searchResults[idx]);
          } else if (searchResults.length > 0) {
            onSelectSearchResult(searchResults[0]);
          }
          return;
        }
        // Si esta enfocado en el input de busqueda, no interceptar otras teclas
        // (dejar escribir libremente)
        return;
      }

      // --- Otro input/textarea/select enfocado: no interceptar ---
      if (isInputFocused) {
        return;
      }

      // --- Atajos generales del POS ---

      // / o Ctrl+F → enfocar busqueda
      if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key === "f")) {
        e.preventDefault();
        searchInputRef?.current?.focus();
        return;
      }

      // F1 o ? → ayuda de atajos
      if (e.key === "F1" || e.key === "?") {
        e.preventDefault();
        onShowShortcuts?.();
        return;
      }

      // Escape → limpiar busqueda si hay texto, si no no hace nada
      if (e.key === "Escape") {
        if (searchInput?.value) {
          // El componente padre maneja setFiltro("")
          // Disparamos un evento custom que puntoDeVenta escucha
          window.dispatchEvent(new CustomEvent("pos:clear-search"));
        }
        return;
      }

      // Navegacion del carrito (solo si hay items)
      const cartLen = cartRef.current.length;
      if (cartLen === 0) return;

      // Arrow Down → seleccionar siguiente item
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedCartIndex((prev) => Math.min(prev + 1, cartLen - 1));
        return;
      }

      // Arrow Up → seleccionar item anterior
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedCartIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      // + o Arrow Right → incrementar cantidad
      if (e.key === "+" || e.key === "ArrowRight") {
        e.preventDefault();
        const idx = selectedCartIndexRef.current;
        if (idx >= 0 && idx < cartLen) {
          const item = cartRef.current[idx];
          if (item && !item.peso) {
            const newQty = item.qty + 1;
            if (newQty <= (item.stock ?? Infinity)) {
              setCart((prev) =>
                prev.map((i) => (i.id === item.id ? { ...i, qty: newQty } : i))
              );
            }
          }
        }
        return;
      }

      // - o Arrow Left → decrementar cantidad
      if (e.key === "-" || e.key === "ArrowLeft") {
        e.preventDefault();
        const idx = selectedCartIndexRef.current;
        if (idx >= 0 && idx < cartLen) {
          const item = cartRef.current[idx];
          if (item && !item.peso) {
            const newQty = item.qty - 1;
            if (newQty <= 0) {
              // Eliminar item
              setCart((prev) => prev.filter((i) => i.id !== item.id));
            } else {
              setCart((prev) =>
                prev.map((i) => (i.id === item.id ? { ...i, qty: newQty } : i))
              );
            }
          }
        }
        return;
      }

      // Delete o Backspace → eliminar item seleccionado
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const idx = selectedCartIndexRef.current;
        if (idx >= 0 && idx < cartLen) {
          const item = cartRef.current[idx];
          if (item) {
            setCart((prev) => prev.filter((i) => i.id !== item.id));
          }
        }
        return;
      }

      // Enter → si hay items en carrito, abrir modal de cobro
      if (e.key === "Enter") {
        e.preventDefault();
        if (cartRef.current.length > 0) {
          onConfirmSale?.();
        }
        return;
      }

      // F2 → venta rapida efectivo
      if (e.key === "F2") {
        e.preventDefault();
        if (cartRef.current.length > 0) {
          onQuickSale?.("efectivo");
        }
        return;
      }

      // F3 → venta rapida tarjeta
      if (e.key === "F3") {
        e.preventDefault();
        if (cartRef.current.length > 0) {
          onQuickSale?.("tarjeta");
        }
        return;
      }
    },
    [
      isTouchDevice,
      isModalOpen,
      searchResults,
      onConfirmSale,
      onQuickSale,
      onShowShortcuts,
      setIsModalOpen,
      setSelectedSearchIndex,
      onSelectSearchResult,
      searchInputRef,
      setCart,
    ]
  );

  useEffect(() => {
    if (isTouchDevice) return;
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handler, isTouchDevice]);

  return {
    shortcutsEnabled: !isTouchDevice,
    selectedCartIndex,
    setSelectedCartIndex,
  };
}
