-- Service Desk v4: complaints, customers' machines and AMC contracts for a copier / printer service
-- business, on the workspace's shared data (core).
--
-- Customers are the workspace's (core.parties with the customer role), with their contact and area
-- in core: the same Sharma Traders the CRM knows. Engineers are workspace employees holding this
-- app's engineer role. Access: membership and roles are the workspace's (console, or the Team page
-- here); the whole service team sees and works on every complaint, AMC and machine.

SELECT core.link_app('__APP_SCHEMA__');
SELECT core.declare_role('__APP_SCHEMA__', 'dispatcher', 'Takes complaints and assigns them to engineers');
SELECT core.declare_role('__APP_SCHEMA__', 'engineer', 'Goes on service visits: complaints can be assigned to them, and they close their jobs');

COMMENT ON SCHEMA __APP_SCHEMA__ IS '{
  "description": "Service Desk: service complaints from customers, the engineer assigned to each, customers'' machines, and AMC (annual maintenance) contracts.",
  "guide": "Customers are core.parties (complaints.customer_id); engineers are core.people with this app''s engineer role (the engineers view). A complaint is open (no engineer yet), assigned, or closed (closed_at, resolution, part_used, charge in rupees). Pending = not closed. category groups the problem text (paper jam, toner / drum, print quality, ...); count visits by complaints opened. An AMC is current until end_date; renewed_at set means it was renewed (a new contract follows); ended without renewed_at = lapsed."
}';

-- ---------------------------------------------------------------------------------------------
-- Engineers: workspace employees with the engineer role here
-- ---------------------------------------------------------------------------------------------

CREATE VIEW __APP_SCHEMA__.engineers WITH (security_invoker = true) AS
SELECT p.id, p.name, p.phone, p.title, p.auth_user_id, (p.status = 'active') AS active
FROM core.people p
WHERE EXISTS (
  SELECT 1 FROM core.member_roles r JOIN core.app_members m ON (m.app = r.scope AND m.person_id = r.person_id AND m.status = 'active')
  WHERE r.scope = '__APP_SCHEMA__' AND r.role = 'engineer' AND r.person_id = p.id);
COMMENT ON VIEW __APP_SCHEMA__.engineers IS '{"description": "The service engineers: members of this app with the engineer role (core.people)"}';
REVOKE ALL ON __APP_SCHEMA__.engineers FROM PUBLIC, anon;
GRANT SELECT ON __APP_SCHEMA__.engineers TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Machines, complaints, AMC contracts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE __APP_SCHEMA__.machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES core.parties (id),
  site_id uuid REFERENCES core.sites (id),
  item_id uuid REFERENCES core.items (id),
  model text NOT NULL CHECK (btrim(model) <> ''),
  serial_no text,
  installed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX machines_customer ON __APP_SCHEMA__.machines (customer_id);
COMMENT ON TABLE __APP_SCHEMA__.machines IS '{"description": "A copier or printer installed at a customer, with its serial number; model is as typed, item_id the catalogue model when it matches", "visibility": "everyone_in_app"}';
COMMENT ON COLUMN __APP_SCHEMA__.machines.item_id IS '{"description": "The model in the catalogue (core.items), filled in when the typed model matches one"}';
COMMENT ON COLUMN __APP_SCHEMA__.machines.site_id IS '{"description": "Where it is installed (core.sites); the customer''s main site unless set"}';

-- A typed model ("Canon iR 2525") points at the catalogue item of that name, and a machine sits at
-- the customer's main site unless told otherwise.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.fill_machine() RETURNS trigger
LANGUAGE plpgsql SET search_path = __APP_SCHEMA__, pg_temp AS $$
BEGIN
  IF NEW.item_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.model IS DISTINCT FROM OLD.model) THEN
    NEW.item_id := coalesce((SELECT i.id FROM core.items i WHERE i.name_key = core.normalize_name(NEW.model) AND i.status = 'active' LIMIT 1),
      CASE WHEN TG_OP = 'UPDATE' AND NEW.model IS NOT DISTINCT FROM OLD.model THEN NEW.item_id END);
  END IF;
  IF NEW.site_id IS NULL THEN
    NEW.site_id := (SELECT s.id FROM core.sites s WHERE s.party_id = NEW.customer_id AND s.status = 'active' ORDER BY lower(s.label) = 'main' DESC, s.created_at LIMIT 1);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fill BEFORE INSERT OR UPDATE ON __APP_SCHEMA__.machines FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.fill_machine();

