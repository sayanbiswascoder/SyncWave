
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AudioWaveform,
  Headphones,
  Users,
  Plus,
  ArrowRight,
  Music2,
  Radio,
  Loader2,
  Dices,
} from "lucide-react";

import { createGuest } from "@/lib/auth/guest";
import { createRoom, joinRoom } from "@/lib/rooms";
import { generateGuestName } from "@/lib/identity";

export default function Home() {
  const router = useRouter();

  const [username, setUsername] = useState(() => generateGuestName());
  const [roomName, setRoomName] = useState("Late Night Vibes");
  const [roomCode, setRoomCode] = useState("");

  const [mode, setMode] = useState<"create" | "join">("create");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleContinue() {
    setError("");

    if (username.trim().length < 2) {
      setError("Please enter a username (at least 2 characters).");
      return;
    }

    if (mode === "create" && roomName.trim().length < 2) {
      setError("Please enter a room name.");
      return;
    }

    if (mode === "join" && roomCode.trim().length !== 6) {
      setError("Please enter a valid 6-character room code.");
      return;
    }

    try {
      setLoading(true);

      await createGuest(username);

      if (mode === "create") {
        const room = await createRoom(roomName);
        router.push(`/room/${room.room_code}`);
      } else {
        await joinRoom(roomCode);
        router.push(`/room/${roomCode.trim().toUpperCase()}`);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#07111f] text-white overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-200px] left-1/2 -translate-x-1/2
          w-[600px] h-[600px] rounded-full bg-cyan-500/10 blur-[130px]" />
        <div className="absolute bottom-[-200px] right-[-100px]
          w-[400px] h-[400px] rounded-full bg-blue-500/10 blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-6">
        {/* Navbar */}
        <nav className="h-20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-cyan-400/10
              border border-cyan-400/20 flex items-center justify-center">
              <AudioWaveform className="text-cyan-400" size={24} />
            </div>
            <span className="text-xl font-bold tracking-tight">
              sync<span className="text-cyan-400">wave</span>
            </span>
          </div>

          <div className="text-xs text-slate-400 border border-white/10
            rounded-full px-4 py-2">
            No account required
          </div>
        </nav>

        {/* Hero */}
        <section className="grid lg:grid-cols-2 gap-16 items-center
          min-h-[calc(100vh-80px)] py-12">

          <div>
            <div className="inline-flex items-center gap-2
              border border-cyan-400/20 bg-cyan-400/5
              text-cyan-300 rounded-full px-4 py-2 text-sm mb-7">
              <Radio size={15} />
              Music brings us together
            </div>

            <h1 className="text-5xl md:text-7xl font-bold
              leading-[1.08] tracking-tight">
              Same music.
              <br />
              <span className="text-cyan-400">Same moment.</span>
            </h1>

            <p className="text-slate-400 text-lg leading-relaxed
              mt-7 max-w-lg">
              Create a room, invite your friends and experience
              music together. Every beat, perfectly synchronized.
            </p>

            <div className="flex flex-wrap gap-6 mt-9 text-sm text-slate-400">
              <div className="flex items-center gap-2">
                <Users size={17} className="text-cyan-400" />
                Listen together
              </div>
              <div className="flex items-center gap-2">
                <Music2 size={17} className="text-cyan-400" />
                Shared queue
              </div>
              <div className="flex items-center gap-2">
                <Headphones size={17} className="text-cyan-400" />
                Guest access
              </div>
            </div>
          </div>

          {/* Room form */}
          <div className="w-full max-w-md mx-auto">
            <div className="rounded-3xl border border-white/10
              bg-[#101e2e]/90 backdrop-blur-xl p-7 shadow-2xl">

              <h2 className="text-2xl font-semibold">
                Start listening
              </h2>

              <p className="text-slate-400 text-sm mt-2 mb-7">
                Enter your name to get started.
              </p>

              <div className="flex items-center justify-between gap-3">
                <label htmlFor="guest-username" className="text-sm text-slate-300">
                  Your display name
                </label>
                <button
                  type="button"
                  onClick={() => setUsername(generateGuestName())}
                  className="inline-flex items-center gap-1.5 text-xs text-cyan-300
                    hover:text-cyan-200 transition-colors"
                >
                  <Dices size={14} />
                  Generate another
                </button>
              </div>

              <input
                id="guest-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={30}
                placeholder="e.g. playful-rabbit"
                className="w-full mt-2 mb-2 bg-[#07111f]
                  border border-white/10 rounded-xl px-4 py-3
                  outline-none focus:border-cyan-400
                  transition-colors"
              />
              <p className="text-xs text-slate-500 mb-6">
                We picked a fun guest name for you. Keep it or edit it.
              </p>

              {/* Mode selection */}
              <div className="grid grid-cols-2 bg-[#07111f]
                p-1 rounded-xl mb-6">
                <button
                  onClick={() => setMode("create")}
                  className={`py-3 rounded-lg text-sm font-medium
                    flex items-center justify-center gap-2
                    ${mode === "create"
                      ? "bg-cyan-400 text-[#07111f]"
                      : "text-slate-400 hover:text-white"}`}
                >
                  <Plus size={17} />
                  Create room
                </button>

                <button
                  onClick={() => setMode("join")}
                  className={`py-3 rounded-lg text-sm font-medium
                    flex items-center justify-center gap-2
                    ${mode === "join"
                      ? "bg-cyan-400 text-[#07111f]"
                      : "text-slate-400 hover:text-white"}`}
                >
                  <Users size={17} />
                  Join room
                </button>
              </div>

              {mode === "create" ? (
                <>
                  <label className="text-sm text-slate-300">
                    Room name
                  </label>
                  <input
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    maxLength={60}
                    placeholder="Give your room a name"
                    className="w-full mt-2 bg-[#07111f]
                      border border-white/10 rounded-xl px-4 py-3
                      outline-none focus:border-cyan-400"
                  />
                </>
              ) : (
                <>
                  <label className="text-sm text-slate-300">
                    Room code
                  </label>
                  <input
                    value={roomCode}
                    onChange={(e) =>
                      setRoomCode(
                        e.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, "")
                          .slice(0, 6)
                      )
                    }
                    maxLength={6}
                    placeholder="Enter 6-character code"
                    className="w-full mt-2 bg-[#07111f]
                      border border-white/10 rounded-xl px-4 py-3
                      outline-none focus:border-cyan-400
                      tracking-widest uppercase"
                  />
                </>
              )}

              {error && (
                <p className="text-red-400 text-sm mt-4">
                  {error}
                </p>
              )}

              <button
                onClick={handleContinue}
                disabled={loading}
                className="w-full mt-6 py-4 rounded-xl
                  bg-cyan-400 hover:bg-cyan-300
                  text-[#07111f] font-semibold
                  flex items-center justify-center gap-2
                  transition-colors disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 size={19} className="animate-spin" />
                    Please wait...
                  </>
                ) : (
                  <>
                    {mode === "create"
                      ? "Create listening room"
                      : "Join listening room"}
                    <ArrowRight size={18} />
                  </>
                )}
              </button>

              <p className="text-xs text-slate-500 text-center mt-5">
                By continuing, you agree to use Syncwave responsibly.
              </p>
            </div>
          </div>
        </section>

        <footer className="border-t border-white/5 py-6
          text-center text-xs text-slate-500">
          Made for music lovers. ©2026 Syncwave.
        </footer>
      </div>
    </main>
  );
}
