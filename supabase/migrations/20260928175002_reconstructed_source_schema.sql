-- Reconstructed baseline for the HikkoGPT source schema.
-- The source project had five migrations missing from this repository; this
-- baseline captures its current public schema before the existing chat and
-- auth_security_hardening migrations are applied to a new project.
-- Access grants below are intentionally narrower than the source project's
-- broad default grants; RLS policies preserve the intended application access.

CREATE TYPE public.request_type AS ENUM (
  'delete_title', 'delete_chapter', 'new_chapter', 'ad_request', 'new_title',
  'new_team', 'new_person', 'new_character', 'new_publisher', 'new_card', 'new_chapters'
);
CREATE TYPE public.request_status AS ENUM ('pending', 'approved', 'rejected', 'spam');

CREATE TABLE public.titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  author text,
  description text,
  cover_url text,
  status text NOT NULL DEFAULT 'ongoing',
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT titles_status_check CHECK (status = ANY (ARRAY['ongoing'::text, 'completed'::text]))
);

CREATE TABLE public.genres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.title_genres (
  title_id uuid NOT NULL REFERENCES public.titles(id) ON DELETE CASCADE,
  genre_id uuid NOT NULL REFERENCES public.genres(id) ON DELETE CASCADE,
  PRIMARY KEY (title_id, genre_id)
);

CREATE TABLE public.chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES public.titles(id) ON DELETE CASCADE,
  number numeric NOT NULL,
  name text,
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  description text,
  CONSTRAINT chapters_title_id_number_key UNIQUE (title_id, number)
);

CREATE TABLE public.pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id uuid NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  original_url text,
  page_order integer NOT NULL
);

CREATE TABLE public.chapter_voiceovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id uuid NOT NULL UNIQUE REFERENCES public.chapters(id) ON DELETE CASCADE,
  audio_url text NOT NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  image_url text,
  link_url text NOT NULL,
  link_label text NOT NULL DEFAULT 'Перейти',
  placement text NOT NULL DEFAULT 'between_chapters',
  active boolean NOT NULL DEFAULT true,
  advertiser_name text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type public.request_type NOT NULL,
  requester_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id uuid,
  target_name text,
  payload jsonb DEFAULT '{}'::jsonb,
  status public.request_status NOT NULL DEFAULT 'pending',
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  reject_reason text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  user_agent text,
  turnstile_ok boolean DEFAULT false,
  public_token text,
  submitter_email text,
  conflict boolean DEFAULT false,
  finalized_at timestamptz,
  finalized_error text,
  CONSTRAINT admin_requests_public_token_key UNIQUE (public_token)
);

CREATE TABLE public.ip_rate_limit (
  ip_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);

CREATE TABLE public.rate_limit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  admin_email text,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  resolved_at timestamptz,
  session_id text,
  CONSTRAINT login_challenges_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text]))
);

CREATE TABLE public.user_roles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE public.user_api_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'gemini',
  ciphertext text NOT NULL,
  iv text NOT NULL,
  last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_requests_ip_hash_idx ON public.admin_requests USING btree (ip_hash, created_at DESC);
CREATE INDEX admin_requests_public_token_idx ON public.admin_requests USING btree (public_token);
CREATE INDEX admin_requests_status_created_idx ON public.admin_requests USING btree (status, created_at DESC);
CREATE INDEX admin_requests_type_status_idx ON public.admin_requests USING btree (type, status, created_at DESC);
CREATE INDEX ads_placement_active_idx ON public.ads USING btree (placement, active, created_at DESC);
CREATE INDEX login_challenges_token_idx ON public.login_challenges USING btree (token);
CREATE INDEX login_challenges_user_pending_idx ON public.login_challenges USING btree (user_id, status, created_at DESC);
CREATE INDEX login_challenges_user_session_idx ON public.login_challenges USING btree (user_id, session_id, created_at DESC);
CREATE INDEX rate_limit_log_lookup_idx ON public.rate_limit_log USING btree (key, action, created_at);

