-- Add email notification tracking columns to public.notifications
ALTER TABLE public.notifications 
ADD COLUMN IF NOT EXISTS email_sent BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS email_error TEXT,
ADD COLUMN IF NOT EXISTS email_batch_id UUID;

-- ==========================================
-- ACTIVE SESSIONS SUPPORT
-- ==========================================
-- Function to retrieve users with active sessions
CREATE OR REPLACE FUNCTION public.get_active_user_ids()
RETURNS TABLE(user_id UUID) AS $$
BEGIN
    RETURN QUERY 
    SELECT DISTINCT s.user_id 
    FROM auth.sessions s
    WHERE s.not_after > now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- DELETE ALERT SUPPORT
-- ==========================================
-- Preserve notifications when an alert is deleted
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_alert_id_fkey;
ALTER TABLE public.notifications ALTER COLUMN alert_id DROP NOT NULL;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_alert_id_fkey 
    FOREIGN KEY (alert_id) REFERENCES public.alerts(id) ON DELETE SET NULL;
