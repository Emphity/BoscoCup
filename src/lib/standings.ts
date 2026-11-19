import { supabase } from "@/lib/supabase";
import type { StandingRow, Team, ZoneStandings } from "@/types";
import type { Categoria, EquipoRow, GrupoRow, PartidoRow } from "@/lib/db-types";

export function teamFrom(row: EquipoRow): Team {
  return { id: row.id, name: row.nombre, shieldColor: row.color_primario };
}

type Tarjetas = { amarillas: number; rojas: number };

/** Tantos (puntos dentro de los sets) de un partido de vóley, sumando todos sus sets. */
export type TantosPartido = { local: number; visitante: number };

/**
 * Puntos que da un partido de vóley a cada equipo según los sets ganados
 * (al mejor de 3): 2-0 → 3 al ganador y 0 al perdedor; 2-1 → 2 al ganador y
 * 1 al perdedor. Si se cerró igualado (no debería pasar), cuenta como empate.
 */
export function puntosVoley(setsPropios: number, setsRival: number, cat: Categoria): number {
  if (setsPropios === setsRival) return cat.puntos_empate;
  if (setsPropios > setsRival) return setsRival === 0 ? 3 : 2;
  return setsPropios === 0 ? 0 : 1;
}

/**
 * Posiciones de un conjunto de equipos a partir de sus partidos finalizados.
 * Fútbol: victoria/empate/derrota según los puntos de la categoría; vóley:
 * según los sets (ver `puntosVoley`). Orden de desempate (de mayor a menor
 * prioridad): puntos, diferencia de gol (en vóley, de sets), en vóley
 * diferencia de tantos, tarjetas amarillas (menos es mejor), tarjetas rojas
 * (menos es mejor). Los partidos de fase eliminatoria (`ronda_eliminatoria`
 * seteado) nunca entran acá — ver `computeZonesForCategoria`.
 */
export function computeStandings(
  equipos: EquipoRow[],
  partidosFinalizados: PartidoRow[],
  cat: Categoria,
  tarjetas: Map<string, Tarjetas> = new Map(),
  completa = false,
  tantos: Map<string, TantosPartido> = new Map()
): StandingRow[] {
  interface Agg {
    pj: number;
    pg: number;
    pe: number;
    pp: number;
    gf: number;
    gc: number;
    pts: number;
    tantosDiff: number;
  }
  const esVoley = cat.deporte === "voley";
  const puntosFutbol = (a: number, b: number) => (a > b ? cat.puntos_victoria : a < b ? cat.puntos_derrota : cat.puntos_empate);
  const agg = new Map<string, Agg>();
  equipos.forEach((e) => agg.set(e.id, { pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, pts: 0, tantosDiff: 0 }));

  for (const p of partidosFinalizados) {
    if (!p.equipo_visitante_id) continue;
    const local = agg.get(p.equipo_local_id);
    const visitante = agg.get(p.equipo_visitante_id);
    if (!local || !visitante) continue;
    const rl = p.resultado_local ?? 0;
    const rv = p.resultado_visitante ?? 0;
    local.pj++;
    visitante.pj++;
    local.gf += rl;
    local.gc += rv;
    visitante.gf += rv;
    visitante.gc += rl;
    if (rl > rv) {
      local.pg++;
      visitante.pp++;
    } else if (rl < rv) {
      visitante.pg++;
      local.pp++;
    } else {
      local.pe++;
      visitante.pe++;
    }
    if (esVoley) {
      local.pts += puntosVoley(rl, rv, cat);
      visitante.pts += puntosVoley(rv, rl, cat);
      const t = tantos.get(p.id);
      if (t) {
        local.tantosDiff += t.local - t.visitante;
        visitante.tantosDiff += t.visitante - t.local;
      }
    } else {
      local.pts += puntosFutbol(rl, rv);
      visitante.pts += puntosFutbol(rv, rl);
    }
  }

  const rows: StandingRow[] = equipos
    .map((e) => {
      const a = agg.get(e.id) as Agg;
      const t = tarjetas.get(e.id) ?? { amarillas: 0, rojas: 0 };
      const points = a.pts;
      return {
        team: teamFrom(e),
        position: 0,
        played: a.pj,
        won: a.pg,
        drawn: a.pe,
        lost: a.pp,
        goalsFor: a.gf,
        goalsAgainst: a.gc,
        goalDiff: a.gf - a.gc,
        tantosDiff: esVoley ? a.tantosDiff : undefined,
        points,
        amarillas: t.amarillas,
        rojas: t.rojas,
        qualifies: false,
        empatado: false
      };
    })
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDiff - a.goalDiff ||
        (b.tantosDiff ?? 0) - (a.tantosDiff ?? 0) ||
        a.amarillas - b.amarillas ||
        a.rojas - b.rojas
    );

  const hayJugados = rows.some((r) => r.played > 0);
  rows.forEach((row, i) => {
    row.position = i + 1;
    // Si entran todos a playoffs no se marca a nadie: la tabla solo ordena el cuadro.
    row.qualifies = hayJugados && cat.cantidad_clasifican_por_grupo < rows.length && i < cat.cantidad_clasifican_por_grupo;
  });

  // El aviso de desempate solo tiene sentido con la zona terminada: antes de
  // eso (o con todos en cero) "empatados" es simplemente "todavía no jugaron".
  if (!completa) return rows;
  for (let i = 0; i < rows.length; i++) {
    if (estanEmpatados(rows[i], rows[i - 1]) || estanEmpatados(rows[i], rows[i + 1])) {
      rows[i].empatado = true;
    }
  }

  return rows;
}

