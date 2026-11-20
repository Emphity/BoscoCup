import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Si se entra directo a una página interna (link guardado, app instalada,
 * recarga), no hay nada "atrás" y el gesto saca de la web. Esto arma por
 * debajo las páginas de las que se llega normalmente (p. ej. resultados →
 * panel), así "atrás" va subiendo por la app en vez de cerrarla.
 */
export function useBaseDeHistorial(bases: string[]) {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if ((window.history.state?.idx ?? 0) !== 0) return;
    const actual = location.pathname + location.search;
    const previas = bases.filter((b) => b !== location.pathname);
    if (previas.length === 0) return;
    navigate(previas[0], { replace: true });
    for (const b of previas.slice(1)) navigate(b);
    navigate(actual);
    // Solo al entrar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Ventanas que se abren encima de la página (ficha de equipo, hojas del
 * veedor, confirmaciones…) con su propia entrada en el historial: así el
 * botón o gesto de "atrás" del celular las cierra en vez de salir de la web.
 *
 * Se guarda en el `state` de la navegación (no en la URL), y la apertura y el
 * cierre pasan en los clics, no en efectos (StrictMode no los duplica).
 */
export function useCapa(nombre: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const estado = (location.state ?? null) as { capa?: string } | null;
  const abierta = estado?.capa === nombre;

  // Al recargar, el navegador conserva el state pero no lo que mostraba la
  // ventana: se limpia para que no quede un "atrás" que no hace nada.
  useEffect(() => {
    if (abierta) navigate(location.pathname + location.search, { replace: true, state: null });
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function abrir() {
    if (abierta) return;
    navigate(location.pathname + location.search, { state: { ...(estado ?? {}), capa: nombre } });
  }

  /** Cierra desde la pantalla (botón, fondo): saca la entrada que agregó `abrir`. */
  function cerrar() {
    if (abierta) navigate(-1);
  }

  return { abierta, abrir, cerrar };
}
