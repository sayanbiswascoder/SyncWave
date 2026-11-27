
import { createClient } from "@/lib/supabase/client";

export async function createRoom(name: string) {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("create_room", {
    p_name: name.trim(),
  });

  if (error) throw error;

  const room = Array.isArray(data) ? data[0] : data;

  if (!room?.room_code) {
    throw new Error("Room creation failed.");
  }

  return room;
}

export async function joinRoom(code: string) {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("join_room", {
    p_room_code: code.trim().toUpperCase(),
  });

  if (error) throw error;

  return data;
}
