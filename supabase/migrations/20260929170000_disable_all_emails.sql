-- Отключение отправки писем и подтверждений насовсем.
-- Вход и регистрация чисто по email и паролю без отправки писем.

DO $$
BEGIN
  UPDATE auth.users
  SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
      updated_at = now()
  WHERE email_confirmed_at IS NULL;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table OR undefined_column THEN
    NULL;
END;
$$;

-- Автоматически подтверждаем любые зависшие login_challenges
DO $$
BEGIN
  UPDATE public.login_challenges
  SET status = 'approved',
      resolved_at = now()
  WHERE status = 'pending';
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    NULL;
END;
$$;
