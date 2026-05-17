CREATE TABLE agent_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_agent_id UUID NOT NULL REFERENCES repid_agents(id),
  service_type TEXT NOT NULL REFERENCES service_categories(category_name),
  service_name TEXT NOT NULL,
  description TEXT,
  base_price_usdc_raw BIGINT NOT NULL CHECK (base_price_usdc_raw > 0),
  min_repid_to_purchase INTEGER DEFAULT 500 CHECK (min_repid_to_purchase >= 0),
  capability_metadata JSONB DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  total_fulfilled BIGINT NOT NULL DEFAULT 0,
  total_satisfied BIGINT NOT NULL DEFAULT 0,
  avg_satisfaction NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ
);

CREATE INDEX idx_agent_services_type_active ON agent_services(service_type, active) WHERE active = true;
CREATE INDEX idx_agent_services_provider ON agent_services(provider_agent_id);
CREATE INDEX idx_agent_services_price ON agent_services(service_type, base_price_usdc_raw) WHERE active = true;

CREATE OR REPLACE FUNCTION update_agent_services_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  IF OLD.active = TRUE AND NEW.active = FALSE THEN
    NEW.deactivated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_services_updated_at BEFORE UPDATE ON agent_services FOR EACH ROW EXECUTE FUNCTION update_agent_services_updated_at();

CREATE OR REPLACE FUNCTION enforce_service_price_band() RETURNS TRIGGER AS $$
DECLARE
  cat_floor BIGINT;
  cat_ceiling BIGINT;
BEGIN
  SELECT base_price_floor_usdc_raw, base_price_ceiling_usdc_raw INTO cat_floor, cat_ceiling
  FROM service_categories WHERE category_name = NEW.service_type;

  IF NEW.base_price_usdc_raw < cat_floor THEN
    RAISE EXCEPTION 'Service price % below floor % for category %', NEW.base_price_usdc_raw, cat_floor, NEW.service_type;
  END IF;

  IF cat_ceiling IS NOT NULL AND NEW.base_price_usdc_raw > cat_ceiling THEN
    RAISE EXCEPTION 'Service price % above ceiling % for category %', NEW.base_price_usdc_raw, cat_ceiling, NEW.service_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_service_price_band BEFORE INSERT OR UPDATE ON agent_services FOR EACH ROW EXECUTE FUNCTION enforce_service_price_band();
