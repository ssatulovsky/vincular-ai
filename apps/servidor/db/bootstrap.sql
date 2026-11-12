-- Preparación de la base de datos. Se ejecuta UNA vez, con un superusuario.
--
--   psql -U postgres -v owner_pass=... -v app_pass=... -v db=vincular -f bootstrap.sql
--
-- vincular_owner  dueño del esquema; solo lo usan las migraciones.
-- vincular_app    lo usa el servidor; sin BYPASSRLS y sin permisos de UPDATE/DELETE en las
--                 tablas inmutables (turnos, planes, auditoría, eventos de riesgo).

CREATE ROLE vincular_owner LOGIN PASSWORD :'owner_pass';
CREATE ROLE vincular_app LOGIN NOBYPASSRLS PASSWORD :'app_pass';

CREATE DATABASE :"db" OWNER vincular_owner ENCODING 'UTF8';
\connect :"db"

REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO vincular_owner;
GRANT USAGE ON SCHEMA public TO vincular_app;

-- pgvector requiere superusuario para instalarse.
CREATE EXTENSION IF NOT EXISTS vector;