/** Mismos puntos, DG (y tantos en vóley), amarillas y rojas — no hay forma de ordenarlos sin un partido de desempate. */
export function estanEmpatados(a?: StandingRow, b?: StandingRow): boolean {
  if (!a || !b) return false;
  return (
    a.points === b.points &&
    a.goalDiff === b.goalDiff &&
    (a.tantosDiff ?? 0) === (b.tantosDiff ?? 0) &&
    a.amarillas === b.amarillas &&
    a.rojas === b.rojas
  );
}

/**
 * La fase de grupos de una zona terminó cuando no queda ningún partido sin
 * finalizar Y todos los equipos ya se enfrentaron entre sí. Lo segundo evita
 * declarar "terminada" una zona solo porque todavía no se programaron las
 * fechas que faltan.
 */
function zonaCompleta(equipoIds: string[], partidosZona: PartidoRow[]): boolean {
  if (equipoIds.length < 2 || partidosZona.length === 0) return false;
  if (partidosZona.some((p) => p.estado !== "finalizado")) return false;
  const jugados = new Set(
    partidosZona.map((p) => [p.equipo_local_id, p.equipo_visitante_id as string].sort().join("|"))
  );
  for (let i = 0; i < equipoIds.length; i++) {
    for (let j = i + 1; j < equipoIds.length; j++) {
      if (!jugados.has([equipoIds[i], equipoIds[j]].sort().join("|"))) return false;
    }
  }
  return true;
}

export interface ZonasCategoria {
  zones: ZoneStandings[];
  equipos: EquipoRow[];
  partidos: PartidoRow[];
  grupos: GrupoRow[];
  /** Tarjetas de los partidos de grupo finalizados, por equipo. */
  tarjetas: Map<string, Tarjetas>;
  /** Vóley: tantos de cada partido de grupo finalizado, para desempatar. */
  tantos: Map<string, TantosPartido>;
}

/**
 * Zonas tal como se muestran al público (tabla y ficha de equipo): sin las
 * zonas vacías y con un listado extra para los equipos que todavía no tienen
 * grupo, así se ven igual mientras se arman los grupos. Para generar cruces
 * se usan las zonas reales de `computeZonesForCategoria`, nunca estas.
 */
export function zonasParaMostrar({ zones, equipos, partidos, grupos, tarjetas, tantos }: ZonasCategoria, cat: Categoria): ZoneStandings[] {
  if (grupos.length === 0) return zones;
  const asignados = new Set(zones.flatMap((z) => z.rows.map((r) => r.team.id)));
  const sinGrupo = equipos.filter((e) => !asignados.has(e.id)).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const visibles = zones.filter((z) => z.rows.length > 0);
  if (sinGrupo.length === 0) return visibles;
  const ids = new Set(sinGrupo.map((e) => e.id));
  const finalizadosEntreEllos = partidos.filter(
    (p) =>
      !p.ronda_eliminatoria &&
      p.estado === "finalizado" &&
      ids.has(p.equipo_local_id) &&
      !!p.equipo_visitante_id &&
      ids.has(p.equipo_visitante_id)
  );
  return [
    ...visibles,
    {
      id: "sin-grupo",
      nombre: visibles.length > 0 ? "Sin grupo asignado" : "",
      completa: false,
      rows: computeStandings(sinGrupo, finalizadosEntreEllos, cat, tarjetas, false, tantos)
    }
  ];
}

async function tantosPorPartido(partidoIds: string[]): Promise<Map<string, TantosPartido>> {
  const map = new Map<string, TantosPartido>();
  if (!supabase || partidoIds.length === 0) return map;

  const { data } = await supabase
    .from("sets_voley")
    .select("partido_id, puntos_local, puntos_visitante")
    .in("partido_id", partidoIds);

  for (const row of (data as { partido_id: string; puntos_local: number | null; puntos_visitante: number | null }[]) ?? []) {
    const cur = map.get(row.partido_id) ?? { local: 0, visitante: 0 };
    cur.local += row.puntos_local ?? 0;
    cur.visitante += row.puntos_visitante ?? 0;
    map.set(row.partido_id, cur);
  }
  return map;
}

