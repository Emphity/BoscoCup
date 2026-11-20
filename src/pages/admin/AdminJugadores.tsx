import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { categoriaLabel } from "@/lib/labels";
import { AMARILLAS_PARA_SUSPENSION, plantelFutbol } from "@/lib/reglas";
import { fetchTarjetasEquipo, type EstadoTarjetas } from "@/lib/suspensiones";
import type { Categoria, EquipoRow, JugadorRow } from "@/lib/db-types";

const limpiarNombre = (s: string) => s.trim().replace(/\s+/g, " ");

export function AdminJugadores() {
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [categoriaId, setCategoriaId] = useState("");
  const [equipos, setEquipos] = useState<EquipoRow[]>([]);
  const [equipoId, setEquipoId] = useState("");
  const [jugadores, setJugadores] = useState<JugadorRow[]>([]);
  const [tarjetas, setTarjetas] = useState<EstadoTarjetas | null>(null);

  const [nombre, setNombre] = useState("");
  const [editando, setEditando] = useState<{ id: string; nombre: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categoria = categorias.find((c) => c.id === categoriaId);
  const esFutbol = categoria?.deporte === "futbol";
  // Femenino es fútbol 6 (mínimo 6 jugadoras); masculino, fútbol 7.
  const PLANTEL_FUTBOL = plantelFutbol(categoria?.rama);
  const palabra = categoria?.rama === "Femenino" ? "jugadoras" : "jugadores";
  const lleno = esFutbol && jugadores.length >= PLANTEL_FUTBOL.maximo;

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from("categorias")
      .select("*")
      .order("deporte")
      .then(({ data }) => {
        const list = (data as Categoria[]) ?? [];
        setCategorias(list);
        if (list.length > 0) setCategoriaId(list[0].id);
      });
  }, []);

  useEffect(() => {
    if (!supabase || !categoriaId) return;
    supabase
      .from("equipos")
      .select("*")
      .eq("categoria_id", categoriaId)
      .order("nombre")
      .then(({ data }) => {
        const list = (data as EquipoRow[]) ?? [];
        setEquipos(list);
        setEquipoId(list.length > 0 ? list[0].id : "");
      });
  }, [categoriaId]);

  async function loadJugadores(eqId: string) {
    if (!supabase || !eqId) return setJugadores([]);
    const { data } = await supabase.from("jugadores").select("*").eq("equipo_id", eqId).order("nombre");
    setJugadores((data as JugadorRow[]) ?? []);
  }

  useEffect(() => {
    setEditando(null);
    setTarjetas(null);
    loadJugadores(equipoId);
    if (equipoId) fetchTarjetasEquipo(equipoId).then(setTarjetas);
  }, [equipoId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!supabase) return setError("Supabase no está configurado.");
    if (!equipoId) return setError("Elegí un equipo primero.");
    if (lleno) return setError(`El equipo ya tiene ${PLANTEL_FUTBOL.maximo} ${palabra} (máximo del reglamento).`);
    const limpio = limpiarNombre(nombre);
    if (!limpio) return setError("Escribí el nombre y apellido.");
    const { error: err } = await supabase.from("jugadores").insert({ equipo_id: equipoId, nombre: limpio });
    if (err) return setError(err.message);
    setNombre("");
    loadJugadores(equipoId);
  }

  async function onGuardarEdicion() {
    if (!supabase || !editando) return;
    setError(null);
    const { error: err } = await supabase
      .from("jugadores")
      .update({ nombre: limpiarNombre(editando.nombre) })
      .eq("id", editando.id);
    if (err) return setError(err.message);
    setEditando(null);
    loadJugadores(equipoId);
  }

  async function onToggleCapitan(j: JugadorRow) {
    if (!supabase || !equipoId) return;
    setError(null);
    const { error: err } = await supabase.rpc("admin_set_capitan", {
      p_equipo_id: equipoId,
      p_jugador_id: j.es_capitan ? null : j.id
    });
    if (err) return setError(`No se pudo cambiar el capitán: ${err.message}`);
    loadJugadores(equipoId);
  }

  async function onDelete(j: JugadorRow) {
    if (!supabase) return;
    const ok = window.confirm(
      `¿Eliminar a ${j.nombre}?\n\nSus goles y tarjetas ya cargados se conservan en los resultados, pero sin nombre. No se puede deshacer.`
    );
    if (!ok) return;
    setError(null);
    const { error: err } = await supabase.from("jugadores").delete().eq("id", j.id);
    if (err) return setError(`No se pudo eliminar: ${err.message}`);
    loadJugadores(equipoId);
  }

  return (
    <div>
      <h2 className="page-title">Jugadores</h2>

      <div className="form-row" style={{ marginBottom: 20 }}>
        <label className="field">
          <span>Categoría</span>
          <select className="input" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>
                {categoriaLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Equipo</span>
          <select className="input" value={equipoId} onChange={(e) => setEquipoId(e.target.value)}>
            {equipos.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.nombre}
              </option>
            ))}
          </select>
        </label>
      </div>

      <form className="panel form-row" onSubmit={onSubmit}>
        <label className="field">
          <span>Nombre y apellido</span>
          <input
            className="input"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej.: Juan Pérez"
            maxLength={80}
            autoComplete="off"
            required
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!equipoId || lleno}>
          Agregar jugador
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}

      {equipoId && (
        <div className="plantel-status">
          <span className={`plantel-count ${esFutbol && (jugadores.length < PLANTEL_FUTBOL.minimo || lleno) ? "warn" : ""}`}>
            {jugadores.length}
            {esFutbol ? ` / ${PLANTEL_FUTBOL.maximo}` : ""} {esFutbol ? palabra : "jugadores"}
          </span>
          {esFutbol && jugadores.length < PLANTEL_FUTBOL.minimo && (
            <span>
              Faltan {PLANTEL_FUTBOL.minimo - jugadores.length} para el mínimo de {PLANTEL_FUTBOL.minimo}.
            </span>
          )}
          {lleno && <span>Plantel completo (máximo {PLANTEL_FUTBOL.maximo}).</span>}
          {jugadores.length > 0 && !jugadores.some((j) => j.es_capitan) && (
            <span>
              Sin capitán: tocá la <b>C</b> del jugador que lo sea.
            </span>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nombre y apellido</th>
              <th>Tarjetas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jugadores.map((j) => {
              const suspension = tarjetas?.suspendidos.get(j.id);
              const amarillas = tarjetas?.amarillas.get(j.id) ?? 0;
              return editando?.id === j.id ? (
                <tr key={j.id}>
                  <td>
                    <input
                      className="input input-sm"
                      value={editando.nombre}
                      onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                      aria-label="Nombre y apellido"
                      maxLength={80}
                      autoFocus
                    />
                  </td>
                  <td></td>
                  <td className="row-actions">
                    <button className="btn btn-primary btn-sm" onClick={onGuardarEdicion} disabled={!editando.nombre.trim()}>
                      Guardar
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditando(null)}>
                      Cancelar
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={j.id}>
                  <td>
                    <span className="player-cell">
                      <button
                        type="button"
                        className={`captain-toggle ${j.es_capitan ? "on" : ""}`}
                        onClick={() => onToggleCapitan(j)}
                        aria-pressed={j.es_capitan}
                        title={j.es_capitan ? "Es el capitán — tocá para sacarle la cinta" : "Hacer capitán"}
                      >
                        C
                      </button>
                      {j.nombre}
                    </span>
                  </td>
                  <td>
                    {suspension ? (
                      <span className="badge-susp" title="No puede jugar el próximo partido">
                        Suspendido · {suspension.motivo}
                      </span>
                    ) : amarillas > 0 ? (
                      <span className="muted" title={`Con ${AMARILLAS_PARA_SUSPENSION} se suspende un partido`}>
                        <i className="tcard y" /> {amarillas}/{AMARILLAS_PARA_SUSPENSION}
                      </span>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditando({ id: j.id, nombre: j.nombre })}>
                      Editar
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => onDelete(j)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              );
            })}
            {jugadores.length === 0 && (
              <tr>
                <td colSpan={3} className="empty-row">
                  Todavía no hay jugadores en este equipo.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
