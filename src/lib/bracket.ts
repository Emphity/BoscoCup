import { supabase } from "@/lib/supabase";
import { computeZonesForCategoria, estanEmpatados } from "@/lib/standings";
import type { Categoria, PartidoRow } from "@/lib/db-types";
import type { BracketMatch, StandingRow, Team, ZoneStandings } from "@/types";

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

/**
 * Orden de siembra que evita, si se puede, que en la primera ronda se crucen
 * dos equipos del mismo grupo (con 3 grupos pasa seguido: 1ºB vs 2ºB). Cuando
 * un cruce repite grupo, se intercambia el peor sembrado de ese cruce con el
 * peor sembrado de otro cruce, eligiendo el de siembra más parecida, siempre
 * que ninguno de los dos cruces quede repetido. `grupo(siembra)` es la letra
 * del grupo (null con un solo grupo); las siembras mayores a `n` son pases directos.
 */
export function ordenSinRepetirGrupo(lugares: number, n: number, grupo: (siembra: number) => string | null): number[] {
  const orden = ordenSiembra(lugares);
  const pares = lugares / 2;
  const repite = (i: number) => {
    const a = orden[2 * i];
    const b = orden[2 * i + 1];
    if (a > n || b > n) return false;
    const ga = grupo(a);
    return ga !== null && ga === grupo(b);
  };
  const peor = (i: number) => (orden[2 * i] > orden[2 * i + 1] ? 2 * i : 2 * i + 1);
  for (let i = 0; i < pares; i++) {
    if (!repite(i)) continue;
    const li = peor(i);
    const candidatos = Array.from({ length: pares }, (_, j) => j)
      .filter((j) => j !== i && orden[2 * j] <= n && orden[2 * j + 1] <= n)
      .sort((x, y) => Math.abs(orden[peor(x)] - orden[li]) - Math.abs(orden[peor(y)] - orden[li]));
    for (const j of candidatos) {
      const lj = peor(j);
      [orden[li], orden[lj]] = [orden[lj], orden[li]];
      if (!repite(i) && !repite(j)) break;
      [orden[li], orden[lj]] = [orden[lj], orden[li]];
    }
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

/** Letra del grupo para las etiquetas (Grupo A → A); si no termina en letra, A, B, C por orden. */
export function letraDeZona(nombre: string, i: number): string {
  const m = nombre.trim().match(/([A-Za-z0-9])$/);
  return (m ? m[1] : String.fromCharCode(65 + i)).toUpperCase();
}

export interface Clasificado {
  row: StandingRow;
  /** Puesto en su grupo (1 = primero). */
  puesto: number;
  /** 1ºA, 2ºC… (con un solo grupo: 1º, 2º…). */
  seed: string;
  /** Letra del grupo (null con un solo grupo). */
  grupo: string | null;
}

const prom = (v: number, pj: number) => (pj > 0 ? v / pj : 0);

/**
 * Orden de todos los equipos para el cuadro; sirve con 1, 2 o 3 grupos:
 * primero todos los 1º, después todos los 2º, etc. Dentro de cada puesto
 * manda el rendimiento (promedio de puntos por partido, después promedio de
 * diferencia de gol, tantos en vóley y tarjetas). Así, con 3 grupos el mejor
 * primero queda 1º del cuadro y, si no entran todos los terceros, pasan los
 * mejores terceros. Se usa promedio porque con grupos de distinto tamaño no
 * todos juegan la misma cantidad de partidos.
 */
export function rankingPorPuestos(zones: ZoneStandings[]): Clasificado[] {
  const reales = zones.filter((z) => z.id !== "sin-grupo" && z.rows.length > 0);
  const usadas = reales.length > 0 ? reales : zones.filter((z) => z.rows.length > 0);
  if (usadas.length === 0) return [];
  const out: Clasificado[] = [];
  const maxFilas = Math.max(...usadas.map((z) => z.rows.length));
  for (let puesto = 0; puesto < maxFilas; puesto++) {
    const tier = usadas.flatMap((zone, i) => (zone.rows[puesto] ? [{ zone, i, row: zone.rows[puesto] }] : []));
    tier.sort(
      (a, b) =>
        prom(b.row.points, b.row.played) - prom(a.row.points, a.row.played) ||
        prom(b.row.goalDiff, b.row.played) - prom(a.row.goalDiff, a.row.played) ||
        prom(b.row.tantosDiff ?? 0, b.row.played) - prom(a.row.tantosDiff ?? 0, a.row.played) ||
        prom(a.row.amarillas, a.row.played) - prom(b.row.amarillas, b.row.played) ||
        prom(a.row.rojas, a.row.played) - prom(b.row.rojas, b.row.played) ||
        a.i - b.i
    );
    for (const x of tier) {
      const grupo = usadas.length > 1 ? letraDeZona(x.zone.nombre, x.i) : null;
      out.push({ row: x.row, puesto: puesto + 1, seed: `${puesto + 1}º${grupo ?? ""}`, grupo });
    }
  }
  return out;
}

/** Mismo puesto en su grupo y mismo rendimiento: no hay forma de elegir entre ellos sin desempate. */
function empatadosEntreGrupos(a: Clasificado, b: Clasificado): boolean {
  const pa = a.row.played;
  const pb = b.row.played;
  return (
    a.puesto === b.puesto &&
    prom(a.row.points, pa) === prom(b.row.points, pb) &&
    prom(a.row.goalDiff, pa) === prom(b.row.goalDiff, pb) &&
    prom(a.row.tantosDiff ?? 0, pa) === prom(b.row.tantosDiff ?? 0, pb) &&
    prom(a.row.amarillas, pa) === prom(b.row.amarillas, pb) &&
    prom(a.row.rojas, pa) === prom(b.row.rojas, pb)
  );
}

/**
 * Valor guardado en `cantidad_clasifican_por_grupo` cuando el cuadro arranca
 * en cuartos con los 8 mejores (con 3 grupos: entran los mejores terceros).
 * No marca a nadie en la tabla porque no es "los N primeros de cada grupo".
 */
export const CLASIFICAN_CUARTOS = 98;

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
 * (null = todos; "cuartos" = los 8 mejores según `rankingPorPuestos`, que con
 * 3 grupos son los 1º, los 2º y los 2 mejores 3º). Solo inserta la primera
 * ronda y, para los que pasan directo, su partido de la ronda siguiente (con
 * el rival "a definir").
 */
export async function generarLlave(categoriaId: string, porGrupo: number | null | "cuartos"): Promise<GenerarCrucesResultado> {
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
  if (typeof porGrupo === "number") {
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

  // Ranking: todos los 1º, después los 2º… (dentro de cada puesto, por rendimiento).
  const general = rankingPorPuestos(zones);
  let elegidos: Clasificado[];
  if (porGrupo === "cuartos") {
    elegidos = general.slice(0, EQUIPOS_CUADRO_PROYECTADO);
    const ultimo = elegidos[elegidos.length - 1];
    const afuera = general[EQUIPOS_CUADRO_PROYECTADO];
    if (ultimo && afuera && empatadosEntreGrupos(ultimo, afuera)) {
      return {
        ok: false,
        mensaje: `Empate total por el último lugar de cuartos entre ${ultimo.row.team.name} (${ultimo.seed}) y ${afuera.row.team.name} (${afuera.seed}) — hace falta un desempate antes de armar el cuadro.`
      };
    }
  } else {
    const corte = porGrupo ?? Infinity;
    elegidos = general.filter((c) => c.puesto <= corte);
  }
  const ranking = elegidos.map((c) => c.row.team.id);

  const n = ranking.length;
  if (n < 2) return { ok: false, mensaje: "Hacen falta al menos 2 equipos para armar el cuadro." };
  if (n > MAX_EQUIPOS_LLAVE) return { ok: false, mensaje: `El cuadro admite hasta ${MAX_EQUIPOS_LLAVE} equipos (hay ${n}).` };

  const lugares = potenciaDe2(n);
  const rondas = rondasDeLlave(lugares);
  const orden = ordenSinRepetirGrupo(lugares, n, (s) => elegidos[s - 1]?.grupo ?? null);
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
  await supabase
    .from("categorias")
    .update({ cantidad_clasifican_por_grupo: porGrupo === "cuartos" ? CLASIFICAN_CUARTOS : porGrupo ?? 99 })
    .eq("id", categoriaId);

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

/* ============================================================================
   Cuadro proyectado (vista pública)
   ============================================================================ */

/** La proyección arranca en cuartos: entran los 8 mejores de la tabla. */
export const EQUIPOS_CUADRO_PROYECTADO = 8;

/**
 * Cuadro "si terminara ahora": mientras no se armen los cruces de verdad, se
 * arma con la tabla del momento (que ya cuenta los partidos en juego). Mismo
 * orden que `generarLlave` en modo cuartos (`rankingPorPuestos`): con 2 grupos
 * entran los 4 primeros de cada uno; con 3 grupos, los 1º, los 2º y los 2
 * mejores 3º. Siembra clásica, con pases directos si no llegan a 8.
 */
export function proyectarCuadro(zones: ZoneStandings[], maxEquipos = EQUIPOS_CUADRO_PROYECTADO): BracketMatch[] {
  const ranking = rankingPorPuestos(zones).map((c) => ({ team: c.row.team, seed: c.seed, grupo: c.grupo }));
  const n = Math.min(ranking.length, maxEquipos);
  if (n < 2) return [];

  const lugares = potenciaDe2(n);
  const rondas = rondasDeLlave(lugares);
  const orden = ordenSinRepetirGrupo(lugares, n, (s) => ranking[s - 1]?.grupo ?? null);
  const de = (siembra: number) => (siembra <= n ? ranking[siembra - 1] : null);
  const base = { homeScore: null, awayScore: null, penalesHome: null, penalesAway: null, winnerId: null, pending: true, proyectado: true };

  const out: BracketMatch[] = [];
  const directos = new Map<number, { team: Team; seed: string }[]>();
  for (let i = 0; i < lugares / 2; i++) {
    const a = de(orden[2 * i]);
    const b = de(orden[2 * i + 1]);
    if (a && b) out.push({ ...base, round: rondas[0], pos: i, home: a.team, away: b.team, seedHome: a.seed, seedAway: b.seed });
    else {
      const destino = i >> 1;
      directos.set(destino, [...(directos.get(destino) ?? []), (a ?? b) as { team: Team; seed: string }]);
    }
  }
  for (const [pos, eq] of directos) {
    out.push({ ...base, round: rondas[1], pos, home: eq[0].team, away: eq[1]?.team ?? null, seedHome: eq[0].seed, seedAway: eq[1]?.seed });
  }
  return out;
}

/** Prefijo de los equipos "a definir" del cuadro armado solo con los grupos. */
export const ID_LUGAR_VACIO = "lugar-vacio:";

/**
 * Cuadro "en blanco": antes de que arranque el primer partido de grupos (o con
 * los grupos todavía sin equipos) se muestran solo los cruces por lugar
 * (1ºA vs Mejor 3º…) con "A definir", así todos saben de dónde viene cada uno.
 * `cantidad` es cuántos equipos tiene el grupo; si falta, se reparten los de
 * la categoría en partes iguales. Sin grupos, es una sola tabla (1º, 2º…).
 */
export function cuadroSoloGrupos(grupos: { nombre: string; cantidad?: number }[], totalEquipos: number): BracketMatch[] {
  if (grupos.length === 0) grupos = [{ nombre: "", cantidad: totalEquipos }];
  const ordenados = [...grupos].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const base = Math.floor(totalEquipos / ordenados.length);
  const resto = totalEquipos % ordenados.length;
  const zones: ZoneStandings[] = ordenados.map((g, i) => {
    const letra = letraDeZona(g.nombre, i);
    const cuantos = Math.max(g.cantidad ?? base + (i < resto ? 1 : 0), 1);
    return {
      id: `vacio-${i}`,
      nombre: g.nombre,
      completa: false,
      rows: Array.from({ length: cuantos }, (_, k) => ({
        team: { id: `${ID_LUGAR_VACIO}${k + 1}${letra}`, name: "A definir", shieldColor: "transparent" },
        position: k + 1,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDiff: 0,
        points: 0,
        amarillas: 0,
        rojas: 0,
        qualifies: false,
        empatado: false
      }))
    };
  });
  const cuadro = proyectarCuadro(zones);
  // Si de un puesto no entran todos (con 3 grupos: 2 de los 3 terceros),
  // todavía no se sabe de qué grupo vienen: se rotula "Mejor 3º".
  const enCuadro = new Map<string, number>();
  for (const m of cuadro) for (const s of [m.seedHome, m.seedAway]) if (s) enCuadro.set(s.split("º")[0], (enCuadro.get(s.split("º")[0]) ?? 0) + 1);
  const rotular = (s?: string) => {
    if (!s) return s;
    const puesto = s.split("º")[0];
    return (enCuadro.get(puesto) ?? 0) < ordenados.length ? `Mejor ${puesto}º` : s;
  };
  return cuadro.map((m) => ({ ...m, seedHome: rotular(m.seedHome), seedAway: rotular(m.seedAway) }));
}

/**
 * Hace avanzar el cuadro en pantalla con quien ganó o va ganando: el ganador
 * de un partido terminado (o el que va adelante en uno en juego) aparece en el
 * lugar de la ronda siguiente que todavía está "a definir". No toca la base:
 * es solo lo que se ve, y cambia con cada gol.
 */
export function avanzarEnPantalla(matches: BracketMatch[]): BracketMatch[] {
  const principales = ["Octavos", "Cuartos", "Semifinal", "Final"];
  const out = matches.map((m) => ({ ...m }));
  const enRonda = (ronda: string) => new Map(out.filter((m) => m.round === ronda).map((m, i) => [m.pos ?? i, m]));
  const ganador = (m: BracketMatch | undefined): Team | null => {
    if (!m || !m.winnerId || (m.pending && !m.enVivo)) return null;
    return m.winnerId === m.home.id ? m.home : m.away;
  };
  const primera = principales.findIndex((r) => out.some((m) => m.round === r));
  if (primera < 0) return out;

  for (let r = primera; r < principales.length - 1; r++) {
    const actual = enRonda(principales[r]);
    const siguiente = enRonda(principales[r + 1]);
    for (let j = 0; j < partidosDeRonda(principales[r + 1]); j++) {
      const ga = ganador(actual.get(2 * j));
      const gb = ganador(actual.get(2 * j + 1));
      if (!ga && !gb) continue;
      const existente = siguiente.get(j);
      if (!existente) {
        const home = (ga ?? gb) as Team;
        out.push({
          round: principales[r + 1],
          pos: j,
          home,
          away: ga && gb ? gb : null,
          homeScore: null,
          awayScore: null,
          penalesHome: null,
          penalesAway: null,
          winnerId: null,
          pending: true,
          proyectado: true
        });
        continue;
      }
      if (!existente.away) {
        const falta = [ga, gb].find((t) => t && t.id !== existente.home.id);
        if (falta) {
          existente.away = falta;
          existente.proyectado = true;
        }
      }
    }
  }
  return out;
}
