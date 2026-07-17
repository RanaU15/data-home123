-- Create a new table profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policies

-- SELECT: User can view only their profile.
CREATE POLICY "User can view only their profile"
  ON public.profiles
  FOR SELECT
  USING (auth.uid() = id);

-- UPDATE: User can update only their profile.
CREATE POLICY "User can update only their profile"
  ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id);

-- INSERT: Authenticated users can insert only their own profile.
CREATE POLICY "Authenticated users can insert only their own profile"
  ON public.profiles
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- DELETE: User can delete only their own profile.
CREATE POLICY "User can delete only their own profile"
  ON public.profiles
  FOR DELETE
  USING (auth.uid() = id);

-- Auto Create Profile Trigger

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', '')
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
