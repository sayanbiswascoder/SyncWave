
"use client";

import React from "react";
import SessionInfo from "@/app/room/[code]/components/SessionInfo";
import RoomClient from "@/app/room/[code]/RoomClient";
import { FaClockRotateLeft } from "react-icons/fa6";
import { MdArrowBackIos, MdArrowBackIosNew } from "react-icons/md";

export default function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const [code, setCode] = React.useState("");
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);

  React.useEffect(() => {
    params.then(({ code }) => setCode(code));
  }, [params]);

  if (!code) {
    return (
      <div className="min-h-screen bg-[#080D1B] text-white flex items-center justify-center">
        Loading Syncwave...
      </div>
    );
  }

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-[#080D1B] text-white">

      {/* Session Sidebar */}
      <aside
        className={`
          absolute left-0 top-0 z-40 h-full
          w-full md:w-1/4
          bg-[#080D1B] border-r border-white/10
          overflow-y-auto
          transition-transform duration-300 ease-in-out
          ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <SessionInfo code={code} />
      </aside>

      {/* Main Playback Section */}
      <main
        className={`
          h-full min-w-0 overflow-y-auto
          transition-[width,margin-left] duration-300 ease-in-out
          ${isSidebarOpen
            ? "w-full md:w-3/4 md:ml-[25%]"
            : "w-full ml-0"}
        `}
      >
        {/* Sliding Menu Button */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="fixed top-3 z-[45] p-3 rounded-xl
          bg-[#151D32] border border-white/10
          hover:bg-[#202B45] transition-all duration-300 ease-in-out"
          aria-label="Toggle session info"
          style={{
            left: isSidebarOpen ? (window.innerWidth < 768 ? "auto" : "calc(25% + 12px)") : "20px",
            right: isSidebarOpen ? (window.innerWidth < 768 ? "12px" : "auto") : "auto",
          }}
        >
          <span
            className="flex items-center justify-center
            transition-transform duration-500 ease-in-out"
            style={{
              transform: isSidebarOpen
                ? "rotate(-360deg)"
                : "rotate(0deg)",
            }}
          >
            {isSidebarOpen ? (
              <MdArrowBackIosNew size={22} />
            ) : (
              <FaClockRotateLeft size={22} />
            )}
          </span>
        </button>

        <RoomClient code={code} />
      </main>
    </div>
  );
}
