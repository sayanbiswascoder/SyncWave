
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCode } from "react-qr-code";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import {
  FaCrown,
  FaShieldHalved,
  FaUser,
  FaUserPlus,
  FaUserMinus,
  FaUserXmark,
  FaQrcode,
  FaXmark,
  FaEllipsisVertical,
  FaPenToSquare,
  FaCheck,
} from "react-icons/fa6";

type Role = "host" | "admin" | "member";

interface Room {
  id: string;
  name: string;
  room_code: string;
  host_id: string;
  is_playing: boolean;
}

interface PresenceMember {
  user_id: string;
  username: string;
  online_at?: string;
}

interface Member {
  user_id: string;
  username: string;
  role: Role;
  online: boolean;
}

export default function SessionInfo({ code }: { code: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [presenceError, setPresenceError] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [showQR, setShowQR] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState("");
  const [nameSaving, setNameSaving] = useState(false);

  // Initialize the Supabase client before creating refs that use its channel type.
  const supabase = useMemo(() => createClient(), []);
  const presenceChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const [openMemberMenu, setOpenMemberMenu] = useState<string | null>(null);
  const onlineUsersRef = useRef<PresenceMember[]>([]);

  const selfMember = members.find((member) => member.user_id === currentUserId) ?? null;

  const currentRole =
    members.find((m) => m.user_id === currentUserId)?.role;

  const canManageMembers =
    currentRole === "host" || currentRole === "admin";

  const loadMembers = useCallback(
    async (roomId: string, hostId: string, onlineUsers: PresenceMember[]) => {
      const { data: memberRows, error: memberError } = await supabase
        .from("room_members")
        .select("user_id, role")
        .eq("room_id", roomId);

      if (memberError) throw memberError;

      const userIds = (memberRows ?? []).map((m) => m.user_id);

      const { data: profiles, error: profileError } = userIds.length
        ? await supabase
            .from("profiles")
            .select("id, username")
            .in("id", userIds)
        : { data: [], error: null };

      if (profileError) throw profileError;

      const profileMap = new Map(
        (profiles ?? []).map((p) => [p.id, p.username])
      );

      const onlineMap = new Map(
        onlineUsers.map((m) => [m.user_id, m])
      );

      const result: Member[] = (memberRows ?? []).map((m) => ({
        user_id: m.user_id,
        username:
          profileMap.get(m.user_id) ||
          onlineMap.get(m.user_id)?.username ||
          "Guest",
        role:
          m.user_id === hostId
            ? "host"
            : (m.role as Role),
        online: onlineMap.has(m.user_id),
      }));

      setMembers(result);
    },
    [supabase]
  );

  useEffect(() => {
    let cancelled = false;
    let presenceChannel: ReturnType<typeof supabase.channel> | null = null;
    let memberChannel: ReturnType<typeof supabase.channel> | null = null;
    let profileChannel: ReturnType<typeof supabase.channel> | null = null;
    let currentRoomId = "";
    let hostId = "";

    async function initialize() {
      try {
        // RoomClient may still be completing anonymous sign-in on the first
        // visit. Do not call getUser() here: it can fail with
        // AuthSessionMissingError before that session has been persisted.
        const {
          data: { session: initialSession },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) throw sessionError;

        let user: User | null = initialSession?.user ?? null;

        if (!user) {
          user = await new Promise<User>((resolve) => {
            let subscription: { unsubscribe: () => void } | null = null;

            const authListener = supabase.auth.onAuthStateChange(
              (_event, session) => {
                if (session?.user) {
                  subscription?.unsubscribe();
                  resolve(session.user);
                }
              }
            );

            subscription = authListener.data.subscription;

            // Handles a session that appeared between getSession() and
            // registering the auth listener.
            void supabase.auth.getSession().then(({ data, error }) => {
              if (error) {
                subscription?.unsubscribe();
                return;
              }
              if (data.session?.user) {
                subscription?.unsubscribe();
                resolve(data.session.user);
              }
            });
          });
        }

        if (cancelled) return;
        setCurrentUserId(user.id);
        setError("");

        // RoomClient performs the guest's join_room RPC. SessionInfo mounts
        // alongside it, so this lookup can run before membership is inserted.
        // With member-only room SELECT policies, Supabase then returns no row.
        // Wait briefly for RoomClient to finish joining instead of showing a
        // false "Room not found or access denied" error on the first visit.
        let roomData: Room | null = null;
        const maxRoomAttempts = 40;

        for (let attempt = 0; attempt < maxRoomAttempts; attempt += 1) {
          if (cancelled) return;

          const { data, error: roomError } = await supabase
            .from("rooms")
            .select("id, name, room_code, host_id, is_playing")
            .eq("room_code", code.toUpperCase())
            .maybeSingle();

          if (roomError) throw roomError;
          if (data) {
            roomData = data as Room;
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (cancelled) return;
        if (!roomData) {
          throw new Error(
            "Room not found or access denied. Please check the room link and try again."
          );
        }

        const currentRoom = roomData;
        currentRoomId = currentRoom.id;
        hostId = currentRoom.host_id;
        setRoom(currentRoom);

        const { data: profile } = await supabase
          .from("profiles")
          .select("username")
          .eq("id", user.id)
          .maybeSingle();

        const username = profile?.username || "Guest";

        presenceChannel = supabase.channel(
          `room:${currentRoom.id}`,
          { config: { presence: { key: user.id } } }
        );

        presenceChannelRef.current = presenceChannel;

        presenceChannel.on("presence", { event: "sync" }, () => {
          if (cancelled || !presenceChannel) return;

          const state = presenceChannel.presenceState();
          const onlineUsers = Object.values(state)
            .flat() as PresenceMember[];

          const uniqueUsers = Array.from(
            new Map(
              onlineUsers.map((m) => [m.user_id, m])
            ).values()
          );
          onlineUsersRef.current = uniqueUsers;

          void loadMembers(currentRoom.id, currentRoom.host_id, uniqueUsers);
        });

        presenceChannel.subscribe(async (status) => {
          if (cancelled || !presenceChannel) return;

          if (status === "SUBSCRIBED") {
            const { error: trackError } = await presenceChannel.track({
              user_id: user.id,
              username,
              online_at: new Date().toISOString(),
            });

            if (trackError) {
              setPresenceError("Unable to publish online status.");
            } else {
              setPresenceError("");
            }
          }

          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setPresenceError("Live member updates are unavailable.");
          }
        });

        memberChannel = supabase
          .channel(`room-members:${currentRoom.id}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "room_members",
              filter: `room_id=eq.${currentRoom.id}`,
            },
            async () => {
              if (cancelled) return;

              const state = presenceChannel?.presenceState() ?? {};
              const onlineUsers = Object.values(state)
                .flat() as PresenceMember[];
              onlineUsersRef.current = onlineUsers;

              await loadMembers(
                currentRoom.id,
                currentRoom.host_id,
                onlineUsers
              );
            }
          )
          .subscribe();

        // Refresh the member list whenever any room member changes their display name.
        profileChannel = supabase
          .channel(`room-profiles:${currentRoom.id}`)
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "profiles" },
            async () => {
              if (cancelled) return;
              await loadMembers(
                currentRoom.id,
                currentRoom.host_id,
                onlineUsersRef.current
              );
            }
          )
          .subscribe();

        await loadMembers(currentRoom.id, currentRoom.host_id, []);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to load room."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      if (presenceChannel) void supabase.removeChannel(presenceChannel);
      if (memberChannel) void supabase.removeChannel(memberChannel);
      if (profileChannel) void supabase.removeChannel(profileChannel);
      presenceChannelRef.current = null;
    };
  }, [code, loadMembers, supabase]);

  async function saveDisplayName() {
    const username = nameDraft.trim();
    if (username.length < 2 || username.length > 30) {
      setNameError("Name must be between 2 and 30 characters.");
      return;
    }
    if (!currentUserId) return;

    setNameSaving(true);
    setNameError("");
    try {
      const { error: updateError } = await supabase
        .from("profiles")
        .update({ username, updated_at: new Date().toISOString() })
        .eq("id", currentUserId);
      if (updateError) throw updateError;

      setMembers((current) => current.map((member) =>
        member.user_id === currentUserId ? { ...member, username } : member
      ));

      if (presenceChannelRef.current) {
        await presenceChannelRef.current.track({
          user_id: currentUserId,
          username,
          online_at: new Date().toISOString(),
        });
      }
      setEditingName(false);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Unable to update your name.");
    } finally {
      setNameSaving(false);
    }
  }

  async function manageMember(
    userId: string,
    action: "promote_room_member" | "demote_room_admin" | "remove_room_member"
  ) {
    if (!room || !canManageMembers || userId === room.host_id) return;

    const labels = {
      promote_room_member: "Promoting member...",
      demote_room_admin: "Removing admin privileges...",
      remove_room_member: "Removing member...",
    };

    const confirmations = {
      promote_room_member: "Promote this member to admin?",
      demote_room_admin: "Remove this member's admin privileges?",
      remove_room_member: "Remove this member from the room?",
    };

    if (!window.confirm(confirmations[action])) return;

    setActionLoading(userId);
    setOpenMemberMenu(null);

    try {
      const { error: rpcError } = await supabase.rpc(action, {
        p_room_id: room.id,
        p_user_id: userId,
      });

      if (rpcError) throw rpcError;

      await loadMembers(room.id, room.host_id, onlineUsersRef.current);
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Action failed."
      );
    } finally {
      setActionLoading("");
    }
  }


  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/room/${code}`
      : "";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-white">
        Loading...
      </div>
    );
  }

  if (error || !room) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-400">
        {error || "Room not found."}
      </div>
    );
  }

  return (
    <section className="h-screen overflow-y-auto rounded-lg bg-gray-800 p-4 text-white">
      <header className="flex flex-col gap-4">
        <h1 className="text-3xl font-bold">{room.name || "Session"}</h1>

        <div className="flex items-center justify-between">
          <p className="text-cyan-400">
            Room Code: {room.room_code}
          </p>

          <button
            onClick={() => setShowQR(!showQR)}
            className="rounded-full bg-cyan-400 px-3 py-1 text-sm text-black"
          >
            <span className="inline-flex items-center gap-2"><FaQrcode /> QR</span>
          </button>
        </div>

        {selfMember && (
          <div className="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-gray-400">Your room name</p>
                {!editingName ? (
                  <p className="mt-1 truncate font-semibold text-white">{selfMember.username}</p>
                ) : (
                  <input
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    maxLength={30}
                    autoFocus
                    className="mt-1 w-full rounded-lg border border-white/10 bg-[#0b1425] px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                    aria-label="Your room name"
                  />
                )}
              </div>
              {!editingName ? (
                <button
                  type="button"
                  onClick={() => {
                    setNameDraft(selfMember.username);
                    setNameError("");
                    setEditingName(true);
                  }}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-cyan-400/20 px-3 py-2 text-xs text-cyan-300 hover:bg-cyan-400/10"
                >
                  <FaPenToSquare /> Edit name
                </button>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={nameSaving}
                    onClick={() => void saveDisplayName()}
                    className="rounded-lg bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
                  >
                    <FaCheck className="inline" /> {nameSaving ? "Saving" : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={nameSaving}
                    onClick={() => { setEditingName(false); setNameError(""); }}
                    className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {nameError && <p className="mt-2 text-xs text-red-400">{nameError}</p>}
          </div>
        )}
      </header>

      {showQR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="rounded-2xl bg-white p-5">
            <QRCode value={url} size={260} />
            <button
              onClick={() => setShowQR(false)}
              className="mt-4 w-full rounded-lg bg-gray-900 py-2 text-white"
            >
              <span className="inline-flex items-center justify-center gap-2"><FaXmark /> Close</span>
            </button>
          </div>
        </div>
      )}

      <section className="mt-8 max-w-2xl">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-semibold">Room Members</h2>
            <span className="text-sm text-cyan-300">
              {members.filter((m) => m.online).length} online · {members.length} total
            </span>
          </div>

          {presenceError && (
            <p className="mb-3 text-sm text-amber-400">
              {presenceError}
            </p>
          )}

          {members.length === 0 ? (
            <p className="text-sm text-gray-400">
              No members found.
            </p>
          ) : (
            <div className="space-y-3">
              {members.map((member) => {
                const isSelf = member.user_id === currentUserId;
                const isBusy = actionLoading === member.user_id;

                return (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      if (canManageMembers && !isSelf && member.role !== "host") {
                        setOpenMemberMenu((current) =>
                          current === member.user_id ? null : member.user_id
                        );
                      }
                    }}
                    aria-label={`Manage ${member.username}`}
                    aria-expanded={openMemberMenu === member.user_id}
                    key={member.user_id}
                    className="flex flex-col gap-3 rounded-xl bg-white/[0.04] p-3 sm:flex-row sm:items-center sm:justify-between w-full"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-950 font-semibold text-cyan-300">
                        {member.username.charAt(0).toUpperCase()}
                      </div>

                      <div>
                        <p className="font-medium text-left">
                          {member.username}
                          {isSelf && (
                            <span className="ml-2 text-xs text-gray-400">
                              YOU
                            </span>
                          )}
                        </p>

                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              member.role === "host"
                                ? "bg-cyan-500/15 text-cyan-300"
                                : member.role === "admin"
                                ? "bg-purple-500/15 text-purple-300"
                                : "bg-white/10 text-gray-300"
                            }`}
                          >
                            <span className="inline-flex items-center gap-1.5">
                              {member.role === "host" ? (
                                <FaCrown />
                              ) : member.role === "admin" ? (
                                <FaShieldHalved />
                              ) : (
                                <FaUser />
                              )}
                              {member.role.toUpperCase()}
                            </span>
                          </span>

                          <span className="flex items-center gap-1 text-xs text-gray-500">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                member.online ? "bg-green-400" : "bg-gray-500"
                              }`}
                            />
                            {member.online ? "Online" : "Offline"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {canManageMembers &&
                      !isSelf &&
                      member.role !== "host" && (
                        <div className="relative self-end sm:self-auto">
                          {openMemberMenu === member.user_id && (
                            <div className="absolute right-0 top-full z-40 mt-2 min-w-48 overflow-hidden rounded-xl border border-white/10 bg-[#101b2d] p-1 shadow-2xl shadow-black/40">
                              {member.role === "member" ? (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() =>
                                    void manageMember(member.user_id, "promote_room_member")
                                  }
                                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs text-purple-300 transition hover:bg-purple-500/10 disabled:opacity-50"
                                >
                                  <FaUserPlus />
                                  {isBusy ? "Please wait..." : "Make Admin"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() =>
                                    void manageMember(member.user_id, "demote_room_admin")
                                  }
                                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs text-amber-300 transition hover:bg-amber-500/10 disabled:opacity-50"
                                >
                                  <FaUserMinus />
                                  {isBusy ? "Please wait..." : "Remove Admin"}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  void manageMember(member.user_id, "remove_room_member")
                                }
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
                              >
                                <FaUserXmark />
                                Remove from room
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
