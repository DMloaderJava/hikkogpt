-- ============================================================================
-- HikkoGPT — подтверждение почты отключено насовсем
--
-- Запуск: Dashboard целевого проекта → SQL Editor → New query → весь скрипт.
-- Идемпотентен: повторный запуск ничего не сломает.
--
-- После запуска в Dashboard переключите (это настройка GoTrue, из SQL её не
-- поменять): Authentication → Sign In / Up → Providers → Email →
-- «Confirm email» → off.
--
-- Вход и регистрация остаются чисто email + password:
--   * регистрация — edge-функция auth-register создаёт уже подтверждённого
--     пользователя (письма нет);
--   * вход — signInWithPassword;
--   * письмо-подтверждение больше не требуется ни для входа, ни для админа.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Часть 1. Регистрация: подтверждение почты отключено
-- ----------------------------------------------------------------------------

-- 1.1. Подтверждаем все существующие аккаунты с почтой — вход по паролю
--      становится возможным без клика по ссылке из письма.
UPDATE auth.users
SET email_confirmed_at = now(),
    updated_at = now()
WHERE email IS NOT NULL
  AND email_confirmed_at IS NULL;

-- 1.2. Автоподтверждение новых строк auth.users.
--      Страховка: даже если какой-то клиент создаст пользователя публичным
--      signUp (например, пока в Dashboard ещё включён «Confirm email»),
--      он сможет войти по паролю сразу.
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
  -- GoTrue (supabase_auth_admin) вставляет пользователей и исполняет триггер.
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

-- 1.3. Запасной путь для edge-функции auth-register: пометить существующий
--      аккаунт подтверждённым. Вызывается только service_role, пароль не
--      меняет — подтверждение не становится способом захватить аккаунт.
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

-- ----------------------------------------------------------------------------
-- Часть 2. «Login guard» (подтверждение входа админа письмом) — уборка
-- ----------------------------------------------------------------------------
-- Механизм больше не используется в коде: вход в админку чисто по email и
-- паролю, challenge одобрялся автоматически. Если история аудита нужна,
-- остановитесь после 2.1 и пропустите 2.2–2.3.

-- 2.1. Однократно одобряем зависшие challenge (таблица дальше не
--      используется приложением).
DO $$
BEGIN
  UPDATE public.login_challenges
  SET status = 'approved',
      resolved_at = now()
  WHERE status = 'pending';
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE 'login_challenges update skipped: %', SQLERRM;
END;
$$;

-- 2.2. Функции, которые использовал только login guard.
DROP FUNCTION IF EXISTS public.create_login_challenge(text, text, text, text, integer, text);
DROP FUNCTION IF EXISTS public.resolve_login_challenge(text, text);
DROP FUNCTION IF EXISTS public.latest_login_challenge_status();

-- 2.3. Таблица challenge (аудит-история удаляется вместе с ней).
DO $$
BEGIN
  DROP POLICY IF EXISTS "User read own login challenges" ON public.login_challenges;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END;
$$;
DROP TABLE IF EXISTS public.login_challenges;

-- ----------------------------------------------------------------------------
-- Проверка результата (запустите в конце, чтобы посмотреть итог)
-- ----------------------------------------------------------------------------
SELECT
  (SELECT count(*)
     FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND tgname = 'auto_confirm_auth_user') AS auto_confirm_trigger,
  (SELECT count(*)
     FROM auth.users
    WHERE email IS NOT NULL
      AND email_confirmed_at IS NULL) AS unconfirmed_users,
  (SELECT count(*)
     FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'login_challenges') AS login_challenges_table;