-- What kind of problem, from the words used ("paper jam", "jam ho gaya", "toner khatam"...), so
-- history can say "3 paper jams" however each complaint was typed.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.complaint_category(problem text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN problem ~* '(jam|atak|phas|stuck)' THEN 'paper jam'
    WHEN problem ~* '(toner|cartridge|ink|drum)' THEN 'toner / drum'
    WHEN problem ~* '(line|streak|faint|light print|dark print|smudge|quality|halka|kala)' THEN 'print quality'
    WHEN problem ~* '(scan|network|wifi|wi-fi|ip |email|share|pc se)' THEN 'scan / network'
    WHEN problem ~* '(power|on nahi|start nahi|dead|band|not starting|not turning)' THEN 'not powering on'
    WHEN problem ~* '(error|code|e[0-9]{3}|sc[0-9]{3})' THEN 'error code'
    WHEN problem ~* '(noise|awaaz|sound)' THEN 'noise'
    ELSE 'other'
  END
$$;

CREATE TABLE __APP_SCHEMA__.complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no integer GENERATED BY DEFAULT AS IDENTITY (START WITH 1001) UNIQUE,
  customer_id uuid NOT NULL REFERENCES core.parties (id),
  machine_id uuid REFERENCES __APP_SCHEMA__.machines (id) ON DELETE SET NULL,
  problem text NOT NULL CHECK (btrim(problem) <> ''),
  category text GENERATED ALWAYS AS (__APP_SCHEMA__.complaint_category(problem)) STORED,
  engineer_id uuid REFERENCES core.people (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  closed_at timestamptz,
  resolution text,
  part_used text,
  charge numeric(12, 2) CHECK (charge >= 0),
  -- Notifications are recorded here; actually sending them on WhatsApp needs Meta billing
  engineer_notified_at timestamptz,
  rating_requested_at timestamptz,
  rating integer CHECK (rating BETWEEN 1 AND 5),
  created_via text NOT NULL DEFAULT 'app',
  created_by uuid DEFAULT core.me() REFERENCES core.people (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open') = (engineer_id IS NULL) OR status = 'closed'),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX complaints_pending ON __APP_SCHEMA__.complaints (status, opened_at) WHERE status <> 'closed';
CREATE INDEX complaints_customer ON __APP_SCHEMA__.complaints (customer_id, opened_at DESC);
COMMENT ON TABLE __APP_SCHEMA__.complaints IS '{"description": "A service complaint (a visit): what went wrong with a customer''s machine, the engineer on it, and how it was closed", "visibility": "everyone_in_app"}';
COMMENT ON COLUMN __APP_SCHEMA__.complaints.ticket_no IS '{"description": "The number people use for the complaint, e.g. #1043"}';
COMMENT ON COLUMN __APP_SCHEMA__.complaints.category IS '{"description": "Kind of problem, computed from the problem text", "values": ["paper jam", "toner / drum", "print quality", "scan / network", "not powering on", "error code", "noise", "other"]}';
COMMENT ON COLUMN __APP_SCHEMA__.complaints.status IS '{"description": "open = no engineer yet, assigned, closed", "values": ["open", "assigned", "closed"]}';
COMMENT ON COLUMN __APP_SCHEMA__.complaints.engineer_id IS '{"description": "The engineer on the job (core.people)"}';
COMMENT ON COLUMN __APP_SCHEMA__.complaints.charge IS '{"description": "Amount charged for the visit, in rupees"}';
COMMENT ON COLUMN __APP_SCHEMA__.complaints.rating IS '{"description": "Customer''s rating of the visit, 1 to 5"}';

CREATE TABLE __APP_SCHEMA__.amc_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES core.parties (id),
  machine_id uuid REFERENCES __APP_SCHEMA__.machines (id) ON DELETE SET NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  value numeric(12, 2) NOT NULL CHECK (value >= 0),
  reminder_sent_at timestamptz,
  renewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX amc_contracts_end ON __APP_SCHEMA__.amc_contracts (end_date) WHERE renewed_at IS NULL;
COMMENT ON TABLE __APP_SCHEMA__.amc_contracts IS '{"description": "An annual maintenance contract for a customer''s machine: its period and value in rupees, whether a renewal reminder was marked, and when it was renewed", "visibility": "everyone_in_app"}';
COMMENT ON COLUMN __APP_SCHEMA__.amc_contracts.renewed_at IS '{"description": "Set when the contract was renewed (the next contract is a new row)"}';
COMMENT ON COLUMN __APP_SCHEMA__.amc_contracts.reminder_sent_at IS '{"description": "When it was marked for a renewal reminder (messages to customers go out once WhatsApp sending is switched on)"}';

-- Every change, by anyone, from the app or WhatsApp - drives the live screens and history.
CREATE TABLE __APP_SCHEMA__.activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES core.people (id),
  complaint_id uuid REFERENCES __APP_SCHEMA__.complaints (id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  changes jsonb,
  via text NOT NULL DEFAULT 'app',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_recent ON __APP_SCHEMA__.activity_log (created_at DESC);
COMMENT ON TABLE __APP_SCHEMA__.activity_log IS '{"description": "History of every change to complaints, machines and AMCs: who (actor_id), what, and whether from the app or WhatsApp (via)", "visibility": "everyone_in_app"}';

-- Shared work: every member reads and writes it; nothing is deleted from the app.
ALTER TABLE __APP_SCHEMA__.machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE __APP_SCHEMA__.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE __APP_SCHEMA__.amc_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __APP_SCHEMA__.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_read ON __APP_SCHEMA__.machines FOR SELECT TO authenticated USING (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_insert ON __APP_SCHEMA__.machines FOR INSERT TO authenticated WITH CHECK (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_update ON __APP_SCHEMA__.machines FOR UPDATE TO authenticated USING (core.is_app_member('__APP_SCHEMA__')) WITH CHECK (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_read ON __APP_SCHEMA__.complaints FOR SELECT TO authenticated USING (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_insert ON __APP_SCHEMA__.complaints FOR INSERT TO authenticated WITH CHECK (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_update ON __APP_SCHEMA__.complaints FOR UPDATE TO authenticated USING (core.is_app_member('__APP_SCHEMA__')) WITH CHECK (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_read ON __APP_SCHEMA__.amc_contracts FOR SELECT TO authenticated USING (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_insert ON __APP_SCHEMA__.amc_contracts FOR INSERT TO authenticated WITH CHECK (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_update ON __APP_SCHEMA__.amc_contracts FOR UPDATE TO authenticated USING (core.is_app_member('__APP_SCHEMA__')) WITH CHECK (core.is_app_member('__APP_SCHEMA__'));
CREATE POLICY team_read ON __APP_SCHEMA__.activity_log FOR SELECT TO authenticated USING (core.is_app_member('__APP_SCHEMA__'));

-- ---------------------------------------------------------------------------------------------
-- Triggers: updated_at, activity log
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = __APP_SCHEMA__, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER touch BEFORE UPDATE ON __APP_SCHEMA__.machines FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON __APP_SCHEMA__.complaints FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON __APP_SCHEMA__.amc_contracts FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.touch_updated_at();

-- Definer so the browser needs no INSERT policy on the log; it only ever writes for the row being
-- changed, which the caller's own rules already allowed.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.log_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  new_row jsonb := to_jsonb(NEW);
  diff jsonb := '{}'::jsonb;
  key text;
  act text;
BEGIN
  -- Loading or removing the demo isn't history worth showing
  IF current_setting('app.via', true) IN ('seed', 'demo') THEN
    RETURN NEW;
  END IF;
  FOR key IN SELECT jsonb_object_keys(new_row) LOOP
    CONTINUE WHEN key IN ('updated_at', 'id', 'created_at', 'category', 'created_by', 'item_id', 'site_id');
    IF TG_OP = 'INSERT' OR (old_row -> key) IS DISTINCT FROM (new_row -> key) THEN
      diff := diff || jsonb_build_object(key, jsonb_build_array(old_row -> key, new_row -> key));
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND diff = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  act := CASE
    WHEN TG_OP = 'INSERT' THEN 'created'
    WHEN TG_TABLE_NAME = 'complaints' AND diff ? 'status' THEN new_row ->> 'status'
    ELSE 'updated'
  END;
  INSERT INTO __APP_SCHEMA__.activity_log (actor_id, complaint_id, entity_type, entity_id, action, changes, via)
  VALUES (
    core.me(),
    CASE WHEN TG_TABLE_NAME = 'complaints' THEN NEW.id END,
    rtrim(TG_TABLE_NAME, 's'),
    NEW.id, act, diff,
    coalesce(nullif(current_setting('app.via', true), ''), 'app')
  );
  RETURN NEW;
END $$;

CREATE TRIGGER activity AFTER INSERT OR UPDATE ON __APP_SCHEMA__.machines FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.log_activity();
CREATE TRIGGER activity AFTER INSERT OR UPDATE ON __APP_SCHEMA__.complaints FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.log_activity();
CREATE TRIGGER activity AFTER INSERT OR UPDATE ON __APP_SCHEMA__.amc_contracts FOR EACH ROW EXECUTE FUNCTION __APP_SCHEMA__.log_activity();

-- ---------------------------------------------------------------------------------------------
-- "Today", the signed-in person's session, and saving a customer
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.today() RETURNS date
LANGUAGE sql STABLE SET search_path = __APP_SCHEMA__, pg_temp AS $$
  SELECT (now() AT TIME ZONE coalesce((SELECT o.timezone FROM core.organisation o), 'Asia/Kolkata'))::date
$$;

-- Who they are and what they are here (null = not a member).
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.desk_session() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
  SELECT CASE WHEN roles IS NULL THEN NULL ELSE jsonb_build_object(
    'user_id', auth.uid(), 'person_id', p.id, 'email', p.email, 'name', p.name,
    'role', CASE WHEN 'admin' = ANY (roles) THEN 'admin' ELSE 'user' END, 'roles', to_jsonb(roles),
    'is_engineer', 'engineer' = ANY (roles), 'is_dispatcher', 'dispatcher' = ANY (roles) OR 'admin' = ANY (roles),
    'status', 'active', 'timezone', o.timezone, 'currency', o.currency,
    'business_name', coalesce(o.name, 'Your service business'), 'today', __APP_SCHEMA__.today()
  ) END
  FROM (SELECT core.my_app_roles('__APP_SCHEMA__') AS roles) r
  CROSS JOIN core.organisation o
  LEFT JOIN core.people p ON (p.id = core.me())
$$;

-- The Customers screen's one call: creates the customer in core (or finds the one the workspace
-- already has by that name, making it a customer) when p_party_id isn't a known company,
-- otherwise renames it; sets its area; and keeps its main contact's name and phone. Returns its id.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.save_customer(p_party_id uuid, p_name text, p_area text DEFAULT NULL, p_contact_person text DEFAULT NULL, p_phone text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  party core.parties;
  created_id uuid;
  area uuid;
  contact core.contacts;
  changes jsonb := '{}'::jsonb;
BEGIN
  IF NOT core.is_app_member('__APP_SCHEMA__') THEN
    RAISE EXCEPTION 'You don''t have access to Service Desk.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(coalesce(p_name, '')), '') IS NULL THEN RAISE EXCEPTION 'A customer needs a name.'; END IF;
  IF nullif(btrim(coalesce(p_area, '')), '') IS NOT NULL THEN
    area := (core.create_area(btrim(p_area), (SELECT a.id FROM core.areas a WHERE a.kind = 'city' AND a.status = 'active' ORDER BY a.created_at LIMIT 1), 'area', '__APP_SCHEMA__') ->> 'area_id')::uuid;
  END IF;

  SELECT * INTO party FROM core.parties p WHERE p.id = p_party_id;
  IF party.id IS NULL THEN
    created_id := (core.create_party(btrim(p_name), ARRAY['customer'], p_area_id => area, p_app => '__APP_SCHEMA__') ->> 'party_id')::uuid;
    SELECT * INTO party FROM core.parties p WHERE p.id = created_id;
  END IF;
  -- Someone the workspace knew as a prospect or vendor is now also a customer
  PERFORM core.set_party_role(party.id, 'customer', true, '__APP_SCHEMA__');
  IF btrim(p_name) <> party.name THEN changes := changes || jsonb_build_object('name', btrim(p_name)); END IF;
  IF area IS DISTINCT FROM party.area_id AND (area IS NOT NULL OR p_area IS NOT NULL) THEN changes := changes || jsonb_build_object('area_id', area); END IF;
  IF changes <> '{}'::jsonb THEN PERFORM core.update_party(party.id, changes, '__APP_SCHEMA__'); END IF;

  IF nullif(btrim(coalesce(p_contact_person, '')), '') IS NOT NULL OR nullif(btrim(coalesce(p_phone, '')), '') IS NOT NULL THEN
    SELECT * INTO contact FROM core.contacts c WHERE c.party_id = party.id AND c.status = 'active' ORDER BY c.is_primary DESC, c.created_at LIMIT 1;
    IF contact.id IS NULL THEN
      PERFORM core.create_contact(coalesce(nullif(btrim(p_contact_person), ''), btrim(p_name)), nullif(btrim(p_phone), ''), party.id, p_is_primary => true, p_app => '__APP_SCHEMA__');
    ELSE
      PERFORM core.update_contact(contact.id, jsonb_strip_nulls(jsonb_build_object(
        'name', CASE WHEN nullif(btrim(p_contact_person), '') IS DISTINCT FROM contact.name THEN nullif(btrim(p_contact_person), '') END,
        'phone', CASE WHEN core.normalize_phone(p_phone) IS DISTINCT FROM contact.phone_key THEN nullif(btrim(p_phone), '') END)), '__APP_SCHEMA__');
    END IF;
  END IF;
  RETURN party.id;
END $$;

-- The customer list the screens show: core's customers with their area and main contact.
CREATE VIEW __APP_SCHEMA__.customer_list WITH (security_invoker = true) AS
SELECT p.id, p.name, a.name AS area, c.name AS contact_person, coalesce(c.phone, p.phone) AS phone
FROM core.parties p
LEFT JOIN core.areas a ON (a.id = p.area_id)
LEFT JOIN LATERAL (SELECT ct.name, ct.phone FROM core.contacts ct WHERE ct.party_id = p.id AND ct.status = 'active' ORDER BY ct.is_primary DESC, ct.created_at LIMIT 1) c ON true
WHERE p.status = 'active' AND EXISTS (SELECT 1 FROM core.party_roles r WHERE r.party_id = p.id AND r.role = 'customer');
COMMENT ON VIEW __APP_SCHEMA__.customer_list IS '{"description": "Customers (core.parties with the customer role) with their area and main contact person and phone"}';
REVOKE ALL ON __APP_SCHEMA__.customer_list FROM PUBLIC, anon;
GRANT SELECT ON __APP_SCHEMA__.customer_list TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.desk_session() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.log_activity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.fill_machine() FROM PUBLIC, anon, authenticated;