-- Function bodies are generated from the source project's live catalog and inserted here.
CREATE OR REPLACE FUNCTION public.apply_admin_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_title_id UUID;
  v_number NUMERIC;
  v_name TEXT;
  v_chapter_id UUID;
  v_attempt INT := 0;
  v_slug TEXT;
  v_new_title_id UUID;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;
  -- Только переход pending → approved (не повторный UPDATE уже approved).
  IF OLD.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  -- Аудит: даже если клиент не прислал resolved_*, заполняем из сессии.
  NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  NEW.resolved_by := COALESCE(NEW.resolved_by, auth.uid());

  IF NEW.type = 'delete_title' AND NEW.target_id IS NOT NULL THEN
    DELETE FROM public.titles WHERE id = NEW.target_id;

  ELSIF NEW.type = 'delete_chapter' AND NEW.target_id IS NOT NULL THEN
    DELETE FROM public.chapters WHERE id = NEW.target_id;

  ELSIF NEW.type = 'new_chapter' AND NEW.target_id IS NOT NULL THEN
    v_title_id := NEW.target_id;

    IF NOT EXISTS (SELECT 1 FROM public.titles WHERE id = v_title_id) THEN
      RAISE EXCEPTION 'new_chapter_missing_title'
        USING HINT = 'Тайтл не найден — возможно, уже удалён';
    END IF;

    BEGIN
      v_number := NULLIF(NEW.payload->>'suggested_number', '')::NUMERIC;
    EXCEPTION WHEN others THEN
      v_number := NULL;
    END;
    IF v_number IS NULL THEN
      SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM public.chapters
      WHERE title_id = v_title_id;
    END IF;
    v_name := NULLIF(NEW.payload->>'name', '');

    IF EXISTS (
      SELECT 1 FROM public.chapters
      WHERE title_id = v_title_id AND number = v_number
    ) THEN
      SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM public.chapters
      WHERE title_id = v_title_id;
    END IF;

    LOOP
      BEGIN
        INSERT INTO public.chapters (title_id, number, name, published)
        VALUES (v_title_id, v_number, v_name, false)
        RETURNING id INTO v_chapter_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_attempt := v_attempt + 1;
        IF v_attempt >= 8 THEN
          RAISE EXCEPTION 'new_chapter_conflict'
            USING HINT = 'Не удалось подобрать свободный номер главы после нескольких попыток';
        END IF;
        SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
        FROM public.chapters
        WHERE title_id = v_title_id;
      END;
    END LOOP;

    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
      || jsonb_build_object(
           'created_chapter_id', v_chapter_id,
           'created_number', v_number
         );

  ELSIF NEW.type = 'new_title' THEN
    -- Анонимная заявка: создаём ЧЕРНОВИК (published=false). Slug из
    -- original_title; занятый slug → conflict=true, owner видит предупреждение.
    v_slug := public.slugify_title(NEW.payload->>'original_title');
    IF v_slug IS NULL THEN
      v_slug := 'title-' || substr(md5(COALESCE(NEW.payload->>'original_title', NEW.id::text)), 1, 8);
    END IF;

    INSERT INTO public.titles (slug, title, author, description, cover_url, status, published)
    VALUES (
      v_slug,
      COALESCE(NULLIF(NEW.payload->>'original_title', ''), 'Без названия'),
      NULLIF(NEW.payload->>'author', ''),
      NULLIF(NEW.payload->>'description', ''),
      NULLIF(NEW.payload->>'cover_url', ''),
      COALESCE(NULLIF(NEW.payload->>'status', ''), 'ongoing'),
      false
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO v_new_title_id;

    IF v_new_title_id IS NULL THEN
      -- 0 строк: slug уже занят существующим тайтлом.
      NEW.conflict := true;
      NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
        || jsonb_build_object('conflict', true, 'conflict_slug', v_slug);
    ELSE
      NEW.conflict := false;
      NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
        || jsonb_build_object(
             'conflict', false,
             'created_title_id', v_new_title_id,
             'created_slug', v_slug
           );
    END IF;
  END IF;
  -- ad_request — без авто-применения (баннер owner создаёт в /admin/ads).

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_ip_rate_limit(p_ip_hash text, p_limit integer, p_window_seconds integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  v_count int;
begin
  insert into public.ip_rate_limit (ip_hash, window_start, count)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
    do update set count = ip_rate_limit.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.check_request_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  recent_count INT;
BEGIN
  IF NEW.requester_id IS NULL THEN
    -- публичные ad_request без uid: лимит по note+payload хешу не делаем жёстко,
    -- считаем все анонимные ad_request за час
    SELECT count(*) INTO recent_count
    FROM public.admin_requests
    WHERE requester_id IS NULL
      AND type = 'ad_request'
      AND created_at > now() - interval '1 hour';
    IF recent_count >= 30 THEN
      RAISE EXCEPTION 'rate_limit_exceeded'
        USING HINT = 'Не более 30 анонимных заявок в час';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO recent_count
  FROM public.admin_requests
  WHERE requester_id = NEW.requester_id
    AND created_at > now() - interval '1 hour';
  IF recent_count >= 10 THEN
    RAISE EXCEPTION 'rate_limit_exceeded'
      USING HINT = 'Не более 10 заявок в час';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_ip_rate_limit()
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  delete from public.ip_rate_limit where window_start < now() - interval '2 days';
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_log()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  DELETE FROM public.rate_limit_log
  WHERE created_at < now() - interval '24 hours';
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_rejected_submissions()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  r record;
begin
  for r in
    select id, public_token
    from public.admin_requests
    where status in ('rejected','spam')
      and resolved_at < now() - interval '90 days'
      and coalesce((payload->>'purged')::boolean, false) = false
  loop
    update public.admin_requests
      set payload = jsonb_build_object('purged', true),
          -- обложка и персональные данные больше не нужны
          submitter_email = null,
          ip_hash = null,
          user_agent = null
      where id = r.id;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_login_challenge(p_token text, p_admin_email text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_ttl_minutes integer DEFAULT 15, p_session_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  sid text;
  cid uuid;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.has_role(uid, 'admin') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RAISE EXCEPTION 'invalid token';
  END IF;

  sid := NULLIF(trim(COALESCE(p_session_id, auth.jwt() ->> 'session_id', '')), '');
  IF sid IS NOT NULL THEN
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE user_id = uid
      AND status = 'pending'
      AND session_id IS NOT DISTINCT FROM sid;
  ELSE
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE user_id = uid AND status = 'pending';
  END IF;

  INSERT INTO public.login_challenges (
    user_id, token, admin_email, user_agent, ip, expires_at, session_id
  ) VALUES (
    uid, p_token, p_admin_email, p_user_agent, p_ip,
    now() + make_interval(mins => GREATEST(1, LEAST(p_ttl_minutes, 60))), sid
  )
  RETURNING id INTO cid;
  RETURN cid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_role(uid uuid, role_to_check text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT (auth.role() = 'service_role' OR auth.uid() = uid)
    AND EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_id = uid
        AND (
          role = role_to_check
          OR (role_to_check = 'admin' AND role = 'owner')
        )
    );
$function$;

CREATE OR REPLACE FUNCTION public.latest_login_challenge_status()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  uid UUID := auth.uid();
  sid TEXT;
  row public.login_challenges%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN 'unauthenticated';
  END IF;

  sid := NULLIF(trim(COALESCE(auth.jwt() ->> 'session_id', '')), '');

  IF sid IS NOT NULL THEN
    SELECT * INTO row
    FROM public.login_challenges
    WHERE user_id = uid
      AND session_id IS NOT DISTINCT FROM sid
    ORDER BY created_at DESC
    LIMIT 1;
  ELSE
    -- Legacy fallback (нет claim): последний challenge пользователя.
    SELECT * INTO row
    FROM public.login_challenges
    WHERE user_id = uid
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF row.status = 'pending' AND row.expires_at < now() THEN
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE id = row.id AND status = 'pending';
    RETURN 'expired';
  END IF;

  -- approved для ЭТОЙ session_id — доступ открыт (не истекает по expires_at).
  -- Новый login = новый session_id = снова pending.
  RETURN row.status;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_login_challenge(p_token text, p_action text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  row public.login_challenges%ROWTYPE;
  act TEXT := lower(coalesce(p_action, ''));
BEGIN
  IF act NOT IN ('approve', 'deny') THEN
    RETURN 'invalid_action';
  END IF;

  SELECT * INTO row
  FROM public.login_challenges
  WHERE token = p_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF row.status = 'approved' THEN
    RETURN 'already_approved';
  END IF;
  IF row.status = 'denied' THEN
    RETURN 'already_denied';
  END IF;
  IF row.status = 'expired' OR row.expires_at < now() THEN
    IF row.status = 'pending' THEN
      UPDATE public.login_challenges
      SET status = 'expired', resolved_at = now()
      WHERE id = row.id;
    END IF;
    RETURN 'expired';
  END IF;

  IF act = 'approve' THEN
    UPDATE public.login_challenges
    SET status = 'approved', resolved_at = now()
    WHERE id = row.id;
    RETURN 'approved';
  ELSE
    UPDATE public.login_challenges
    SET status = 'denied', resolved_at = now()
    WHERE id = row.id;
    RETURN 'denied';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.slugify_title(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select nullif(
    regexp_replace(
      regexp_replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(
          lower(trim(coalesce(p_text, ''))),
          'а', 'a'), 'б', 'b'), 'в', 'v'), 'г', 'g'), 'д', 'd'), 'е', 'e'), 'ё', 'yo'), 'ж', 'zh'),
          'з', 'z'), 'и', 'i'), 'й', 'y'), 'к', 'k'), 'л', 'l'), 'м', 'm'), 'н', 'n'), 'о', 'o'),
          'п', 'p'), 'р', 'r'), 'с', 's'), 'т', 't'), 'у', 'u'), 'ф', 'f'), 'х', 'kh'), 'ц', 'ts'),
          'ч', 'ch'), 'ш', 'sh'), 'щ', 'shch'), 'ъ', ''), 'ы', 'y'), 'ь', ''), 'э', 'e'),
          'ю', 'yu'), 'я', 'ya'),
        '[^a-z0-9]+', '-', 'g'
      ),
      '^-+|-+$', ''
    ),
    ''
  );
