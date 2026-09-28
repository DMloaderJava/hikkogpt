-- Restrict SECURITY DEFINER RPCs and keep anonymous access only where the
-- policy is intentionally public. This migration does not modify user rows.

-- Prevent authenticated users from asking about arbitrary users' roles.
CREATE OR REPLACE FUNCTION public.has_role(uid uuid, role_to_check text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
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

-- Only an authenticated administrator may create a login challenge. The
-- Edge Function performs the same check; this protects direct RPC callers too.
CREATE OR REPLACE FUNCTION public.create_login_challenge(
  p_token text,
  p_admin_email text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_ip text DEFAULT NULL,
  p_ttl_minutes integer DEFAULT 15,
  p_session_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
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

-- Pin all database helpers to system objects first, then this application's
-- public objects. This removes attacker-controlled search_path resolution.
ALTER FUNCTION public.apply_admin_request() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.check_ip_rate_limit(text, integer, integer) SET search_path TO pg_catalog, public;
ALTER FUNCTION public.check_request_rate_limit() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.cleanup_ip_rate_limit() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.cleanup_rate_limit_log() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.cleanup_rejected_submissions() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.latest_login_challenge_status() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.resolve_login_challenge(text, text) SET search_path TO pg_catalog, public;
ALTER FUNCTION public.slugify_title(text) SET search_path TO pg_catalog, public;
ALTER FUNCTION public.tg_user_api_keys_updated_at() SET search_path TO pg_catalog, public;

-- Revoke broad/default function execution. Trigger functions and maintenance
-- helpers are callable only by the trusted backend role; user-facing calls are
-- limited to the explicitly required authenticated RPCs.
REVOKE ALL ON FUNCTION public.apply_admin_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_request() TO service_role;
REVOKE ALL ON FUNCTION public.check_ip_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_ip_rate_limit(text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.check_request_rate_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_request_rate_limit() TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_ip_rate_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_ip_rate_limit() TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_rate_limit_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limit_log() TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_rejected_submissions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rejected_submissions() TO service_role;
REVOKE ALL ON FUNCTION public.create_login_challenge(text, text, text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_login_challenge(text, text, text, text, integer, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.has_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.latest_login_challenge_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.latest_login_challenge_status() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_login_challenge(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_login_challenge(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.tg_user_api_keys_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_user_api_keys_updated_at() TO service_role;

-- Admin-only policies must not be evaluated for anon. Public content reads are
-- split so anon does not need EXECUTE on has_role while authenticated admins
-- retain access to drafts/unpublished content.
ALTER POLICY "admin can insert" ON public.admin_requests TO authenticated;
ALTER POLICY "admin sees own requests" ON public.admin_requests TO authenticated;
ALTER POLICY "owner can update status" ON public.admin_requests TO authenticated;
ALTER POLICY "owner sees all requests" ON public.admin_requests TO authenticated;
ALTER POLICY "owner manages ads" ON public.ads TO authenticated;
ALTER POLICY "Admin read voiceovers" ON public.chapter_voiceovers TO authenticated;
ALTER POLICY "Admin write voiceovers" ON public.chapter_voiceovers TO authenticated;
ALTER POLICY "Admin write chapters" ON public.chapters TO authenticated;
ALTER POLICY "Admin write genres" ON public.genres TO authenticated;
ALTER POLICY "Admin write pages" ON public.pages TO authenticated;
ALTER POLICY "Admin write title_genres" ON public.title_genres TO authenticated;
ALTER POLICY "Admin write titles" ON public.titles TO authenticated;
ALTER POLICY "user_api_keys_delete_own_admin" ON public.user_api_keys TO authenticated;
ALTER POLICY "user_api_keys_insert_own_admin" ON public.user_api_keys TO authenticated;
ALTER POLICY "user_api_keys_select_own_admin" ON public.user_api_keys TO authenticated;
ALTER POLICY "user_api_keys_update_own_admin" ON public.user_api_keys TO authenticated;
ALTER POLICY "User read own roles" ON public.user_roles TO authenticated;
ALTER POLICY "User read own login challenges" ON public.login_challenges TO authenticated;
ALTER POLICY "Users can create own chats" ON public.chats TO authenticated;
ALTER POLICY "Users can delete own chats" ON public.chats TO authenticated;
ALTER POLICY "Users can update own chats" ON public.chats TO authenticated;
ALTER POLICY "Users can view own chats" ON public.chats TO authenticated;
ALTER POLICY "Users can delete messages of own chats" ON public.messages TO authenticated;
ALTER POLICY "Users can insert messages to own chats" ON public.messages TO authenticated;
ALTER POLICY "Users can view messages of own chats" ON public.messages TO authenticated;

DROP POLICY "Public read published titles" ON public.titles;
CREATE POLICY "Public read published titles"
  ON public.titles FOR SELECT TO anon
  USING (published = true);
DROP POLICY IF EXISTS "Authenticated read published and admin titles" ON public.titles;
CREATE POLICY "Authenticated read published and admin titles"
  ON public.titles FOR SELECT TO authenticated
  USING (published = true OR public.has_role(auth.uid(), 'admin'));

DROP POLICY "Public read published chapters" ON public.chapters;
CREATE POLICY "Public read published chapters"
  ON public.chapters FOR SELECT TO anon
  USING (published = true);
DROP POLICY IF EXISTS "Authenticated read published and admin chapters" ON public.chapters;
CREATE POLICY "Authenticated read published and admin chapters"
  ON public.chapters FOR SELECT TO authenticated
  USING (published = true OR public.has_role(auth.uid(), 'admin'));

DROP POLICY "Public read pages" ON public.pages;
CREATE POLICY "Public read pages"
  ON public.pages FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.chapters
      WHERE chapters.id = pages.chapter_id AND chapters.published = true
    )
  );
DROP POLICY IF EXISTS "Authenticated read published and admin pages" ON public.pages;
CREATE POLICY "Authenticated read published and admin pages"
  ON public.pages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.chapters
      WHERE chapters.id = pages.chapter_id
        AND (chapters.published = true OR public.has_role(auth.uid(), 'admin'))
    )
  );


-- The baseline revokes default Data API grants. Restore only what the app uses.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chats TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.chats, public.messages TO service_role;
