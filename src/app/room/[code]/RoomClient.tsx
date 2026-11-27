"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import YouTubePlayer from "@/components/YouTubePlayer";
import { generateGuestName } from "@/lib/identity";

interface Room {
  id: string;
  name: string;
  room_code: string;
  host_id: string;
  is_playing: boolean;
}

export default function RoomClient({ code }: { code: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    let memberChannel: ReturnType<typeof supabase.channel> | null = null;
    let roleRefreshTimer: ReturnType<typeof setInterval> | null = null;

    async function loadRoom() {
      try {
        // A direct room link may be opened in a browser with no auth session.
        // getSession() safely returns null in that case; getUser() can surface
        // AuthSessionMissingError when there is no stored session.
        const {
          data: { session: existingSession },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) throw sessionError;

        let user = existingSession?.user ?? null;

        if (!user) {
          const { data: signInData, error: signInError } =
            await supabase.auth.signInAnonymously();

          if (signInError) throw signInError;
          if (!signInData.session || !signInData.user) {
            throw new Error(
              "Guest sign-in did not create a session. Check that Anonymous Sign-ins are enabled in Supabase Authentication settings."
            );
          }

          user = signInData.user;
        }

        if (cancelled) return;

        setCurrentUserId(user.id);

        // Ensure every guest has a valid profile before calling join_room.
        const { data: existingProfile, error: profileReadError } = await supabase
          .from("profiles")
          .select("id, username")
          .eq("id", user.id)
          .maybeSingle();

        if (profileReadError) throw profileReadError;

        if (!existingProfile) {
          const username = generateGuestName();
          const { error: profileInsertError } = await supabase
            .from("profiles")
            .insert({ id: user.id, username });

          if (profileInsertError) throw profileInsertError;
        }

        // join_room is idempotent for existing members and adds direct-link visitors.
        const { error: joinError } = await supabase.rpc("join_room", {
          p_room_code: code.toUpperCase(),
        });

        if (joinError) throw joinError;

        // Fetch room only after membership is established (important when RLS
        // restricts room visibility to members).
        const { data, error: roomError } = await supabase
          .from("rooms")
          .select("id, name, room_code, host_id, is_playing")
          .eq("room_code", code.toUpperCase())
          .maybeSingle();

        if (roomError) throw roomError;
        if (!data) throw new Error("Room not found or access denied.");
        if (cancelled) return;

        const currentRoom = data as Room;
        setRoom(currentRoom);

        const refreshOwnRole = async () => {
          const { data: membership, error: membershipError } = await supabase
            .from("room_members")
            .select("role")
            .eq("room_id", currentRoom.id)
            .eq("user_id", user.id)
            .maybeSingle();

          if (cancelled) return;
          if (membershipError) {
            console.error("Unable to refresh room role:", membershipError);
            return;
          }

          setIsAdmin(
            user.id === currentRoom.host_id || membership?.role === "admin"
          );
        };

        await refreshOwnRole();

        memberChannel = supabase
          .channel(`room-role:${currentRoom.id}:${user.id}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "room_members",
              filter: `room_id=eq.${currentRoom.id}`,
            },
            async (payload) => {
              if (cancelled) return;
              const changedUserId =
                (payload.new as { user_id?: string } | null)?.user_id ??
                (payload.old as { user_id?: string } | null)?.user_id;
              if (changedUserId && changedUserId !== user.id) return;
              await refreshOwnRole();
            }
          )
          .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              console.error("Live room-role updates are unavailable.");
            }
          });

        roleRefreshTimer = setInterval(() => void refreshOwnRole(), 2500);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load room.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadRoom();

    return () => {
      cancelled = true;
      if (memberChannel) void supabase.removeChannel(memberChannel);
      if (roleRefreshTimer) clearInterval(roleRefreshTimer);
    };
  }, [code]);

  if (loading) {
    return (
      <main className="min-h-screen bg-[#080D1B] text-white flex items-center justify-center">
        Loading Syncwave room...
      </main>
    );
  }

  if (error || !room) {
    return (
      <main className="min-h-screen bg-[#080D1B] text-white flex flex-col items-center justify-center gap-3 p-6">
        <h1 className="text-2xl font-bold">Unable to open room</h1>
        <p className="text-gray-400 text-center">{error || "Room not found."}</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#080D1B] text-white">
      {currentUserId && (
        <YouTubePlayer
          roomId={room.id}
          userId={currentUserId}
          isHost={currentUserId === room.host_id}
          isAdmin={isAdmin}
        />
      )}
    </main>
  );
}
