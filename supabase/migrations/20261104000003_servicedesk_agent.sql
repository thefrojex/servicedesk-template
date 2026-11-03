-- What the platform's WhatsApp assistant can do in Service Desk. Platform convention: functions
-- named agent_*, SECURITY INVOKER (they run as the person, so RLS applies), each with a JSON
-- comment { description, audience, confirm, params }. agent_whoami() comes from core.link_app (the
-- person's roles here, null for non-members). Writes tag their activity_log rows with via = 'whatsapp'.
--
-- Customers are the workspace's (core.parties): a customer named on WhatsApp is matched against
-- every company the workspace knows (a CRM prospect included), never copied.
--
-- Engineer and customer notifications are recorded (engineer_notified_at, rating_requested_at,
-- reminder_sent_at); sending them as WhatsApp messages needs Meta billing and approved templates.

-- ---------------------------------------------------------------------------------------------
-- Helpers (not agent_*, so the assistant never sees them)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.require_member() RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
BEGIN
  IF NOT core.is_app_member('__APP_SCHEMA__') THEN
    RAISE EXCEPTION 'You don''t have access to Service Desk. Ask the workspace owner to add you.' USING ERRCODE = '42501';
  END IF;
END $$;

-- ₹1,72,000 - Indian digit grouping
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.inr(amount numeric) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN amount IS NULL THEN NULL ELSE '₹' || btrim(to_char(round(amount), 'FM99,99,99,99,999')) END
$$;

-- "2 hours", "3 days"
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.age_text(since timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN now() - since < interval '1 hour' THEN greatest(1, extract(epoch FROM now() - since)::int / 60) || ' min'
    WHEN now() - since < interval '1 day' THEN (extract(epoch FROM now() - since)::int / 3600) || ' hours'
    ELSE (extract(epoch FROM now() - since)::int / 86400) || ' days'
  END
$$;

-- A customer name the way people say it: no case, spacing, punctuation, or "Pvt Ltd"-type words.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.name_key(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(coalesce(core.normalize_name(t), ''), ' ', '')
$$;

-- One customer by name, matched the forgiving way people say names: exact first, then ignoring case
-- / spacing / "Pvt Ltd", then a shortened or longer form ("Sharma" for Sharma Traders, "Om Sai
-- Photostat Centre" for Om Sai Photostat), then the same first word. At each step one match wins
-- and several ask which; null when nothing matches.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.resolve_customer(name text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  q text := __APP_SCHEMA__.name_key(resolve_customer.name);
  first_word text := lower(substring(btrim(resolve_customer.name) FROM '^[^\s]+'));
  tier integer;
  found uuid[];
  names text;
BEGIN
  IF q = '' THEN RETURN NULL; END IF;
  FOR tier IN 1..4 LOOP
    SELECT array_agg(c.id), string_agg(c.name, ', ' ORDER BY c.name) INTO found, names
    FROM core.parties c
    WHERE c.status = 'active' AND CASE tier
      WHEN 1 THEN lower(c.name) = lower(btrim(resolve_customer.name))
      WHEN 2 THEN __APP_SCHEMA__.name_key(c.name) = q
      WHEN 3 THEN length(q) >= 4 AND (__APP_SCHEMA__.name_key(c.name) LIKE '%' || q || '%'
        OR (length(__APP_SCHEMA__.name_key(c.name)) >= 4 AND q LIKE __APP_SCHEMA__.name_key(c.name) || '%'))
      ELSE length(first_word) >= 4 AND lower(substring(c.name FROM '^[^\s]+')) = first_word
    END;
    IF coalesce(array_length(found, 1), 0) = 1 THEN RETURN found[1]; END IF;
    IF coalesce(array_length(found, 1), 0) > 1 THEN
      RAISE EXCEPTION 'Several customers match "%": %. Which one?', resolve_customer.name, names;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- When nothing matched: the closest customer names, for the assistant to offer or pick from.
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.no_such_customer(name text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  q text := __APP_SCHEMA__.name_key(no_such_customer.name);
  closest text;
BEGIN
  SELECT string_agg(x.name, ', ') INTO closest FROM (
    SELECT c.name FROM core.parties c WHERE c.status = 'active'
    ORDER BY (left(__APP_SCHEMA__.name_key(c.name), 2) = left(q, 2)) DESC, (left(__APP_SCHEMA__.name_key(c.name), 1) = left(q, 1)) DESC, c.name
    LIMIT 8) x;
  RAISE EXCEPTION 'There''s no customer called "%" in the workspace. Companies it knows include: %. If they meant one of these, use its exact name; if it really is a new customer, call again with new_customer = true.',
    no_such_customer.name, coalesce(closest, 'none yet');
END $$;

-- An engineer by name or first name ("Ramesh").
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.resolve_engineer(name text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  found uuid[];
  everyone text;
BEGIN
  SELECT array_agg(e.id) INTO found FROM __APP_SCHEMA__.engineers e
  WHERE e.active AND (lower(e.name) = lower(btrim(resolve_engineer.name)) OR e.name ILIKE btrim(resolve_engineer.name) || ' %');
  IF coalesce(array_length(found, 1), 0) = 1 THEN RETURN found[1]; END IF;
  SELECT string_agg(e.name, ', ' ORDER BY e.name) INTO everyone FROM __APP_SCHEMA__.engineers e WHERE e.active;
  IF coalesce(array_length(found, 1), 0) > 1 THEN
    RAISE EXCEPTION 'More than one engineer is called "%" - which one? (%)', resolve_engineer.name, everyone;
  END IF;
  RAISE EXCEPTION 'No engineer called "%". Engineers: %.', resolve_engineer.name, coalesce(everyone, 'none yet');
END $$;

-- A pending complaint by ticket number ("1043", "#1043") or customer name (their latest pending one).
CREATE OR REPLACE FUNCTION __APP_SCHEMA__.resolve_pending_complaint(ref text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  digits text := substring(btrim(ref) FROM '^#?([0-9]{3,7})$');
  cust uuid;
  hit uuid;
  n integer;
BEGIN
  IF digits IS NOT NULL THEN
    SELECT id INTO hit FROM __APP_SCHEMA__.complaints WHERE ticket_no = digits::int;
    IF hit IS NULL THEN RAISE EXCEPTION 'No complaint #%.', digits; END IF;
    RETURN hit;
  END IF;
  cust := __APP_SCHEMA__.resolve_customer(ref);
  IF cust IS NULL THEN RAISE EXCEPTION 'No customer called "%".', ref; END IF;
  SELECT count(*) INTO n FROM __APP_SCHEMA__.complaints WHERE customer_id = cust AND status <> 'closed';
  IF n = 0 THEN RAISE EXCEPTION '% has no pending complaint.', (SELECT p.name FROM core.parties p WHERE p.id = cust); END IF;
  SELECT id INTO hit FROM __APP_SCHEMA__.complaints WHERE customer_id = cust AND status <> 'closed' ORDER BY opened_at DESC LIMIT 1;
  RETURN hit;
END $$;

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.complaint_line(c __APP_SCHEMA__.complaints) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
  SELECT jsonb_build_object(
    'ticket', '#' || c.ticket_no,
    'customer', (SELECT p.name FROM core.parties p WHERE p.id = c.customer_id),
    'area', (SELECT a.name FROM core.parties p JOIN core.areas a ON (a.id = p.area_id) WHERE p.id = c.customer_id),
    'machine', (SELECT model FROM __APP_SCHEMA__.machines WHERE id = c.machine_id),
    'problem', c.problem,
    'engineer', (SELECT p.name FROM core.people p WHERE p.id = c.engineer_id),
    'status', c.status,
    'opened', to_char(c.opened_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'),
    'pending_for', CASE WHEN c.status <> 'closed' THEN __APP_SCHEMA__.age_text(c.opened_at) END,
    'closed', to_char(c.closed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'),
    'resolution', c.resolution, 'part_used', c.part_used, 'charge', __APP_SCHEMA__.inr(c.charge)
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Writes (all confirmed by the person first)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_new_complaint(customer text, problem text, machine_model text DEFAULT NULL, engineer text DEFAULT NULL, new_customer boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  cust uuid;
  created_customer boolean := false;
  machine uuid;
  eng uuid;
  c __APP_SCHEMA__.complaints;
  cust_name text;
  model text;
  eng_name text;
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  PERFORM set_config('app.via', 'whatsapp', true);
  IF btrim(coalesce(customer, '')) = '' THEN RAISE EXCEPTION 'Which customer is the complaint from?'; END IF;
  IF btrim(coalesce(problem, '')) = '' THEN RAISE EXCEPTION 'What''s the problem?'; END IF;
  IF engineer IS NOT NULL AND btrim(engineer) <> '' THEN eng := __APP_SCHEMA__.resolve_engineer(engineer); END IF;

  cust := __APP_SCHEMA__.resolve_customer(customer);
  IF cust IS NULL THEN
    -- An unknown name is far more often an existing customer said differently than a new one
    IF NOT coalesce(agent_new_complaint.new_customer, false) THEN PERFORM __APP_SCHEMA__.no_such_customer(customer); END IF;
    cust := (core.create_party(btrim(customer), ARRAY['customer'], p_app => '__APP_SCHEMA__') ->> 'party_id')::uuid;
    created_customer := true;
  END IF;
  -- A company the workspace knew as a prospect becomes a customer with its first complaint
  PERFORM core.set_party_role(cust, 'customer', true, '__APP_SCHEMA__');
  IF btrim(coalesce(machine_model, '')) <> '' THEN
    -- "Canon 2525" is their "Canon iR 2525": the model number (and the brand, if given) is enough
    SELECT m.id INTO machine FROM __APP_SCHEMA__.machines m
    WHERE m.customer_id = cust AND (
      m.model ILIKE '%' || btrim(machine_model) || '%'
      OR (substring(machine_model FROM '[0-9]{3,}') IS NOT NULL
          AND m.model ~ ('(^|[^0-9])' || substring(machine_model FROM '[0-9]{3,}') || '([^0-9]|$)')
          AND (substring(lower(machine_model) FROM '^\s*([a-z]+)') IS NULL OR lower(m.model) LIKE substring(lower(machine_model) FROM '^\s*([a-z]+)') || '%' OR lower(btrim(machine_model)) ~ '^[0-9]')))
    ORDER BY m.installed_on DESC NULLS LAST LIMIT 1;
    IF machine IS NULL THEN
      INSERT INTO __APP_SCHEMA__.machines (customer_id, model) VALUES (cust, btrim(machine_model)) RETURNING id INTO machine;
    END IF;
  ELSIF (SELECT count(*) FROM __APP_SCHEMA__.machines WHERE customer_id = cust) = 1 THEN
    SELECT id INTO machine FROM __APP_SCHEMA__.machines WHERE customer_id = cust;
  END IF;

  INSERT INTO __APP_SCHEMA__.complaints (customer_id, machine_id, problem, engineer_id, status, assigned_at, engineer_notified_at, created_via)
  VALUES (cust, machine, btrim(problem), eng, CASE WHEN eng IS NULL THEN 'open' ELSE 'assigned' END,
    CASE WHEN eng IS NOT NULL THEN now() END, CASE WHEN eng IS NOT NULL THEN now() END, 'whatsapp')
  RETURNING * INTO c;

  SELECT p.name INTO cust_name FROM core.parties p WHERE p.id = cust;
  SELECT m.model INTO model FROM __APP_SCHEMA__.machines m WHERE m.id = machine;
  SELECT p.name INTO eng_name FROM core.people p WHERE p.id = eng;
  RETURN jsonb_build_object('message',
    'Complaint #' || c.ticket_no || ' logged for ' || cust_name || CASE WHEN created_customer THEN ' (new customer)' ELSE '' END
    || coalesce(' - ' || model, '') || ': ' || c.problem || '.'
    || CASE WHEN eng_name IS NOT NULL THEN ' Assigned to ' || eng_name || '.' ELSE ' Not assigned to anyone yet.' END,
    'ticket', c.ticket_no);
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_new_complaint(text, text, text, text, boolean) IS
  '{"description": "Log a new service complaint from a customer, optionally assigning an engineer straight away. Works on an existing customer; creates one only with new_customer = true.", "audience": "team", "confirm": true, "params": {"customer": "Customer / company name", "problem": "What is wrong, in their words (e.g. paper jam)", "machine_model": "Machine model if mentioned, e.g. Canon 2525", "engineer": "Engineer to assign, e.g. Ramesh (optional)", "new_customer": "true only when they say this is a new customer; an unknown name otherwise gets back the closest existing customers"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_assign_complaint(complaint text, engineer text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  target uuid := __APP_SCHEMA__.resolve_pending_complaint(complaint);
  eng uuid := __APP_SCHEMA__.resolve_engineer(engineer);
  c __APP_SCHEMA__.complaints;
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  PERFORM set_config('app.via', 'whatsapp', true);
  UPDATE __APP_SCHEMA__.complaints SET engineer_id = eng, status = 'assigned', assigned_at = now(), engineer_notified_at = now()
  WHERE id = target AND status <> 'closed' RETURNING * INTO c;
  IF c.id IS NULL THEN RAISE EXCEPTION 'That complaint is already closed.'; END IF;
  RETURN jsonb_build_object('message', 'Complaint #' || c.ticket_no || ' (' || (SELECT p.name FROM core.parties p WHERE p.id = c.customer_id) || ') assigned to '
    || (SELECT p.name FROM core.people p WHERE p.id = eng) || '.');
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_assign_complaint(text, text) IS
  '{"description": "Assign (or reassign) a pending complaint to an engineer.", "audience": "team", "confirm": true, "params": {"complaint": "Ticket number (e.g. 1043) or the customer name", "engineer": "Engineer name, e.g. Suresh"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_close_complaint(complaint text, resolution text, part_used text DEFAULT NULL, charge numeric DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  target uuid := __APP_SCHEMA__.resolve_pending_complaint(complaint);
  me_engineer uuid := (SELECT e.id FROM __APP_SCHEMA__.engineers e WHERE e.id = core.me());
  c __APP_SCHEMA__.complaints;
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  PERFORM set_config('app.via', 'whatsapp', true);
  IF btrim(coalesce(resolution, '')) = '' THEN RAISE EXCEPTION 'What was done to fix it?'; END IF;
  IF charge IS NOT NULL AND charge < 0 THEN RAISE EXCEPTION 'The charge can''t be negative.'; END IF;
  UPDATE __APP_SCHEMA__.complaints SET
    status = 'closed', closed_at = now(), resolution = btrim(agent_close_complaint.resolution),
    part_used = nullif(btrim(agent_close_complaint.part_used), ''), charge = agent_close_complaint.charge,
    -- an engineer closing a job that wasn't assigned to anyone takes it
    engineer_id = coalesce(complaints.engineer_id, me_engineer),
    assigned_at = coalesce(complaints.assigned_at, CASE WHEN me_engineer IS NOT NULL THEN now() END),
    rating_requested_at = now()
  WHERE id = target AND status <> 'closed' RETURNING * INTO c;
  IF c.id IS NULL THEN RAISE EXCEPTION 'That complaint is already closed.'; END IF;
  RETURN jsonb_build_object('message',
    'Complaint #' || c.ticket_no || ' (' || (SELECT p.name FROM core.parties p WHERE p.id = c.customer_id) || ') closed: ' || c.resolution
    || coalesce('. Part: ' || c.part_used, '') || coalesce('. Charge: ' || __APP_SCHEMA__.inr(c.charge), '')
    || '. Took ' || __APP_SCHEMA__.age_text(c.opened_at) || ' from complaint to close.');
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_close_complaint(text, text, text, numeric) IS
  '{"description": "Close a complaint once the job is done: what was done, the part used and the charge. Engineers use this from the site.", "audience": "team", "confirm": true, "params": {"complaint": "Ticket number or the customer name (their latest pending complaint)", "resolution": "What was done, e.g. roller change", "part_used": "Part replaced, e.g. pickup roller", "charge": "Amount charged in rupees, e.g. 1200"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_send_amc_reminders(period text DEFAULT 'next_30_days') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  d date := __APP_SCHEMA__.today();
  upto date := CASE lower(coalesce(period, 'next_30_days'))
    WHEN 'this_month' THEN (date_trunc('month', d) + interval '1 month - 1 day')::date
    WHEN 'next_7_days' THEN d + 7
    ELSE d + 30 END;
  include_lapsed boolean := lower(coalesce(period, '')) IN ('lapsed', 'all');
  n integer;
  total numeric;
  names text;
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  PERFORM set_config('app.via', 'whatsapp', true);
  WITH due AS (
    UPDATE __APP_SCHEMA__.amc_contracts a SET reminder_sent_at = now()
    WHERE a.renewed_at IS NULL AND a.reminder_sent_at IS NULL
      AND ((a.end_date BETWEEN d AND upto) OR (include_lapsed AND a.end_date < d AND a.end_date >= d - 60))
    RETURNING a.customer_id, a.value
  )
  SELECT count(*), sum(value), string_agg((SELECT p.name FROM core.parties p WHERE p.id = due.customer_id), ', ') INTO n, total, names FROM due;
  IF n = 0 THEN
    RETURN jsonb_build_object('message', 'No AMCs in that period are waiting for a reminder - they''ve all been marked reminded or renewed.');
  END IF;
  RETURN jsonb_build_object('message', 'Marked ' || n || ' AMCs for a renewal reminder (' || __APP_SCHEMA__.inr(total) || '): ' || names || '.');
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_send_amc_reminders(text) IS
  '{"description": "Mark every AMC ending in the period that has not been reminded or renewed as due a renewal reminder (the reminder messages themselves go out once WhatsApp sending to customers is switched on - say it is marked, not sent).", "audience": "team", "confirm": true, "params": {"period": "next_30_days (default - use it for \"this month\" / \"is mahine\" too), next_7_days, this_month for strictly the rest of the calendar month, or lapsed / all to include contracts that already ran out"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_renew_amc(customer text, new_value numeric DEFAULT NULL, months integer DEFAULT 12) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  cust uuid := __APP_SCHEMA__.resolve_customer(customer);
  a __APP_SCHEMA__.amc_contracts;
  fresh __APP_SCHEMA__.amc_contracts;
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  PERFORM set_config('app.via', 'whatsapp', true);
  IF cust IS NULL THEN RAISE EXCEPTION 'No customer called "%".', customer; END IF;
  SELECT * INTO a FROM __APP_SCHEMA__.amc_contracts WHERE customer_id = cust AND renewed_at IS NULL ORDER BY end_date DESC LIMIT 1;
  IF a.id IS NULL THEN RAISE EXCEPTION '% has no AMC to renew.', (SELECT p.name FROM core.parties p WHERE p.id = cust); END IF;
  UPDATE __APP_SCHEMA__.amc_contracts SET renewed_at = now() WHERE id = a.id;
  INSERT INTO __APP_SCHEMA__.amc_contracts (customer_id, machine_id, start_date, end_date, value)
  VALUES (cust, a.machine_id, greatest(a.end_date + 1, __APP_SCHEMA__.today()), (greatest(a.end_date + 1, __APP_SCHEMA__.today()) + make_interval(months => coalesce(months, 12)))::date - 1, coalesce(new_value, a.value))
  RETURNING * INTO fresh;
  RETURN jsonb_build_object('message', 'AMC renewed for ' || (SELECT p.name FROM core.parties p WHERE p.id = cust) || ': ' || __APP_SCHEMA__.inr(fresh.value)
    || ', till ' || to_char(fresh.end_date, 'DD Mon YYYY') || '.');
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_renew_amc(text, numeric, integer) IS
  '{"description": "Record that a customer renewed their AMC: closes the current contract and starts the next one (same value unless given).", "audience": "team", "confirm": true, "params": {"customer": "Customer name", "new_value": "Renewal value in rupees, if it changed", "months": "Length in months (default 12)"}}';

-- ---------------------------------------------------------------------------------------------
-- Reads (answered straight away)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_pending_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  RETURN jsonb_build_object(
    'pending', (SELECT count(*) FROM __APP_SCHEMA__.complaints WHERE status <> 'closed'),
    'older_than_2_days', (SELECT count(*) FROM __APP_SCHEMA__.complaints WHERE status <> 'closed' AND opened_at < now() - interval '2 days'),
    'not_assigned', (SELECT count(*) FROM __APP_SCHEMA__.complaints WHERE status = 'open'),
    'by_engineer', coalesce((SELECT jsonb_agg(jsonb_build_object('engineer', e.name, 'pending', x.n) ORDER BY x.n DESC)
      FROM (SELECT engineer_id, count(*) AS n FROM __APP_SCHEMA__.complaints WHERE status = 'assigned' GROUP BY engineer_id) x
      JOIN core.people e ON (e.id = x.engineer_id)), '[]'::jsonb),
    'closed_today', (SELECT count(*) FROM __APP_SCHEMA__.complaints WHERE status = 'closed' AND closed_at >= (__APP_SCHEMA__.today()::timestamp AT TIME ZONE 'Asia/Kolkata')),
    'oldest_first', coalesce((SELECT jsonb_agg(__APP_SCHEMA__.complaint_line(c) ORDER BY c.opened_at) FROM __APP_SCHEMA__.complaints c WHERE c.status <> 'closed'), '[]'::jsonb)
  );
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_pending_summary() IS
  '{"description": "Where every open complaint stands: how many are pending, how many are older than two days, how many each engineer has, which are not assigned, closed today, and the list oldest first.", "audience": "team", "confirm": false, "params": {}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_customer_history(customer text, months integer DEFAULT 3) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  cust uuid := __APP_SCHEMA__.resolve_customer(customer);
  since timestamptz := now() - make_interval(months => least(greatest(coalesce(months, 3), 1), 24));
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  IF cust IS NULL THEN RAISE EXCEPTION 'No customer called "%".', customer; END IF;
  RETURN jsonb_build_object(
    'customer', (SELECT p.name FROM core.parties p WHERE p.id = cust),
    'area', (SELECT a.name FROM core.parties p JOIN core.areas a ON (a.id = p.area_id) WHERE p.id = cust),
    'contact', (SELECT jsonb_build_object('name', ct.name, 'phone', ct.phone_key) FROM core.contacts ct WHERE ct.party_id = cust AND ct.status = 'active' ORDER BY ct.is_primary DESC LIMIT 1),
    'machines', (SELECT jsonb_agg(m.model || coalesce(' (' || m.serial_no || ')', '')) FROM __APP_SCHEMA__.machines m WHERE m.customer_id = cust),
    'period_months', least(greatest(coalesce(months, 3), 1), 24),
    'visits', (SELECT count(*) FROM __APP_SCHEMA__.complaints WHERE customer_id = cust AND opened_at >= since),
    'by_problem', coalesce((SELECT jsonb_object_agg(category, n) FROM (SELECT category, count(*) AS n FROM __APP_SCHEMA__.complaints WHERE customer_id = cust AND opened_at >= since GROUP BY category) x), '{}'::jsonb),
    'charged_total', __APP_SCHEMA__.inr((SELECT sum(charge) FROM __APP_SCHEMA__.complaints WHERE customer_id = cust AND opened_at >= since)),
    'complaints', coalesce((SELECT jsonb_agg(__APP_SCHEMA__.complaint_line(c) ORDER BY c.opened_at DESC) FROM __APP_SCHEMA__.complaints c WHERE c.customer_id = cust AND c.opened_at >= since), '[]'::jsonb),
    'amc', (SELECT jsonb_build_object('ends', to_char(a.end_date, 'DD Mon YYYY'), 'value', __APP_SCHEMA__.inr(a.value), 'days_left', a.end_date - __APP_SCHEMA__.today())
            FROM __APP_SCHEMA__.amc_contracts a WHERE a.customer_id = cust AND a.renewed_at IS NULL ORDER BY a.end_date DESC LIMIT 1)
  );
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_customer_history(text, integer) IS
  '{"description": "A customer''s service history: visits in the period, counts by kind of problem (paper jam, toner, print quality...), parts and charges, every complaint, their machines and their AMC.", "audience": "team", "confirm": false, "params": {"customer": "Customer name", "months": "How many months back (default 3)"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_find_complaints(status text DEFAULT 'pending', engineer text DEFAULT NULL, customer text DEFAULT NULL, days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  eng uuid := CASE WHEN btrim(coalesce(engineer, '')) <> '' THEN __APP_SCHEMA__.resolve_engineer(engineer) END;
  cust uuid := CASE WHEN btrim(coalesce(customer, '')) <> '' THEN __APP_SCHEMA__.resolve_customer(customer) END;
  want text := lower(coalesce(status, 'pending'));
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  IF btrim(coalesce(customer, '')) <> '' AND cust IS NULL THEN RAISE EXCEPTION 'No customer called "%".', customer; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(__APP_SCHEMA__.complaint_line(c) ORDER BY c.opened_at DESC)
    FROM (SELECT * FROM __APP_SCHEMA__.complaints c
          WHERE (eng IS NULL OR c.engineer_id = eng) AND (cust IS NULL OR c.customer_id = cust)
            AND CASE want WHEN 'pending' THEN c.status <> 'closed' WHEN 'closed' THEN c.status = 'closed' AND c.closed_at >= now() - make_interval(days => coalesce(days, 30))
                          WHEN 'open' THEN c.status = 'open' WHEN 'assigned' THEN c.status = 'assigned' ELSE c.opened_at >= now() - make_interval(days => coalesce(days, 30)) END
          ORDER BY c.opened_at DESC LIMIT 40) c), '[]'::jsonb);
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_find_complaints(text, text, text, integer) IS
  '{"description": "List complaints by status (pending, open = not assigned, assigned, closed, all), engineer and/or customer - e.g. what Ramesh has pending, or what was closed this week.", "audience": "team", "confirm": false, "params": {"status": "pending (default), open, assigned, closed or all", "engineer": "Engineer name", "customer": "Customer name", "days": "For closed / all: how many days back (default 30)"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_engineer_report(days integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  since timestamptz := (__APP_SCHEMA__.today() - least(greatest(coalesce(days, 0), 0), 90))::timestamp AT TIME ZONE 'Asia/Kolkata';
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  RETURN jsonb_build_object(
    'since', to_char(since AT TIME ZONE 'Asia/Kolkata', 'DD Mon'),
    'engineers', coalesce((SELECT jsonb_agg(row ORDER BY (row ->> 'closed')::int DESC) FROM (
      SELECT jsonb_build_object(
        'engineer', e.name,
        'closed', count(*) FILTER (WHERE c.status = 'closed' AND c.closed_at >= since),
        'pending', count(*) FILTER (WHERE c.status = 'assigned'),
        'collected', __APP_SCHEMA__.inr(coalesce(sum(c.charge) FILTER (WHERE c.status = 'closed' AND c.closed_at >= since), 0)),
        'avg_hours_to_close', round(avg(extract(epoch FROM c.closed_at - c.opened_at) / 3600) FILTER (WHERE c.status = 'closed' AND c.closed_at >= since), 1)
      ) AS row
      FROM __APP_SCHEMA__.engineers e LEFT JOIN __APP_SCHEMA__.complaints c ON (c.engineer_id = e.id)
      WHERE e.active GROUP BY e.id, e.name) x), '[]'::jsonb),
    'collected_total', __APP_SCHEMA__.inr(coalesce((SELECT sum(charge) FROM __APP_SCHEMA__.complaints WHERE status = 'closed' AND closed_at >= since), 0))
  );
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_engineer_report(integer) IS
  '{"description": "How each engineer is doing: jobs closed, still pending, money collected and average hours from complaint to close - for today (days = 0) or the last N days.", "audience": "team", "confirm": false, "params": {"days": "0 for today (default), 7 for the last week, 30 for the month"}}';

CREATE OR REPLACE FUNCTION __APP_SCHEMA__.agent_amc_status(period text DEFAULT 'next_30_days') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = __APP_SCHEMA__, pg_temp AS $$
DECLARE
  d date := __APP_SCHEMA__.today();
  upto date := CASE lower(coalesce(period, 'next_30_days'))
    WHEN 'this_month' THEN (date_trunc('month', d) + interval '1 month - 1 day')::date
    WHEN 'next_7_days' THEN d + 7
    WHEN 'next_90_days' THEN d + 90
    ELSE d + 30 END;
BEGIN
  PERFORM __APP_SCHEMA__.require_member();
  RETURN jsonb_build_object(
    'today', d,
    'expiring', coalesce((SELECT jsonb_agg(jsonb_build_object('customer', cu.name, 'machine', m.model, 'ends', to_char(a.end_date, 'DD Mon'), 'days_left', a.end_date - d,
        'value', __APP_SCHEMA__.inr(a.value), 'reminded', a.reminder_sent_at IS NOT NULL) ORDER BY a.end_date)
      FROM __APP_SCHEMA__.amc_contracts a JOIN core.parties cu ON (cu.id = a.customer_id) LEFT JOIN __APP_SCHEMA__.machines m ON (m.id = a.machine_id)
      WHERE a.renewed_at IS NULL AND a.end_date BETWEEN d AND upto), '[]'::jsonb),
    'expiring_value', __APP_SCHEMA__.inr(coalesce((SELECT sum(value) FROM __APP_SCHEMA__.amc_contracts WHERE renewed_at IS NULL AND end_date BETWEEN d AND upto), 0)),
    'lapsed_not_renewed', coalesce((SELECT jsonb_agg(jsonb_build_object('customer', cu.name, 'ended', to_char(a.end_date, 'DD Mon'), 'days_ago', d - a.end_date, 'value', __APP_SCHEMA__.inr(a.value)) ORDER BY a.end_date DESC)
      FROM __APP_SCHEMA__.amc_contracts a JOIN core.parties cu ON (cu.id = a.customer_id)
      WHERE a.renewed_at IS NULL AND a.end_date < d AND a.end_date >= d - 60), '[]'::jsonb),
    'lapsed_value', __APP_SCHEMA__.inr(coalesce((SELECT sum(value) FROM __APP_SCHEMA__.amc_contracts WHERE renewed_at IS NULL AND end_date < d AND end_date >= d - 60), 0))
  );
END $$;
COMMENT ON FUNCTION __APP_SCHEMA__.agent_amc_status(text) IS
  '{"description": "AMC contracts coming up for renewal in the period (with values and whether reminded) plus ones that already ran out in the last 60 days without renewal - money being lost.", "audience": "team", "confirm": false, "params": {"period": "next_30_days (default - use it for \"this month\" / \"is mahine\" too), next_7_days, next_90_days, or this_month for strictly the rest of the calendar month"}}';

-- Functions are executable by PUBLIC (which includes signed-out visitors) unless revoked.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA __APP_SCHEMA__ FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA __APP_SCHEMA__ TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.log_activity() FROM authenticated;
REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.fill_machine() FROM authenticated;
-- The demo is loaded by the platform (as postgres), never from the app
REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.load_demo() FROM authenticated, service_role;
REVOKE EXECUTE ON FUNCTION __APP_SCHEMA__.unload_demo() FROM authenticated, service_role;
