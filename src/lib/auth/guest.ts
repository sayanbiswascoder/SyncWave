import { createClient } from "@/lib/supabase/client";

export async function createGuest(username: string) {
  const supabase = createClient();
  const cleanUsername = username.trim();

  if (cleanUsername.length < 2 || cleanUsername.length > 30) {
    throw new Error("Username must be between 2 and 30 characters.");
  }

  let { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();

    if (error) throw error;

    session = data.session;
  }

  if (!session?.user) {
    throw new Error("Guest authentication failed.");
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(
      {
        id: session.user.id,
        username: cleanUsername,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (profileError) {
    console.error("Profile creation failed:", {
      code: profileError.code,
      message: profileError.message,
      details: profileError.details,
      hint: profileError.hint,
    });

    throw profileError;
  }

  return session.user;
}