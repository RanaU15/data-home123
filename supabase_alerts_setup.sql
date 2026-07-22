-- Alerts Table
CREATE TABLE IF NOT EXISTS public.alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    property_types TEXT[] DEFAULT '{}',
    tenant_types TEXT[] DEFAULT '{}',
    location TEXT,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Notifications Table
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    alert_id UUID REFERENCES public.alerts(id) ON DELETE CASCADE NOT NULL,
    post_id TEXT REFERENCES public.posts(id) ON DELETE CASCADE NOT NULL,
    matched_text TEXT,
    matched_keywords TEXT[] DEFAULT '{}',
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(user_id, alert_id, post_id) -- Prevent duplicate notifications
);

-- Enable RLS
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Policies for Alerts
CREATE POLICY "Users can view their own alerts"
ON public.alerts FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own alerts"
ON public.alerts FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own alerts"
ON public.alerts FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own alerts"
ON public.alerts FOR DELETE
USING (auth.uid() = user_id);

-- Policies for Notifications
CREATE POLICY "Users can view their own notifications"
ON public.notifications FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own notifications"
ON public.notifications FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own notifications"
ON public.notifications FOR DELETE
USING (auth.uid() = user_id);

-- System can insert notifications (Security Definer Function bypasses RLS)
CREATE POLICY "System can insert notifications"
ON public.notifications FOR INSERT
WITH CHECK (true);

-- Matcher Function
CREATE OR REPLACE FUNCTION public.match_alerts_on_new_post()
RETURNS TRIGGER AS $$
DECLARE
    alert_record RECORD;
    property_matched BOOLEAN;
    tenant_matched BOOLEAN;
    location_matched BOOLEAN;
    post_body_lower TEXT;
    matched_reasons TEXT[];
BEGIN
    post_body_lower := lower(COALESCE(NEW.body, '') || ' ' || COALESCE(NEW.author, '') || ' ' || COALESCE(NEW.group_name, '') || ' ' || COALESCE(NEW.location, '') || ' ' || COALESCE(NEW.post_type, ''));
    
    FOR alert_record IN SELECT * FROM public.alerts WHERE enabled = true LOOP
        matched_reasons := '{}';

        -- Property Type Match
        IF array_length(alert_record.property_types, 1) IS NULL THEN
            property_matched := true;
        ELSE
            property_matched := false;
            FOR i IN 1 .. array_length(alert_record.property_types, 1) LOOP
                IF replace(replace(post_body_lower, '-', ''), ' ', '') LIKE '%' || replace(replace(lower(alert_record.property_types[i]), '-', ''), ' ', '') || '%' THEN
                    property_matched := true;
                    matched_reasons := array_append(matched_reasons, alert_record.property_types[i]);
                END IF;
            END LOOP;
        END IF;

        -- Tenant Type Match
        IF array_length(alert_record.tenant_types, 1) IS NULL THEN
            tenant_matched := true;
        ELSE
            tenant_matched := false;
            FOR i IN 1 .. array_length(alert_record.tenant_types, 1) LOOP
                IF replace(replace(post_body_lower, '-', ''), ' ', '') LIKE '%' || replace(replace(lower(alert_record.tenant_types[i]), '-', ''), ' ', '') || '%' THEN
                    tenant_matched := true;
                    matched_reasons := array_append(matched_reasons, alert_record.tenant_types[i]);
                END IF;
            END LOOP;
        END IF;

        -- Location Match
        IF alert_record.location IS NULL OR trim(alert_record.location) = '' THEN
            location_matched := true;
        ELSE
            IF replace(replace(post_body_lower, '-', ''), ' ', '') LIKE '%' || replace(replace(lower(trim(alert_record.location)), '-', ''), ' ', '') || '%' THEN
                location_matched := true;
                matched_reasons := array_append(matched_reasons, trim(alert_record.location));
            ELSE
                location_matched := false;
            END IF;
        END IF;

        -- Final Match
        IF property_matched AND tenant_matched AND location_matched THEN
            BEGIN
                INSERT INTO public.notifications (user_id, alert_id, post_id, matched_text)
                VALUES (alert_record.user_id, alert_record.id, NEW.id, COALESCE(NULLIF(array_to_string(matched_reasons, ' • '), ''), 'Matched all posts (no filters)'));
            EXCEPTION WHEN unique_violation THEN
                -- Do nothing on duplicate
            END;
        END IF;

    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trigger_match_alerts ON public.posts;

-- Create Trigger
CREATE TRIGGER trigger_match_alerts
AFTER INSERT ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.match_alerts_on_new_post();
