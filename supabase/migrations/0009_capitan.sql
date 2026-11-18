-- Capitán por equipo (el reglamento de fútbol lo pide obligatorio; vale para vóley también).
-- Correr con: node scripts/run-sql.mjs supabase/migrations/0009_capitan.sql
--
-- Un solo capitán por equipo: lo garantiza un índice único parcial.
-- El admin lo cambia con admin_set_capitan, que saca al anterior y pone al
-- nuevo en una sola transacción (o lo saca si se pasa p_jugador_id = null).

begin;

alter table jugadores add column if not exists es_capitan boolean not null default false;

create unique index if not exists jugadores_un_capitan_por_equipo
  on jugadores (equipo_id) where es_capitan;

create or replace function admin_set_capitan(p_equipo_id uuid, p_jugador_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Solo el organizador puede elegir capitán' using errcode = '42501';
  end if;
  if p_jugador_id is not null
     and not exists (select 1 from jugadores where id = p_jugador_id and equipo_id = p_equipo_id) then
    raise exception 'El jugador no es de ese equipo' using errcode = 'P0002';
  end if;

  update jugadores set es_capitan = false where equipo_id = p_equipo_id and es_capitan;
  if p_jugador_id is not null then
    update jugadores set es_capitan = true where id = p_jugador_id;
  end if;
end;
$$;

revoke all on function admin_set_capitan(uuid, uuid) from public;
grant execute on function admin_set_capitan(uuid, uuid) to authenticated;

commit;
