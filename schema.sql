-- =============================================================================
-- AcoWaste — Full schema, derived from lib/screens/auth/register_screen.dart,
-- login_screen.dart, and the WasteDetectionScreen / CoordinatorDashboardScreen
-- navigation targets.
--
-- Naming matches the Dart code 1:1:
--   register_screen.dart -> ApiService.register(name, email, password, role, phone, vehicleReg)
--   login_screen.dart    -> ApiService.login(email, password) -> user['role']
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS "public";

-- -----------------------------------------------------------------------------
-- USERS
-- One table for all three roles (user / collector / coordinator), matching
-- the _Role enum in register_screen.dart and the role-based routing in
-- login_screen.dart.
-- -----------------------------------------------------------------------------
CREATE TABLE "users" (
    "id"              SERIAL PRIMARY KEY,
    "name"            VARCHAR(120)  NOT NULL,                 -- _nameCtrl
    "email"           VARCHAR(160)  NOT NULL,                 -- _emailCtrl (login identifier)
    "password_hash"   VARCHAR(255)  NOT NULL,                 -- bcrypt hash of _passCtrl
    "role"            VARCHAR(20)   NOT NULL DEFAULT 'user',  -- _roleValue: user | collector | coordinator
    "phone"           VARCHAR(30),                            -- _phoneCtrl (optional)
    "vehicle_reg"     VARCHAR(30),                            -- _vehicleCtrl (collectors only)
    "status"          VARCHAR(20)   DEFAULT 'offline',        -- collector presence: online | idle | offline
    "latitude"        DOUBLE PRECISION,                       -- collector live location
    "longitude"        DOUBLE PRECISION,
    "location_detail" VARCHAR(160),                           -- e.g. ward / street name
    "last_seen"       TIMESTAMPTZ,
    "created_at"      TIMESTAMPTZ   DEFAULT now(),
    "updated_at"      TIMESTAMPTZ   DEFAULT now(),

    CONSTRAINT "users_email_key"    UNIQUE ("email"),
    CONSTRAINT "users_role_check"   CHECK ("role"::text = ANY (ARRAY['user','collector','coordinator']::text[])),
    CONSTRAINT "users_status_check" CHECK ("status"::text = ANY (ARRAY['online','idle','offline']::text[]))
);

CREATE INDEX "idx_users_role"     ON "users" ("role");
CREATE INDEX "idx_users_lat_lng"  ON "users" ("latitude", "longitude");

-- -----------------------------------------------------------------------------
-- SCANS
-- Created by WasteDetectionScreen — an AI scan/detection of waste material,
-- with an estimated weight and collection fee range, plus where it happened.
-- -----------------------------------------------------------------------------
CREATE TABLE "scans" (
    "id"               SERIAL PRIMARY KEY,
    "user_id"          INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
    "label"            VARCHAR(120),         -- e.g. "Plastic Bottles"
    "description"      TEXT,
    "material_input"   TEXT,                 -- raw AI model input/classification text
    "weight_min_kg"    NUMERIC(8,2),
    "weight_max_kg"    NUMERIC(8,2),
    "weight_category"  VARCHAR(20),          -- e.g. light | medium | heavy
    "fee_min_tzs"      NUMERIC(10,2),
    "fee_max_tzs"      NUMERIC(10,2),
    "latitude"         DOUBLE PRECISION,
    "longitude"        DOUBLE PRECISION,
    "created_at"       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX "idx_scans_user" ON "scans" ("user_id");

-- -----------------------------------------------------------------------------
-- PICKUP_REQUESTS
-- Created from a scan; tracked/assigned via CoordinatorDashboardScreen.
-- requester = the "user" role who scanned the waste.
-- collector = the "collector" role who accepts/completes the pickup.
-- -----------------------------------------------------------------------------
CREATE TABLE "pickup_requests" (
    "id"              SERIAL PRIMARY KEY,
    "requester_id"    INTEGER REFERENCES "users"("id") ON DELETE CASCADE,
    "collector_id"    INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
    "scan_id"         INTEGER REFERENCES "scans"("id") ON DELETE SET NULL,
    "status"          VARCHAR(20) DEFAULT 'pending',
    "created_at"      TIMESTAMPTZ DEFAULT now(),
    "updated_at"      TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT "pickup_requests_status_check"
        CHECK ("status"::text = ANY (ARRAY['pending','accepted','completed','cancelled']::text[]))
);

CREATE INDEX "idx_pickup_requests_requester" ON "pickup_requests" ("requester_id");
CREATE INDEX "idx_pickup_requests_collector" ON "pickup_requests" ("collector_id");
CREATE INDEX "idx_pickup_requests_status"    ON "pickup_requests" ("status");

-- -----------------------------------------------------------------------------
-- updated_at auto-touch triggers (users, pickup_requests)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_users_updated_at"
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "trg_pickup_requests_updated_at"
  BEFORE UPDATE ON "pickup_requests"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();