async function cardCountsFor(partidoIds: string[]): Promise<Map<string, Tarjetas>> {
  const map = new Map<string, Tarjetas>();
  if (!supabase || partidoIds.length === 0) return map;

  const { data } = await supabase
    .from("eventos_partido")
    .select("equipo_id, tipo")
    .in("partido_id", partidoIds)
    .eq("anulado", false)
    .in("tipo", ["tarjeta_amarilla", "tarjeta_roja", "doble_amarilla"]);

  for (const row of (data as { equipo_id: string | null; tipo: string }[]) ?? []) {
    if (!row.equipo_id) continue;
    const cur = map.get(row.equipo_id) ?? { amarillas: 0, rojas: 0 };
    if (row.tipo === "tarjeta_amarilla") cur.amarillas++;
    else if (row.tipo === "tarjeta_roja") cur.rojas++;
    else if (row.tipo === "doble_amarilla") {
      // la segunda amarilla implica expulsión: cuenta como amarilla y como roja.
      cur.amarillas++;
      cur.rojas++;
    }
    map.set(row.equipo_id, cur);
  }
  return map;
}

/**
 * Tablas casi estáticas de una categoría, ya filtradas, para que quien las
 * tenga en caché (la vista pública) no las vuelva a pedir. Sin esto se piden
 * a la base, como hace el panel de admin, que necesita ver lo último.
 */
export interface DatosEstaticosCategoria {
  equipos: EquipoRow[];
  grupos: GrupoRow[];
  grupoEquipos: { grupo_id: string; equipo_id: string }[];
}

/**
 * Tabla (por zona si hay grupos cargados) de una categoría. Los partidos de
 * fase eliminatoria se excluyen siempre: una vez que hay cruces generados,
 * esos resultados no deben sumar de nuevo en la tabla de grupos.
 */
export async function computeZonesForCategoria(cat: Categoria, estaticos?: DatosEstaticosCategoria): Promise<ZonasCategoria> {
  if (!supabase) return { zones: [], equipos: [], partidos: [], grupos: [], tarjetas: new Map(), tantos: new Map() };
  const client = supabase;

  const [equipos, partidos, grupos] = await Promise.all([
    estaticos
      ? estaticos.equipos
      : client.from("equipos").select("*").eq("categoria_id", cat.id).then(({ data }) => (data as EquipoRow[]) ?? []),
    client.from("partidos").select("*").eq("categoria_id", cat.id).then(({ data }) => (data as PartidoRow[]) ?? []),
    estaticos
      ? estaticos.grupos
      : client.from("grupos").select("*").eq("categoria_id", cat.id).then(({ data }) => (data as GrupoRow[]) ?? [])
  ]);
  const partidosDeGrupo = partidos.filter((p) => !p.ronda_eliminatoria && p.equipo_visitante_id);
  const finalizadosDeGrupo = partidosDeGrupo.filter((p) => p.estado === "finalizado");
  const idsFinalizados = finalizadosDeGrupo.map((p) => p.id);
  const [tarjetas, tantos] = await Promise.all([
    cardCountsFor(idsFinalizados),
    cat.deporte === "voley" ? tantosPorPartido(idsFinalizados) : Promise.resolve(new Map<string, TantosPartido>())
  ]);

  let zones: ZoneStandings[];
  if (grupos.length > 0) {
    const ge = estaticos
      ? estaticos.grupoEquipos
      : await client
          .from("grupo_equipos")
          .select("*")
          .in(
            "grupo_id",
            grupos.map((g) => g.id)
          )
          .then(({ data }) => (data as { grupo_id: string; equipo_id: string }[]) ?? []);
    zones = [...grupos]
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((g) => {
        const equipoIds = new Set(ge.filter((x) => x.grupo_id === g.id).map((x) => x.equipo_id));
        const equiposZona = equipos.filter((e) => equipoIds.has(e.id));
        // Partido de la zona: el que tiene el grupo cargado, o (si se programó
        // sin grupo) el que enfrenta a dos equipos de esta misma zona.
        const deLaZona = (p: PartidoRow) =>
          p.grupo_id === g.id ||
          (!p.grupo_id && equipoIds.has(p.equipo_local_id) && !!p.equipo_visitante_id && equipoIds.has(p.equipo_visitante_id));
        const partidosZona = partidosDeGrupo.filter(deLaZona);
        const completa = zonaCompleta(equiposZona.map((e) => e.id), partidosZona);
        return {
          id: g.id,
          nombre: g.nombre,
          completa,
          rows: computeStandings(equiposZona, partidosZona.filter((p) => p.estado === "finalizado"), cat, tarjetas, completa, tantos)
        };
      });
  } else {
    const completa = zonaCompleta(equipos.map((e) => e.id), partidosDeGrupo);
    zones = [{ id: "general", nombre: "", completa, rows: computeStandings(equipos, finalizadosDeGrupo, cat, tarjetas, completa, tantos) }];
  }

  return { zones, equipos, partidos, grupos, tarjetas, tantos };
}
