import { supabase } from "@/lib/supabase";
import { computeZonesForCategoria, estanEmpatados } from "@/lib/standings";
import type { Categoria, PartidoRow } from "@/lib/db-types";

/**
 * Cuadro de playoffs para cualquier cantidad de equipos (2 a 16, par o impar).
 *
 * - La fase de grupos ordena a los equipos: 1ºA, 1ºB, 2ºA, 2ºB, 3ºA… (con un
 *   solo grupo, el orden de la tabla).
 * - El cuadro tiene el tamaño de la potencia de 2 que alcanza (10 equipos →
 *   cuadro de 16). Los lugares que sobran son "pases directos" y van a los
 *   mejor ubicados: con 10 equipos, solo los 4 últimos juegan octavos.
 * - Se usa el orden de siembra clásico (1 y 2 en mitades opuestas, así los
 *   dos mejores solo se pueden cruzar en la final).
 * - Cada partido guarda su lugar en la ronda (llave_pos). Los de lugar 2i y
 *   2i+1 alimentan al lugar i de la ronda siguiente. La mitad izquierda del
 *   cuadro son los lugares bajos y la derecha los altos.
 */

export const ROUND_ORDER = ["Octavos", "Cuartos", "Semifinal", "3er puesto", "Final"];

/** Rondas principales (sin 3er puesto) según los partidos que tiene cada una. */
const RONDA_POR_PARTIDOS: Record<number, string> = { 8: "Octavos", 4: "Cuartos", 2: "Semifinal", 1: "Final" };
const PARTIDOS_POR_RONDA: Record<string, number> = { Octavos: 8, Cuartos: 4, Semifinal: 2, Final: 1 };

export const MAX_EQUIPOS_LLAVE = 16;

/** Rondas de un cuadro de `lugares` equipos (potencia de 2), de la primera a la final. */
export function rondasDeLlave(lugares: number): string[] {
  const rondas: string[] = [];
  for (let partidos = lugares / 2; partidos >= 1; partidos /= 2) rondas.push(RONDA_POR_PARTIDOS[partidos]);
  return rondas;
}

/** Cuántos partidos tiene una ronda principal (Octavos 8, Cuartos 4, Semifinal 2, Final 1). */
export function partidosDeRonda(ronda: string): number {
  return PARTIDOS_POR_RONDA[ronda] ?? 1;
}

/** Tamaño del cuadro (potencia de 2) a partir de la primera ronda cargada. */
export function lugaresDesdePartidos(partidos: Pick<PartidoRow, "ronda_eliminatoria">[]): number {
  let max = 1;
  for (const p of partidos) {
    if (p.ronda_eliminatoria && PARTIDOS_POR_RONDA[p.ronda_eliminatoria]) max = Math.max(max, PARTIDOS_POR_RONDA[p.ronda_eliminatoria]);
  }
  return max * 2;
}

/** Orden de siembra clásico: para 8 → [1, 8, 4, 5, 2, 7, 3, 6]. */
export function ordenSiembra(lugares: number): number[] {
  let orden = [1, 2];
  while (orden.length < lugares) {
    const n = orden.length * 2 + 1;
    orden = orden.flatMap((s) => [s, n - s]);
  }
  return orden;
}

