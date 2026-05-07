CREATE OR REPLACE FUNCTION public.increment_provider_spend(p_name text, amount numeric)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.llm_provider_caps
  SET current_month_spent_usd = current_month_spent_usd + amount,
      updated_at = NOW()
  WHERE provider = p_name;
$$;
