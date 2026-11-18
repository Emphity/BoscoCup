-- Ajustes del reglamento.
-- Correr DESPUÉS de 0009: node scripts/run-sql.mjs supabase/migrations/0010_reglamento.sql
--
-- Fútbol: máximo 10 jugadores por equipo (el mínimo de 7 se avisa en la app).

begin;

create or replace function _tope_plantel_futbol()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_deporte text;
  v_cant int;
begin
  select c.deporte::text into v_deporte
  from equipos e join categorias c on c.id = e.categoria_id
  where e.id = new.equipo_id;

  if v_deporte = 'futbol' then
    select count(*) into v_cant from jugadores where equipo_id = new.equipo_id and id <> new.id;
    if v_cant >= 10 then
      raise exception 'El equipo ya tiene 10 jugadores (máximo del reglamento)' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists jugadores_tope_plantel on jugadores;
create trigger jugadores_tope_plantel
  before insert or update of equipo_id on jugadores
  for each row execute function _tope_plantel_futbol();

commit;
