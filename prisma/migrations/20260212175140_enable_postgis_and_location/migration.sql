-- Railway Postgres does not support PostGIS.
-- This migration replaces the original PostGIS migration (which tried to CREATE EXTENSION postgis)
-- with a no-op, since currentLat/currentLng Decimal columns already exist on DriverProfile
-- and all spatial queries now use Haversine math instead of PostGIS functions.
--
-- No-op: the location geography column and GIST index are no longer used.
SELECT 1;
