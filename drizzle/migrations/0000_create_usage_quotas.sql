-- Список почт с безлимитом
CREATE TABLE public.unlimited_emails (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.unlimited_emails TO authenticated;
GRANT ALL ON public.unlimited_emails TO service_role;

ALTER TABLE public.unlimited_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see own unlimited status"
ON public.unlimited_emails FOR SELECT
TO authenticated
USING (email = (auth.jwt() ->> 'email'));

-- Дневной счётчик сообщений
CREATE TABLE public.usage_counters (
  user_id uuid NOT NULL,
  day date NOT NULL DEFAULT current_date,
  message_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

GRANT SELECT ON public.usage_counters TO authenticated;
GRANT ALL ON public.usage_counters TO service_role;

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own usage"
ON public.usage_counters FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Расход квоты: возвращает true, если запрос разрешён
CREATE OR REPLACE FUNCTION public.consume_message_quota(
  _user_id uuid,
  _email text,
  _daily_limit integer DEFAULT 100
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _unlimited boolean;
  _count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.unlimited_emails WHERE lower(email) = lower(_email)
  ) INTO _unlimited;

  INSERT INTO public.usage_counters (user_id, day, message_count)
  VALUES (_user_id, current_date, 1)
  ON CONFLICT (user_id, day)
  DO UPDATE SET message_count = public.usage_counters.message_count + 1
  RETURNING message_count INTO _count;

  IF _unlimited THEN
    RETURN true;
  END IF;

  RETURN _count <= _daily_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_message_quota(uuid, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.consume_message_quota(uuid, text, integer) TO service_role;