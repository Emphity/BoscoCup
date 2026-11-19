import { supabase } from "@/lib/supabase";
import type { CanchaRow, Categoria, EquipoRow, GrupoRow } from "@/lib/db-types";

/**
 * Caché en memoria de las tablas que casi no cambian durante el torneo
 * (solo cuando el admin edita). La vista pública las descarga una sola vez
 * por sesión en lugar de volver a pedirlas con cada gol o tarjeta.
 *
 * No hay expiración por tiempo: una tabla se vuelve a pedir solo cuando se
 * invalida, ya sea por un evento realtime de esa misma tabla o porque la
 * pestaña vuelve a primer plano (y pudo haberse perdido algún evento).
 */
export type TablaEstatica = "categorias" | "equipos" | "grupos" | "grupo_equipos" | "canchas";

export const TABLAS_ESTATICAS: TablaEstatica[] = ["categorias", "equipos", "grupos", "grupo_equipos", "canchas"];

export interface GrupoEquipoRow {
  grupo_id: string;
  equipo_id: string;
}

const cache = new Map<TablaEstatica, Promise<unknown[]>>();

function cargar<T>(tabla: TablaEstatica): Promise<T[]> {
  const client = supabase;
  if (!client) return Promise.resolve([]);
  const enCache = cache.get(tabla);
  if (enCache) return enCache as Promise<T[]>;

  const pedido: Promise<T[]> = Promise.resolve(client.from(tabla).select("*")).then(({ data, error }) => {
    // Si falló, no se deja cacheado el vacío: el próximo pedido reintenta.
    if (error && cache.get(tabla) === pedido) cache.delete(tabla);
    return (data as T[] | null) ?? [];
  });
  cache.set(tabla, pedido);
  return pedido;
}

export function invalidarTabla(tabla: TablaEstatica): void {
  cache.delete(tabla);
}

export function invalidarTodo(): void {
  cache.clear();
}

export const getCategorias = () => cargar<Categoria>("categorias");
export const getEquipos = () => cargar<EquipoRow>("equipos");
export const getGrupos = () => cargar<GrupoRow>("grupos");
export const getGrupoEquipos = () => cargar<GrupoEquipoRow>("grupo_equipos");
export const getCanchas = () => cargar<CanchaRow>("canchas");
