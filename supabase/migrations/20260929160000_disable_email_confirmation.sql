-- Отключает обязательное подтверждение почты («Проверьте почту» / ссылка из письма).
--
-- 1. Новые строки auth.users подтверждаются в момент INSERT, поэтому вход по
--    паролю не ждёт клика по ссылке, даже если Dashboard всё ещё шлёт письмо.
-- 2. Уже зависшие неподтверждённые аккаунты подтверждаются на месте.
-- 3. confirm_auth_email — запасной путь для edge-функции auth-register
--    (service_role). Пароль функция не меняет.

CREATE OR REPLACE FUNCTION public.auto_confirm_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, pg_catalog
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email_confirmed_at IS NULL THEN
    NEW.email_confirmed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_confirm_auth_user() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.auto_confirm_auth_user() TO supabase_auth_admin;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_confirm_auth_user() TO service_role;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS auto_confirm_auth_user ON auth.users;
  CREATE TRIGGER auto_confirm_auth_user
    BEFORE INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.auto_confirm_auth_user();
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE 'auto_confirm trigger skipped: %', SQLERRM;
END;
$$;

DO $$
BEGIN
  UPDATE auth.users
  SET email_confirmed_at = now(),
      updated_at = now()
  WHERE email_confirmed_at IS NULL
    AND email IS NOT NULL;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'existing user confirm skipped: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_auth_email(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, pg_catalog
AS $$
DECLARE
  updated_count integer;
BEGIN
  IF coalesce(auth.role(), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RETURN false;
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
      updated_at = now()
  WHERE lower(email) = lower(trim(p_email))
    AND email_confirmed_at IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count > 0 THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM auth.users
    WHERE lower(email) = lower(trim(p_email))
      AND email_confirmed_at IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_auth_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_auth_email(text) TO service_role;