$function$;

CREATE OR REPLACE FUNCTION public.tg_user_api_keys_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_request_rate_limit
  BEFORE INSERT ON public.admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.check_request_rate_limit();
CREATE TRIGGER trg_apply_admin_request
  BEFORE UPDATE ON public.admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.apply_admin_request();
CREATE TRIGGER user_api_keys_updated_at
  BEFORE UPDATE ON public.user_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.tg_user_api_keys_updated_at();

ALTER TABLE public.titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.title_genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_voiceovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin can insert" ON public.admin_requests FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') AND requester_id = auth.uid() AND type <> 'ad_request');
CREATE POLICY "admin sees own requests" ON public.admin_requests FOR SELECT TO authenticated
  USING (requester_id = auth.uid());
CREATE POLICY "anyone can insert ad_request" ON public.admin_requests FOR INSERT TO public
  WITH CHECK (type = 'ad_request' AND (requester_id IS NULL OR requester_id = auth.uid()));
CREATE POLICY "no anon insert" ON public.admin_requests FOR INSERT TO anon WITH CHECK (false);
CREATE POLICY "owner can update status" ON public.admin_requests FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner sees all requests" ON public.admin_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "owner manages ads" ON public.ads FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "public reads active ads" ON public.ads FOR SELECT TO public
  USING (active = true AND (expires_at IS NULL OR expires_at > now()));