function potenciaDe2(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/** true si el partido tiene un ganador claro (distinto en el resultado, o definido por penales). */
export function estaDefinido(p: PartidoRow): boolean {
  if (!p.equipo_visitante_id) return false;
  const rl = p.resultado_local ?? 0;
  const rv = p.resultado_visitante ?? 0;
  if (rl !== rv) return true;
  return p.penales_local !== null && p.penales_visitante !== null && p.penales_local !== p.penales_visitante;
}

export function ganadorDe(p: PartidoRow): string {
  const rl = p.resultado_local ?? 0;
  const rv = p.resultado_visitante ?? 0;
  if (rl !== rv) return rl > rv ? p.equipo_local_id : (p.equipo_visitante_id as string);
  return (p.penales_local ?? 0) > (p.penales_visitante ?? 0) ? p.equipo_local_id : (p.equipo_visitante_id as string);
}

export function perdedorDe(p: PartidoRow): string {
  const g = ganadorDe(p);
  return g === p.equipo_local_id ? (p.equipo_visitante_id as string) : p.equipo_local_id;
}

export interface GenerarCrucesResultado {
  ok: boolean;
  mensaje: string;
}

interface NuevoCruce {
  categoria_id: string;
  ronda_eliminatoria: string;
  llave_pos: number;
  equipo_local_id: string;
  equipo_visitante_id: string | null;
  estado: "programado";
}

/**
 * Arma el cuadro desde la tabla. `porGrupo`: cuántos entran de cada grupo
 * (null = todos). Solo inserta la primera ronda y, para los que pasan directo,
 * su partido de la ronda siguiente (con el rival "a definir").
 */
export async function generarLlave(categoriaId: string, porGrupo: number | null): Promise<GenerarCrucesResultado> {
  if (!supabase) return { ok: false, mensaje: "Supabase no está configurado." };

  const { data: catData } = await supabase.from("categorias").select("*").eq("id", categoriaId).maybeSingle();
  const cat = catData as Categoria | null;
  if (!cat) return { ok: false, mensaje: "Categoría no encontrada." };

  const { data: partidosData } = await supabase.from("partidos").select("*").eq("categoria_id", categoriaId);
  const partidos = (partidosData as PartidoRow[]) ?? [];
  if (partidos.some((p) => p.ronda_eliminatoria)) {
    return { ok: false, mensaje: "Esta categoría ya tiene cuadro. Usá “Actualizar cuadro” o borralo para armarlo de nuevo." };
  }

  const pendientes = partidos.filter((p) => !p.ronda_eliminatoria && p.equipo_visitante_id && p.estado !== "finalizado");
  if (pendientes.length > 0) {
    return { ok: false, mensaje: `Faltan ${pendientes.length} partido(s) de fase de grupos por finalizar.` };
  }

  const { zones } = await computeZonesForCategoria(cat);
  if (zones.length === 0 || zones.every((z) => z.rows.length === 0)) {
    return { ok: false, mensaje: "Todavía no hay equipos en la tabla para armar el cuadro." };
  }

  // Si no entran todos, el último que entra no puede estar empatado con el primero que queda afuera.
  if (porGrupo !== null) {
    for (const zone of zones) {
      if (porGrupo < zone.rows.length && estanEmpatados(zone.rows[porGrupo - 1], zone.rows[porGrupo])) {
        return {
          ok: false,
          mensaje: `${zone.nombre ? `En "${zone.nombre}" hay` : "Hay"} un empate total entre ${zone.rows[porGrupo - 1].team.name} y ${
            zone.rows[porGrupo].team.name
          } (mismos puntos, DG y tarjetas) — hace falta un desempate antes de armar el cuadro.`
        };
      }
    }
  }

  // Ranking: 1ºA, 1ºB, 2ºA, 2ºB… (con un solo grupo, el orden de la tabla).
  const corte = porGrupo ?? Infinity;
  const maxFilas = Math.max(...zones.map((z) => z.rows.length));
  const ranking: string[] = [];
  for (let puesto = 0; puesto < maxFilas && puesto < corte; puesto++) {
    for (const zone of zones) {
      const row = zone.rows[puesto];
      if (row) ranking.push(row.team.id);
    }
  }

  const n = ranking.length;
  if (n < 2) return { ok: false, mensaje: "Hacen falta al menos 2 equipos para armar el cuadro." };
  if (n > MAX_EQUIPOS_LLAVE) return { ok: false, mensaje: `El cuadro admite hasta ${MAX_EQUIPOS_LLAVE} equipos (hay ${n}).` };

  const lugares = potenciaDe2(n);
  const rondas = rondasDeLlave(lugares);
  const orden = ordenSiembra(lugares);
  const equipoDe = (siembra: number) => (siembra <= n ? ranking[siembra - 1] : null);

  const nuevos: NuevoCruce[] = [];
  const directos = new Map<number, string[]>(); // lugar en la 2ª ronda → equipos que llegan directo
  for (let i = 0; i < lugares / 2; i++) {
    const a = equipoDe(orden[2 * i]);
    const b = equipoDe(orden[2 * i + 1]);
    if (a && b) {
      nuevos.push({ categoria_id: categoriaId, ronda_eliminatoria: rondas[0], llave_pos: i, equipo_local_id: a, equipo_visitante_id: b, estado: "programado" });
    } else {
      const pasa = (a ?? b) as string;
      const destino = i >> 1;
      directos.set(destino, [...(directos.get(destino) ?? []), pasa]);
    }
  }
  for (const [pos, equipos] of directos) {
    nuevos.push({
      categoria_id: categoriaId,
      ronda_eliminatoria: rondas[1],
      llave_pos: pos,
      equipo_local_id: equipos[0],
      equipo_visitante_id: equipos[1] ?? null,
      estado: "programado"
    });
  }

  // Se guarda la elección para que la tabla marque bien quién entra.
  await supabase.from("categorias").update({ cantidad_clasifican_por_grupo: porGrupo ?? 99 }).eq("id", categoriaId);

  const { error } = await supabase.from("partidos").insert(nuevos);
  if (error) return { ok: false, mensaje: error.message };
  const libres = lugares - n;
  const directosTxt = libres > 0 ? ` ${libres} ${libres === 1 ? "pasa" : "pasan"} directo a ${rondas[1]}.` : "";
  return { ok: true, mensaje: `Cuadro de ${n} equipos armado: arranca en ${rondas[0]}.${directosTxt}` };
}

/**
 * Hace avanzar el cuadro con los partidos ya terminados: pone a cada ganador
 * en su lugar de la ronda siguiente (creando el partido si hace falta) y arma
 * el 3er puesto cuando terminan las dos semis. No toca partidos que ya tienen
 * a sus dos equipos.
 */
export async function avanzarLlave(categoriaId: string): Promise<GenerarCrucesResultado & { cambios: number }> {
  if (!supabase) return { ok: false, mensaje: "Supabase no está configurado.", cambios: 0 };

  const { data } = await supabase.from("partidos").select("*").eq("categoria_id", categoriaId).not("ronda_eliminatoria", "is", null);
  const elim = (data as PartidoRow[]) ?? [];
  if (elim.length === 0) return { ok: false, mensaje: "Todavía no hay cuadro armado.", cambios: 0 };

  const rondas = rondasDeLlave(lugaresDesdePartidos(elim));
  const enRonda = (ronda: string) => new Map(elim.filter((p) => p.ronda_eliminatoria === ronda).map((p) => [p.llave_pos ?? 0, p]));
  const ganadorListo = (p: PartidoRow | undefined) => (p && p.estado === "finalizado" && estaDefinido(p) ? ganadorDe(p) : null);

  let cambios = 0;
  const empatados: string[] = [];

  for (let r = 0; r < rondas.length - 1; r++) {
    const actual = enRonda(rondas[r]);
    const siguiente = enRonda(rondas[r + 1]);
    for (const p of actual.values()) {
      if (p.estado === "finalizado" && p.equipo_visitante_id && !estaDefinido(p)) empatados.push(`${rondas[r]} ${(p.llave_pos ?? 0) + 1}`);
    }
    for (let j = 0; j < partidosDeRonda(rondas[r + 1]); j++) {
      const ganadores = [ganadorListo(actual.get(2 * j)), ganadorListo(actual.get(2 * j + 1))].filter((g): g is string => Boolean(g));
      if (ganadores.length === 0) continue;
      const existente = siguiente.get(j);
      if (!existente) {
        const { error } = await supabase.from("partidos").insert({
          categoria_id: categoriaId,
          ronda_eliminatoria: rondas[r + 1],
          llave_pos: j,
          equipo_local_id: ganadores[0],
          equipo_visitante_id: ganadores[1] ?? null,
          estado: "programado"
        });
        if (error) return { ok: false, mensaje: error.message, cambios };
        cambios++;
        continue;
      }
      const falta = ganadores.find((g) => g !== existente.equipo_local_id && g !== existente.equipo_visitante_id);
      if (falta && !existente.equipo_visitante_id) {
        const { error } = await supabase.from("partidos").update({ equipo_visitante_id: falta }).eq("id", existente.id);
        if (error) return { ok: false, mensaje: error.message, cambios };
        cambios++;
      }
    }
  }

  // 3er puesto: con las dos semis jugadas.
  const semis = [...enRonda("Semifinal").values()];
  const hayTercero = elim.some((p) => p.ronda_eliminatoria === "3er puesto");
  if (!hayTercero && semis.length === 2 && semis.every((s) => ganadorListo(s))) {
    const perdedores = semis.sort((a, b) => (a.llave_pos ?? 0) - (b.llave_pos ?? 0)).map(perdedorDe);
    const { error } = await supabase.from("partidos").insert({
      categoria_id: categoriaId,
      ronda_eliminatoria: "3er puesto",
      llave_pos: 0,
      equipo_local_id: perdedores[0],
      equipo_visitante_id: perdedores[1],
      estado: "programado"
    });
    if (error) return { ok: false, mensaje: error.message, cambios };
    cambios++;
  }

  const aviso = empatados.length ? ` Empatados sin definir (falta cargar penales): ${empatados.join(", ")}.` : "";
  return { ok: true, mensaje: cambios ? `Cuadro actualizado (${cambios} cambio/s).${aviso}` : `El cuadro ya está al día.${aviso}`, cambios };
}

/** Borra el cuadro entero (solo si ningún partido de playoff empezó). */
export async function borrarLlave(categoriaId: string): Promise<GenerarCrucesResultado> {
  if (!supabase) return { ok: false, mensaje: "Supabase no está configurado." };
  const { data } = await supabase.from("partidos").select("id, estado").eq("categoria_id", categoriaId).not("ronda_eliminatoria", "is", null);
  const elim = (data as Pick<PartidoRow, "id" | "estado">[]) ?? [];
  if (elim.some((p) => p.estado !== "programado")) {
    return { ok: false, mensaje: "No se puede borrar: ya hay partidos de playoff jugados o en juego." };
  }
  const { error } = await supabase.from("partidos").delete().eq("categoria_id", categoriaId).not("ronda_eliminatoria", "is", null);
  if (error) return { ok: false, mensaje: error.message };
  return { ok: true, mensaje: "Cuadro borrado." };
}