CREATE POLICY "Admin read voiceovers" ON public.chapter_voiceovers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write voiceovers" ON public.chapter_voiceovers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write chapters" ON public.chapters FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Authenticated read published and admin chapters" ON public.chapters FOR SELECT TO authenticated
  USING (published = true OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Public read published chapters" ON public.chapters FOR SELECT TO anon
  USING (published = true);
CREATE POLICY "Admin write pages" ON public.pages FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Authenticated read published and admin pages" ON public.pages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.chapters WHERE chapters.id = pages.chapter_id AND (chapters.published = true OR public.has_role(auth.uid(), 'admin'))));
CREATE POLICY "Public read pages" ON public.pages FOR SELECT TO anon
  USING (EXISTS (SELECT 1 FROM public.chapters WHERE chapters.id = pages.chapter_id AND chapters.published = true));

CREATE POLICY "Admin write genres" ON public.genres FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Public read genres" ON public.genres FOR SELECT TO public USING (true);
CREATE POLICY "Admin write title_genres" ON public.title_genres FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Public read title_genres" ON public.title_genres FOR SELECT TO public USING (true);
CREATE POLICY "Admin write titles" ON public.titles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Authenticated read published and admin titles" ON public.titles FOR SELECT TO authenticated
  USING (published = true OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Public read published titles" ON public.titles FOR SELECT TO anon
  USING (published = true);

CREATE POLICY "no direct client access" ON public.ip_rate_limit FOR ALL TO public
  USING (false) WITH CHECK (false);
CREATE POLICY "no direct client access" ON public.rate_limit_log FOR ALL TO public
  USING (false) WITH CHECK (false);
CREATE POLICY "User read own login challenges" ON public.login_challenges FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "User read own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "user_api_keys_delete_own_admin" ON public.user_api_keys FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "user_api_keys_insert_own_admin" ON public.user_api_keys FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "user_api_keys_select_own_admin" ON public.user_api_keys FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "user_api_keys_update_own_admin" ON public.user_api_keys FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (user_id = auth.uid() AND public.has_role(auth.uid(), 'admin'));

-- Keep Supabase Data API access narrow; RLS still decides which rows are visible.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.titles, public.chapters, public.pages, public.genres, public.title_genres, public.ads TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.titles, public.chapters, public.pages, public.genres, public.title_genres TO authenticated;
GRANT SELECT ON public.ads, public.chapter_voiceovers TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ads, public.chapter_voiceovers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.admin_requests TO authenticated;
GRANT INSERT ON public.admin_requests TO anon;
GRANT SELECT ON public.user_roles, public.login_challenges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_api_keys TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Keep the source project's Storage object access model on the destination.
CREATE POLICY "Admin delete title covers" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'title-covers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin insert title covers" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'title-covers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin read originals" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'hikko-originals' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin read voiceovers bucket" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voiceovers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write manga" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'manga' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'manga' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write originals" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'hikko-originals' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'hikko-originals' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write voiceovers bucket" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'voiceovers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Public read manga" ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'manga');
CREATE POLICY "Public read title covers" ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'title-covers');
CREATE POLICY "public read submissions" ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'submissions');
