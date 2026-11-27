"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { createClient } from "@/lib/supabase/client";
import {
  resyncServerClock,
  syncServerClock,
  type ServerClock,
} from "@/lib/playback/clock";
import {
  AUDIO_SEEK_COOLDOWN_MS,
  computeTargetPosition,
  DEFAULT_YOUTUBE_STARTUP_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  planAudioDriftCorrection,
  planYouTubeDriftCorrection,
  PLAYBACK_START_DELAY_MS,
  READINESS_TIMEOUT_MS,
  updateEmaLatencyMs,
  YOUTUBE_HARD_SEEK_THRESHOLD,
  YOUTUBE_IMMEDIATE_SEEK_THRESHOLD,
  YOUTUBE_SEEK_COOLDOWN_MS,
} from "@/lib/playback/sync";
import {
  FaVideo,
  FaVideoSlash,
  FaPlay,
  FaPause,
  FaBackwardStep,
  FaForwardStep,
  FaRepeat,
  FaVolumeHigh,
  FaVolumeXmark,
  FaMusic,
  FaXmark,
  FaPlus,
} from "react-icons/fa6";
import { BsRepeat, BsRepeat1 } from "react-icons/bs";
import { GoScreenFull } from "react-icons/go";

type MediaType = "youtube" | "audio";

type SearchResult = {
  id: string;
  title: string;
  thumbnail: string;
  queueItemId?: string;
  addedBy?: string;
  position?: number;
};

type PlaybackEvent = {
  action:
    | "load"
    | "play"
    | "pause"
    | "seek"
    | "sync"
    | "prepare_playback"
    | "ready"
    | "schedule_play"
    | "volume";

  mediaType?: MediaType;
  videoId?: string;
  audioUrl?: string;
  title?: string;
  thumbnail?: string;
  queueItemId?: string;
  queuePosition?: number;
  position?: number;
  isPlaying?: boolean;
  sentAt?: number;
  startAt?: number;
  deadlineAt?: number;
  revision?: number;
  volume?: number;
  senderId: string;
};

interface PlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  cueVideoById?(
    videoId: string | { videoId: string; startSeconds?: number }
  ): void;
  loadVideoById?(
    videoId: string | { videoId: string; startSeconds?: number }
  ): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getIframe?(): HTMLIFrameElement;
  setVolume?(volume: number): void;
  getVolume?(): number;
  mute?(): void;
  unMute?(): void;
  setPlaybackRate?(suggestedRate: number): void;
  getPlaybackRate?(): number;
  getAvailablePlaybackRates?(): number[];
  destroy(): void;
}

interface YouTubeAPI {
  Player: new (
    element: HTMLElement,
    options: {
      width?: string;
      height?: string;
      videoId?: string;
      playerVars?: Record<string, number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: (event: { data: number }) => void;
      };
    }
  ) => PlayerInstance;

  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

interface YouTubeWindow extends Window {
  YT?: YouTubeAPI;
  onYouTubeIframeAPIReady?: () => void;
}

type PendingHostStart = {
  mediaType: MediaType;
  videoId?: string;
  audioUrl?: string;
  position: number;
  revision: number;
};

type PendingYouTubeStart = {
  commandAt: number;
  scheduledStartAt: number;
  scheduledPosition: number;
  targetPosition: number;
  revision: number;
};

type PendingAudioStart = {
  scheduledStartAt: number;
  scheduledPosition: number;
  revision: number;
};

let youtubeApiPromise: Promise<void> | null = null;

function loadYouTubeAPI(): Promise<void> {
  const win = window as YouTubeWindow;

  if (win.YT?.Player) {
    return Promise.resolve();
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousCallback = win.onYouTubeIframeAPIReady;

    win.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };

    let script = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]'
    );

    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;

      script.onerror = () => {
        youtubeApiPromise = null;
        reject(new Error("Unable to load YouTube player API."));
      };

      document.head.appendChild(script);
    }
  });

  return youtubeApiPromise;
}

function extractVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();

    let id: string | null = null;

    if (hostname === "youtu.be") {
      id = url.pathname.split("/").filter(Boolean)[0] || null;
    } else if (
      [
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
      ].includes(hostname)
    ) {
      id =
        url.searchParams.get("v") ||
        url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] ||
        null;
    }

    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export default function YouTubePlayer({
  roomId,
  userId,
  isHost,
  isAdmin,
}: {
  roomId: string;
  userId: string;
  isHost: boolean;
  isAdmin: boolean;
}) {
  // --------------------------------------------------
  // Refs
  // --------------------------------------------------

  const playerContainerRef = useRef<HTMLDivElement>(null);
  const videoSectionRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerInstance | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const channelRef = useRef<
    ReturnType<ReturnType<typeof createClient>["channel"]> | null
  >(null);

  const clockRef = useRef<ServerClock | null>(null);
  const clockSyncPromiseRef = useRef<Promise<ServerClock> | null>(null);

  const mediaTypeRef = useRef<MediaType>("youtube");
  const videoIdRef = useRef("");
  const audioUrlRef = useRef("");

  const isPlayingRef = useRef(false);
  const intendedPlayingRef = useRef(false);
  const playerReadyRef = useRef(false);
  const pendingYouTubeCueRef = useRef<{ videoId: string; startSeconds: number } | null>(null);

  const playbackRevisionRef = useRef(0);
  const lastScheduledRevisionRef = useRef<number | null>(null);

  const pendingPreparationRef = useRef<PlaybackEvent | null>(null);
  const pendingScheduleRef = useRef<PlaybackEvent | null>(null);
  const pendingSyncRef = useRef<PlaybackEvent | null>(null);
  const lastSyncSnapshotRef = useRef<PlaybackEvent | null>(null);
  const pendingHostStartRef = useRef<PendingHostStart | null>(null);

  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readinessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const rateResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoplayCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const pendingYouTubeStartRef = useRef<PendingYouTubeStart | null>(null);
  const pendingAudioStartRef = useRef<PendingAudioStart | null>(null);

  const estimatedYouTubeStartupMsRef = useRef(DEFAULT_YOUTUBE_STARTUP_DELAY_MS);
  const lastCorrectionAtRef = useRef(0);
  const consecutiveLargeDriftRef = useRef(0);
  const isSeekingSliderRef = useRef(false);

  const expectedReadyRef = useRef<Set<string>>(new Set());
  const receivedReadyRef = useRef<Set<string>>(new Set());
  const readyRevisionRef = useRef<number | null>(null);

  const autoPlayAfterLoadRef = useRef(false);
  const volumeRef = useRef(80);
  const mutedAutoplayRef = useRef(false);

  // Callback refs to keep YT.Player and Realtime channel effects stable
  const handlePlaybackEventRef = useRef<(event: PlaybackEvent) => Promise<void>>(
    async () => {}
  );
  const onMediaReadyRef = useRef<() => void>(() => {});
  const onYouTubePlayingRef = useRef<() => void>(() => {});
  const onYouTubeEndedRef = useRef<() => void>(() => {});
  const onPresenceJoinRef = useRef<() => void>(() => {});
  const onPresenceLeaveRef = useRef<(leftUserIds: string[]) => void>(() => {});

  // --------------------------------------------------
  // React state
  // --------------------------------------------------

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [musicQueue, setMusicQueue] = useState<SearchResult[]>([]);
  const musicQueueRef = useRef<SearchResult[]>([]);
  const currentTrackRef = useRef<SearchResult | null>(null);
  const previousTracksRef = useRef<SearchResult[]>([]);
  const [currentTrack, setCurrentTrack] = useState<SearchResult | null>(null);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
  const [draggingQueueItemId, setDraggingQueueItemId] = useState<string | null>(null);
  const queueSwipeRef = useRef<{ pointerId: number; startX: number; startY: number; card: HTMLDivElement } | null>(null);
  const [volume, setVolume] = useState(80);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchTrigger, setSearchTrigger] = useState(0);
  const [isVideoVisible, setIsVideoVisible] = useState(false);
  const [coordinatorId, setCoordinatorId] = useState<string | null>(null);
  const isCoordinator = coordinatorId === userId;
  const coordinatorRef = useRef<string | null>(null);

  const [videoId, setVideoId] = useState("");
  const [audioLoaded, setAudioLoaded] = useState(false);

  const [playerReady, setPlayerReady] = useState(false);
  const [youtubeBlocked, setYoutubeBlocked] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("Waiting for a song");
  const [syncBadge, setSyncBadge] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const [activeMediaType, setActiveMediaType] =
    useState<MediaType>("youtube");

  useEffect(() => { musicQueueRef.current = musicQueue; }, [musicQueue]);

  // Queue is room data: load it from Supabase and keep every client in sync.
  const refreshRoomQueue = useCallback(async () => {
    const supabase = createClient();
    const { data, error: queueError } = await supabase
      .from("queue_items")
      .select("id, video_id, title, thumbnail_url, added_by, position")
      .eq("room_id", roomId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (queueError) {
      console.error("Unable to load room queue:", queueError);
      setError(queueError.message || "Unable to load the room queue.");
      return;
    }

    const tracks: SearchResult[] = (data ?? []).map((row) => ({
      id: row.video_id,
      title: row.title,
      thumbnail: row.thumbnail_url || `https://img.youtube.com/vi/${row.video_id}/mqdefault.jpg`,
      queueItemId: row.id,
      addedBy: row.added_by,
      position: row.position,
    }));
    musicQueueRef.current = tracks;
    setMusicQueue(tracks);
  }, [roomId]);

  useEffect(() => {
    let active = true;
    const supabase = createClient();
    void refreshRoomQueue();

    const queueChannel = supabase
      .channel(`room-queue:${roomId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "queue_items",
      }, () => {
        if (active) void refreshRoomQueue();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (active) void refreshRoomQueue();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Room queue realtime subscription failed:", status);
        }
      });

    return () => {
      active = false;
      void supabase.removeChannel(queueChannel);
    };
  }, [roomId, refreshRoomQueue]);

  // Repeat mode is room-wide state. Host and admins update it through an RPC;
  // every room member receives the persisted value through Postgres Changes.
  useEffect(() => {
    let active = true;
    const supabase = createClient();

    const refreshRepeatMode = async () => {
      const { data, error: repeatError } = await supabase
        .from("rooms")
        .select("repeat_mode")
        .eq("id", roomId)
        .maybeSingle();
      if (repeatError) {
        console.error("Unable to load room repeat mode:", repeatError);
        return;
      }
      if (!active) return;
      if (data?.repeat_mode === "all" || data?.repeat_mode === "one" || data?.repeat_mode === "off") {
        setRepeatMode(data.repeat_mode);
      }
    };

    void refreshRepeatMode();
    const settingsChannel = supabase
      .channel(`room-settings:${roomId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "rooms",
        filter: `id=eq.${roomId}`,
      }, (payload) => {
        const mode = (payload.new as { repeat_mode?: string }).repeat_mode;
        if (mode === "off" || mode === "all" || mode === "one") setRepeatMode(mode);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void refreshRepeatMode();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Room settings realtime subscription failed:", status);
        }
      });

    return () => {
      active = false;
      void supabase.removeChannel(settingsChannel);
    };
  }, [roomId]);

  useEffect(() => {
    volumeRef.current = volume;
    playerRef.current?.setVolume?.(volume);
  }, [volume]);

  // --------------------------------------------------
  // Clock & utility helpers
  // --------------------------------------------------

  const ensureClock = useCallback(async (): Promise<ServerClock | null> => {
    if (clockRef.current) return clockRef.current;

    if (!clockSyncPromiseRef.current) {
      clockSyncPromiseRef.current = syncServerClock()
        .then((clock) => {
          clockRef.current = clock;
          setSyncBadge(`Clock RTT ${clock.rttMs}ms`);
          return clock;
        })
        .finally(() => {
          clockSyncPromiseRef.current = null;
        });
    }

    try {
      return await clockSyncPromiseRef.current;
    } catch (err) {
      console.error("Clock sync failed:", err);
      return null;
    }
  }, []);

  const broadcast = useCallback(
    (event: Omit<PlaybackEvent, "senderId">) => {
      if (coordinatorRef.current !== userId || !channelRef.current) return;

      void channelRef.current.send({
        type: "broadcast",
        event: "playback",
        payload: {
          ...event,
          senderId: userId,
        },
      });
    },
    [userId]
  );

  const getCurrentPosition = useCallback(() => {
    if (mediaTypeRef.current === "audio") {
      return audioRef.current?.currentTime ?? 0;
    }

    const player = playerRef.current;
    if (!player || typeof player.getCurrentTime !== "function") {
      return 0;
    }

    const time = player.getCurrentTime();
    return Number.isFinite(time) ? time : 0;
  }, []);

  const isYouTubeBufferingOrUnstarted = useCallback(() => {
    if (mediaTypeRef.current !== "youtube") return false;
    const player = playerRef.current;
    if (!player || typeof player.getPlayerState !== "function") return true;
    const state = player.getPlayerState();
    return state === -1 || state === 3;
  }, []);

  const isMediaReady = useCallback(() => {
    if (mediaTypeRef.current === "audio") {
      const audio = audioRef.current;
      return Boolean(
        audio && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
      );
    }

    const player = playerRef.current;
    if (!player || typeof player.getPlayerState !== "function") return false;

    return [1, 2, 3, 5].includes(player.getPlayerState());
  }, []);

  const clearRateResetTimer = useCallback(() => {
    if (rateResetTimerRef.current) {
      clearTimeout(rateResetTimerRef.current);
      rateResetTimerRef.current = null;
    }
  }, []);

  const resetPlaybackRate = useCallback(() => {
    clearRateResetTimer();

    if (mediaTypeRef.current === "audio") {
      const audio = audioRef.current;
      if (audio && audio.playbackRate !== 1) {
        audio.playbackRate = 1;
      }
      return;
    }

    const player = playerRef.current;
    if (
      player &&
      typeof player.getPlaybackRate === "function" &&
      typeof player.setPlaybackRate === "function" &&
      player.getPlaybackRate() !== 1
    ) {
      player.setPlaybackRate(1);
    }
  }, [clearRateResetTimer]);

  const clearSchedule = useCallback(() => {
    if (scheduleTimerRef.current) {
      clearTimeout(scheduleTimerRef.current);
      scheduleTimerRef.current = null;
    }

    if (autoplayCheckTimerRef.current) {
      clearTimeout(autoplayCheckTimerRef.current);
      autoplayCheckTimerRef.current = null;
    }

    pendingScheduleRef.current = null;
    pendingYouTubeStartRef.current = null;
    pendingAudioStartRef.current = null;
  }, []);

  const clearReadinessTimeout = useCallback(() => {
    if (readinessTimeoutRef.current) {
      clearTimeout(readinessTimeoutRef.current);
      readinessTimeoutRef.current = null;
    }
  }, []);

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return "0:00";

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  };

  // --------------------------------------------------
  // Drift correction (tiered: deadband -> rate -> seek)
  // --------------------------------------------------

  const applyYouTubeDriftCorrection = useCallback(
    (targetPosition: number, options?: { fromStartMeasurement?: boolean }) => {
      const player = playerRef.current;
      if (!player || mediaTypeRef.current !== "youtube") return;
      if (isYouTubeBufferingOrUnstarted()) return;

      const localPosition = getCurrentPosition();
      if (!Number.isFinite(localPosition)) return;

      const drift = targetPosition - localPosition;
      const absDrift = Math.abs(drift);
      const nowPerf = performance.now();
      const cooldownElapsed =
        nowPerf - lastCorrectionAtRef.current >= YOUTUBE_SEEK_COOLDOWN_MS;

      if (absDrift > YOUTUBE_HARD_SEEK_THRESHOLD) {
        consecutiveLargeDriftRef.current += 1;
      } else {
        consecutiveLargeDriftRef.current = 0;
      }

      // Hard seek immediately on very large gap (>2.6s) or startup,
      // otherwise wait for 2 consecutive large-drift readings to avoid false seeks.
      const allowHardSeek =
        cooldownElapsed &&
        (Boolean(options?.fromStartMeasurement) ||
          absDrift >= YOUTUBE_IMMEDIATE_SEEK_THRESHOLD ||
          consecutiveLargeDriftRef.current >= 2);

      const currentRate =
        typeof player.getPlaybackRate === "function"
          ? player.getPlaybackRate()
          : 1;
      const availableRates =
        typeof player.getAvailablePlaybackRates === "function"
          ? player.getAvailablePlaybackRates()
          : [1];

      const plan = planYouTubeDriftCorrection({
        targetPosition,
        localPosition,
        availableRates,
        currentRate,
        estimatedStartupMs: estimatedYouTubeStartupMsRef.current,
        allowHardSeek,
      });

      if (plan.action === "none") {
        resetPlaybackRate();
        setSyncBadge(`Synced (±${Math.round(absDrift * 1000)}ms)`);
        return;
      }

      if (plan.action === "rate") {
        if (typeof player.setPlaybackRate === "function") {
          clearRateResetTimer();
          if (currentRate !== plan.rate) {
            player.setPlaybackRate(plan.rate);
          }

          setSyncBadge(
            `Syncing ${plan.rate}x (${Math.round(drift * 1000)}ms)`
          );

          rateResetTimerRef.current = setTimeout(() => {
            if (
              playerRef.current &&
              typeof playerRef.current.setPlaybackRate === "function"
            ) {
              playerRef.current.setPlaybackRate(1);
            }
            rateResetTimerRef.current = null;
          }, plan.resetAfterMs);
        }
        return;
      }

      // Hard seek with startup-lead compensation
      resetPlaybackRate();
      lastCorrectionAtRef.current = nowPerf;
      consecutiveLargeDriftRef.current = 0;

      console.log("Syncwave YouTube seek correction:", {
        driftMs: Math.round(drift * 1000),
        targetPosition,
        seekTo: plan.targetPosition,
        localPosition,
      });

      setSyncBadge(`Resyncing (${Math.round(drift * 1000)}ms)`);
      player.seekTo(plan.targetPosition, true);
    },
    [
      clearRateResetTimer,
      getCurrentPosition,
      isYouTubeBufferingOrUnstarted,
      resetPlaybackRate,
    ]
  );

  const applyAudioDriftCorrection = useCallback(
    (targetPosition: number, allowImmediateSeek = false) => {
      const audio = audioRef.current;
      if (!audio || mediaTypeRef.current !== "audio") return;

      const localPosition = audio.currentTime;
      if (!Number.isFinite(localPosition)) return;

      const drift = targetPosition - localPosition;
      const absDrift = Math.abs(drift);
      const nowPerf = performance.now();
      const cooldownElapsed =
        nowPerf - lastCorrectionAtRef.current >= AUDIO_SEEK_COOLDOWN_MS;

      const plan = planAudioDriftCorrection({
        targetPosition,
        localPosition,
        currentRate: audio.playbackRate,
        allowHardSeek: allowImmediateSeek || cooldownElapsed,
      });

      if (plan.action === "none") {
        resetPlaybackRate();
        setSyncBadge(`Synced (±${Math.round(absDrift * 1000)}ms)`);
        return;
      }

      if (plan.action === "rate") {
        clearRateResetTimer();
        audio.preservesPitch = true;
        audio.playbackRate = plan.rate;
        setSyncBadge(
          `Syncing ${plan.rate.toFixed(2)}x (${Math.round(drift * 1000)}ms)`
        );

        rateResetTimerRef.current = setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.playbackRate = 1;
          }
          rateResetTimerRef.current = null;
        }, plan.resetAfterMs);
        return;
      }

      resetPlaybackRate();
      lastCorrectionAtRef.current = nowPerf;
      audio.currentTime = plan.targetPosition;
      setSyncBadge(`Resyncing (${Math.round(drift * 1000)}ms)`);
    },
    [clearRateResetTimer, resetPlaybackRate]
  );

  // --------------------------------------------------
  // READY handshake
  // --------------------------------------------------

  const sendReady = useCallback(
    (revision: number) => {
      if (readyRevisionRef.current === revision) return;

      const channel = channelRef.current;
      if (!channel) return;

      readyRevisionRef.current = revision;

      void channel.send({
        type: "broadcast",
        event: "playback",
        payload: {
          action: "ready",
          revision,
          senderId: userId,
        },
      });

      setStatus("Ready — waiting for host");
    },
    [userId]
  );

  // --------------------------------------------------
  // Load media (non-destructive if already loaded)
  // --------------------------------------------------

  const loadYouTubeVideo = useCallback(
    (id: string, startSeconds = 0, forceReload = false) => {
      const sameVideoLoaded =
        !forceReload &&
        mediaTypeRef.current === "youtube" &&
        videoIdRef.current === id &&
        isMediaReady();

      mediaTypeRef.current = "youtube";
      setActiveMediaType("youtube");

      videoIdRef.current = id;
      setVideoId(id);
      setAudioLoaded(false);
      setYoutubeBlocked(false);
      setError("");

      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.playbackRate = 1;
        if (audio.hasAttribute("src")) {
          audio.removeAttribute("src");
          audio.load();
        }
      }

      if (sameVideoLoaded) {
        const player = playerRef.current;
        if (player) {
          player.pauseVideo();
          if (Math.abs(getCurrentPosition() - startSeconds) > 0.35) {
            player.seekTo(startSeconds, true);
          }
        }
        return false;
      }

      setCurrentTime(startSeconds);
      setDuration(0);
      setStatus("Loading YouTube video");
      setSyncBadge(null);

      const player = playerRef.current;
      const cueRequest = {
        videoId: id,
        startSeconds: Math.max(0, startSeconds),
      };

      // The IFrame API methods are not callable until its player instance is ready.
      // Prefer cueing (keeps playback paused); fall back to loading when needed.
      if (!player || !playerReadyRef.current) {
        pendingYouTubeCueRef.current = cueRequest;
      } else if (typeof player.cueVideoById === "function") {
        player.cueVideoById(cueRequest);
      } else if (typeof player.loadVideoById === "function") {
        player.loadVideoById(cueRequest);
      } else {
        pendingYouTubeCueRef.current = cueRequest;
        console.warn("YouTube player is ready but has no video-loading method.");
      }

      return true;
    },
    [getCurrentPosition, isMediaReady]
  );

  const loadAudio = useCallback(
    (audioUrl: string, startSeconds = 0, forceReload = false) => {
      const audio = audioRef.current;
      const sameAudioLoaded =
        !forceReload &&
        mediaTypeRef.current === "audio" &&
        audioUrlRef.current === audioUrl &&
        Boolean(
          audio && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
        );

      mediaTypeRef.current = "audio";
      setActiveMediaType("audio");

      audioUrlRef.current = audioUrl;
      setVideoId("");
      setYoutubeBlocked(false);
      setError("");

      // Stop YouTube playback when switching media.
      playerRef.current?.pauseVideo();

      if (sameAudioLoaded && audio) {
        audio.pause();
        audio.playbackRate = 1;
        if (Math.abs(audio.currentTime - startSeconds) > 0.1) {
          audio.currentTime = startSeconds;
        }
        setAudioLoaded(true);
        return false;
      }

      setAudioLoaded(false);
      setCurrentTime(startSeconds);
      setDuration(0);
      setStatus("Loading shared audio file");
      setSyncBadge(null);

      if (audio) {
        audio.pause();
        audio.playbackRate = 1;
        audio.src = audioUrl;
        audio.currentTime = Math.max(0, startSeconds);
        audio.load();
      }

      return true;
    },
    []
  );

  // --------------------------------------------------
  // Scheduled playback
  // --------------------------------------------------

  const armScheduledPlayback = useCallback(
    async (event: PlaybackEvent) => {
      if (
        typeof event.startAt !== "number" ||
        typeof event.position !== "number"
      ) {
        return;
      }

      const clock = await ensureClock();
      if (!clock) {
        setError("Unable to synchronize playback clock.");
        return;
      }

      if (
        typeof event.revision === "number" &&
        event.revision < playbackRevisionRef.current
      ) {
        return;
      }

      if (!isMediaReady()) {
        pendingScheduleRef.current = event;
        setStatus("Waiting for media to become ready...");
        return;
      }

      if (scheduleTimerRef.current) {
        clearTimeout(scheduleTimerRef.current);
      }
      if (autoplayCheckTimerRef.current) {
        clearTimeout(autoplayCheckTimerRef.current);
      }

      pendingScheduleRef.current = event;
      resetPlaybackRate();

      const rawDelayMs = event.startAt - clock.now();

      // Pre-seek while paused so media buffers the target position before startAt
      if (rawDelayMs > 150) {
        if (mediaTypeRef.current === "audio") {
          const audio = audioRef.current;
          if (audio && Math.abs(audio.currentTime - event.position) > 0.08) {
            audio.currentTime = event.position;
          }
        } else {
          const player = playerRef.current;
          if (player && Math.abs(getCurrentPosition() - event.position) > 0.35) {
            player.seekTo(event.position, true);
          }
        }
      }

      // Compensate for learned YouTube startup delay by triggering playVideo slightly early
      const leadMs =
        mediaTypeRef.current === "youtube" && rawDelayMs > 50
          ? Math.min(
              estimatedYouTubeStartupMsRef.current,
              Math.max(0, rawDelayMs - 20)
            )
          : 0;

      const timerDelayMs = Math.max(0, rawDelayMs - leadMs);

      setStatus(
        timerDelayMs > 0
          ? "Preparing synchronized playback..."
          : "Starting synchronized playback..."
      );

      scheduleTimerRef.current = setTimeout(() => {
        const currentClock = clockRef.current;
        if (!currentClock) return;

        if (
          typeof event.revision === "number" &&
          event.revision !== playbackRevisionRef.current
        ) {
          return;
        }

        const nowServerMs = currentClock.now();
        const lateSeconds = Math.max(0, (nowServerMs - event.startAt!) / 1000);

        if (mediaTypeRef.current === "audio") {
          const audio = audioRef.current;
          if (!audio) return;

          const targetPosition = event.position! + lateSeconds;
          audio.preservesPitch = true;
          audio.playbackRate = 1;
          audio.currentTime = targetPosition;

          intendedPlayingRef.current = true;
          pendingAudioStartRef.current = {
            scheduledStartAt: event.startAt!,
            scheduledPosition: event.position!,
            revision: event.revision ?? playbackRevisionRef.current,
          };

          void audio
            .play()
            .then(() => {
              isPlayingRef.current = true;
              setIsPlaying(true);
              setStatus("Playing synchronized audio");
            })
            .catch((err) => {
              console.error("Audio playback was blocked:", err);
              intendedPlayingRef.current = false;
              pendingAudioStartRef.current = null;
              setStatus("Audio playback requires a user interaction");
            });
        } else {
          const player = playerRef.current;
          if (!player) return;

          // If starting late (past startAt), seek ahead by startup latency too
          const targetPosition =
            lateSeconds > 0
              ? event.position! +
                lateSeconds +
                estimatedYouTubeStartupMsRef.current / 1000
              : event.position!;

          if (Math.abs(getCurrentPosition() - targetPosition) > 0.2) {
            player.seekTo(targetPosition, true);
          }

          intendedPlayingRef.current = true;
          pendingYouTubeStartRef.current = {
            commandAt: performance.now(),
            scheduledStartAt: event.startAt!,
            scheduledPosition: event.position!,
            targetPosition,
            revision: event.revision ?? playbackRevisionRef.current,
          };

          // Browsers commonly block first-time audible autoplay on listener devices.
          // Start muted (allowed by most autoplay policies), then restore room volume
          // as soon as YouTube confirms PLAYING.
          if (!isCoordinator) {
            mutedAutoplayRef.current = true;
            player.mute?.();
            player.setVolume?.(0);
          }
          player.playVideo();

          // Detect browser autoplay block if player stays paused/cued
          if (!isCoordinator) {
            autoplayCheckTimerRef.current = setTimeout(() => {
              const p = playerRef.current;
              if (!p || !intendedPlayingRef.current) return;
              const state =
                typeof p.getPlayerState === "function" ? p.getPlayerState() : -1;
              if (state !== 1 && state !== 3) {
                setYoutubeBlocked(true);
                setStatus("Tap Sync Playback to allow video playback");
              }
            }, 1800);
          }
        }

        pendingScheduleRef.current = null;
        scheduleTimerRef.current = null;
      }, timerDelayMs);
    },
    [
      ensureClock,
      getCurrentPosition,
      isCoordinator,
      isMediaReady,
      resetPlaybackRate,
    ]
  );

  // --------------------------------------------------
  // Host scheduling
  // --------------------------------------------------

  const finalizeHostStart = useCallback(async () => {
    if (coordinatorRef.current !== userId) return;
    const pending = pendingHostStartRef.current;
    if (!pending) return;

    clearReadinessTimeout();

    const clock = await ensureClock();
    if (!clock) {
      setError("Could not synchronize playback.");
      pendingHostStartRef.current = null;
      return;
    }

    const startAt = clock.now() + PLAYBACK_START_DELAY_MS;

    const event: PlaybackEvent = {
      action: "schedule_play",
      mediaType: pending.mediaType,
      videoId: pending.videoId,
      audioUrl: pending.audioUrl,
      position: pending.position,
      startAt,
      revision: pending.revision,
      senderId: userId,
    };

    pendingHostStartRef.current = null;
    pendingScheduleRef.current = event;

    broadcast({
      action: "schedule_play",
      mediaType: pending.mediaType,
      videoId: pending.videoId,
      audioUrl: pending.audioUrl,
      position: pending.position,
      startAt,
      revision: pending.revision,
    });

    void armScheduledPlayback(event);

    expectedReadyRef.current.clear();
    receivedReadyRef.current.clear();

    setStatus("Synchronized playback scheduled");
  }, [
    armScheduledPlayback,
    broadcast,
    clearReadinessTimeout,
    ensureClock,
    userId,
  ]);

  const preparePlayback = useCallback(async () => {
    if (!isCoordinator) return;

    if (pendingHostStartRef.current) {
      setStatus("Waiting for listeners to get ready...");
      return;
    }

    if (!isMediaReady()) {
      setStatus("Wait until the media has loaded.");
      return;
    }

    try {
      const clock = await ensureClock();
      if (!clock) {
        setError("Unable to synchronize playback clock.");
        return;
      }

      const position = getCurrentPosition();
      const revision = playbackRevisionRef.current + 1;

      playbackRevisionRef.current = revision;
      lastScheduledRevisionRef.current = null;
      intendedPlayingRef.current = false;

      const currentMediaType = mediaTypeRef.current;

      const pending: PendingHostStart = {
        mediaType: currentMediaType,
        videoId:
          currentMediaType === "youtube" ? videoIdRef.current : undefined,
        audioUrl:
          currentMediaType === "audio" ? audioUrlRef.current : undefined,
        position,
        revision,
      };

      const presence = channelRef.current?.presenceState();

      expectedReadyRef.current = new Set(
        Object.keys(presence ?? {}).filter((id) => id !== userId)
      );

      receivedReadyRef.current.clear();
      pendingHostStartRef.current = pending;

      broadcast({
        action: "prepare_playback",
        mediaType: currentMediaType,
        videoId: pending.videoId,
        audioUrl: pending.audioUrl,
        position,
        revision,
        deadlineAt: clock.now() + READINESS_TIMEOUT_MS,
      });

      const expected = expectedReadyRef.current.size;

      setStatus(
        expected === 0
          ? "Starting synchronized playback..."
          : `Waiting for listeners: 0/${expected} ready`
      );

      readinessTimeoutRef.current = setTimeout(() => {
        console.warn("Listener readiness timeout. Starting playback.");
        void finalizeHostStart();
      }, READINESS_TIMEOUT_MS);

      if (expected === 0) {
        void finalizeHostStart();
      }
    } catch (err) {
      console.error("Unable to prepare playback:", err);
      pendingHostStartRef.current = null;
      clearReadinessTimeout();
      setError("Unable to prepare synchronized playback.");
    }
  }, [
    broadcast,
    clearReadinessTimeout,
    ensureClock,
    finalizeHostStart,
    getCurrentPosition,
    isCoordinator,
    isMediaReady,
    userId,
  ]);

  // --------------------------------------------------
  // Apply pending late-joiner sync once media becomes ready
  // --------------------------------------------------

  const applySyncSnapshot = useCallback(
    async (event: PlaybackEvent) => {
      if (typeof event.position !== "number") return;
      lastSyncSnapshotRef.current = event;

      const clock = await ensureClock();
      if (!clock) return;

      const targetPosition = computeTargetPosition(
        event.position,
        Boolean(event.isPlaying),
        event.sentAt,
        clock.now()
      );

      const shouldPlay = Boolean(event.isPlaying);
      intendedPlayingRef.current = shouldPlay;

      if (mediaTypeRef.current === "audio") {
        const audio = audioRef.current;
        if (!audio) return;

        if (!shouldPlay) {
          resetPlaybackRate();
          if (!audio.paused) {
            audio.pause();
          }
          if (Math.abs(audio.currentTime - targetPosition) > 0.2) {
            audio.currentTime = targetPosition;
          }
          return;
        }

        if (audio.paused) {
          audio.preservesPitch = true;
          audio.playbackRate = 1;
          audio.currentTime = targetPosition;
          lastCorrectionAtRef.current = performance.now();

          void audio
            .play()
            .then(() => {
              isPlayingRef.current = true;
              setIsPlaying(true);
              setStatus("Playing synchronized audio");
            })
            .catch((err) => {
              console.error("Audio play failed:", err);
              setStatus("Audio playback requires a user interaction");
            });
          return;
        }

        applyAudioDriftCorrection(targetPosition);
        return;
      }

      // YouTube sync
      const player = playerRef.current;
      if (!player) return;

      if (!shouldPlay) {
        resetPlaybackRate();
        setYoutubeBlocked(false);
        const state =
          typeof player.getPlayerState === "function"
            ? player.getPlayerState()
            : -1;
        if (state === 1 || state === 3) {
          player.pauseVideo();
        }
        if (Math.abs(getCurrentPosition() - targetPosition) > 0.35) {
          player.seekTo(targetPosition, true);
        }
        setSyncBadge("Paused");
        return;
      }

      // This function is only called after the media has been cued/loaded.
      // Do not discard a late-join snapshot merely because YouTube reports
      // BUFFERING (state 3): the listener still needs an explicit playVideo().
      const playerState =
        typeof player.getPlayerState === "function"
          ? player.getPlayerState()
          : -1;

      if (playerState !== 1) {
        const seekTarget =
          targetPosition + estimatedYouTubeStartupMsRef.current / 1000;
        lastCorrectionAtRef.current = performance.now();
        consecutiveLargeDriftRef.current = 0;

        pendingYouTubeStartRef.current = {
          commandAt: performance.now(),
          scheduledStartAt: clock.now(),
          scheduledPosition: targetPosition,
          targetPosition: seekTarget,
          revision: event.revision ?? playbackRevisionRef.current,
        };

        player.seekTo(seekTarget, true);
        if (!isCoordinator) {
          mutedAutoplayRef.current = true;
          player.mute?.();
          player.setVolume?.(0);
        }
        player.playVideo();
        if (!isCoordinator) {
          if (autoplayCheckTimerRef.current) clearTimeout(autoplayCheckTimerRef.current);
          autoplayCheckTimerRef.current = setTimeout(() => {
            const currentPlayer = playerRef.current;
            if (!currentPlayer || !intendedPlayingRef.current) return;
            const currentState = typeof currentPlayer.getPlayerState === "function"
              ? currentPlayer.getPlayerState()
              : -1;
            if (currentState !== 1 && currentState !== 3) {
              setYoutubeBlocked(true);
              setStatus("Tap Sync Playback to allow video playback");
            }
          }, 1800);
        }
        return;
      }

      applyYouTubeDriftCorrection(targetPosition);
    },
    [
      applyAudioDriftCorrection,
      applyYouTubeDriftCorrection,
      ensureClock,
      getCurrentPosition,
      isCoordinator,
      resetPlaybackRate,
    ]
  );

  // --------------------------------------------------
  // Receive playback events
  // --------------------------------------------------

  const handlePlaybackEvent = useCallback(
    async (event: PlaybackEvent) => {
      if (!event || event.senderId === userId) return;

      // Host receives listener READY acknowledgements.
      if (event.action === "ready" && isCoordinator) {
        const pending = pendingHostStartRef.current;

        if (
          !pending ||
          event.revision !== pending.revision ||
          !event.senderId
        ) {
          return;
        }

        if (!expectedReadyRef.current.has(event.senderId)) {
          return;
        }

        receivedReadyRef.current.add(event.senderId);

        const readyCount = receivedReadyRef.current.size;
        const expectedCount = expectedReadyRef.current.size;

        setStatus(
          `Waiting for listeners: ${readyCount}/${expectedCount} ready`
        );

        const everyoneReady = [...expectedReadyRef.current].every((id) =>
          receivedReadyRef.current.has(id)
        );

        if (everyoneReady) {
          await finalizeHostStart();
        }

        return;
      }

      // LOAD
      if (event.action === "load") {
        clearSchedule();
        resetPlaybackRate();
        pendingYouTubeStartRef.current = null;
        pendingAudioStartRef.current = null;
        if (event.videoId) {
          const incomingTrack: SearchResult = {
            id: event.videoId,
            title: event.title || "YouTube track",
            thumbnail: event.thumbnail || `https://img.youtube.com/vi/${event.videoId}/hqdefault.jpg`,
            queueItemId: event.queueItemId,
            position: event.queuePosition,
          };
          currentTrackRef.current = incomingTrack;
          setCurrentTrack(incomingTrack);
        }

        if (typeof event.revision === "number") {
          playbackRevisionRef.current = Math.max(
            playbackRevisionRef.current,
            event.revision
          );
        }

        intendedPlayingRef.current = false;
        autoPlayAfterLoadRef.current = false;
        pendingPreparationRef.current = null;
        pendingHostStartRef.current = null;
        pendingSyncRef.current = null;
        lastSyncSnapshotRef.current = null;

        if (event.mediaType === "audio" && event.audioUrl) {
          loadAudio(event.audioUrl, 0, true);
        } else if (event.videoId) {
          loadYouTubeVideo(event.videoId, 0, true);
        }

        return;
      }

      // PREPARE PLAYBACK
      if (event.action === "prepare_playback") {
        if (typeof event.revision !== "number" || !event.mediaType) {
          return;
        }

        if (event.revision < playbackRevisionRef.current) {
          return;
        }

        if (lastScheduledRevisionRef.current === event.revision) {
          return;
        }

        playbackRevisionRef.current = event.revision;
        readyRevisionRef.current = null;
        intendedPlayingRef.current = false;

        clearSchedule();
        resetPlaybackRate();

        pendingSyncRef.current = null;
        pendingPreparationRef.current = event;

        const targetPos = typeof event.position === "number" ? event.position : 0;

        if (event.mediaType === "audio") {
          loadAudio(event.audioUrl || "", targetPos);
        } else if (event.videoId) {
          loadYouTubeVideo(event.videoId, targetPos);
        }

        if (isMediaReady()) {
          sendReady(event.revision);
        }

        return;
      }

      // SCHEDULE PLAYBACK
      if (event.action === "schedule_play") {
        if (
          typeof event.position !== "number" ||
          typeof event.startAt !== "number" ||
          typeof event.revision !== "number"
        ) {
          return;
        }

        if (event.revision < playbackRevisionRef.current) {
          return;
        }

        if (lastScheduledRevisionRef.current === event.revision) {
          return;
        }

        playbackRevisionRef.current = event.revision;
        lastScheduledRevisionRef.current = event.revision;

        clearSchedule();
        pendingPreparationRef.current = null;
        pendingSyncRef.current = null;

        // Only load if media changed (avoid wiping buffered media from prepare_playback!)
        if (event.mediaType === "audio") {
          loadAudio(event.audioUrl || "", event.position);
        } else if (event.videoId) {
          loadYouTubeVideo(event.videoId, event.position);
        }

        pendingScheduleRef.current = event;

        if (isMediaReady()) {
          await armScheduledPlayback(event);
        } else {
          setStatus("Waiting for scheduled media to load...");
        }

        return;
      }

      // Shared room volume is host-authoritative and independent of playback revisions.
      if (event.action === "volume" && typeof event.volume === "number") {
        const nextVolume = Math.max(0, Math.min(100, event.volume));
        setVolume(nextVolume);
        playerRef.current?.setVolume?.(nextVolume);
        return;
      }

      // Ignore stale revisions for play / pause / seek / sync
      if (
        typeof event.revision === "number" &&
        event.revision < playbackRevisionRef.current
      ) {
        return;
      }

      if (typeof event.revision === "number") {
        playbackRevisionRef.current = event.revision;
      }

      // PLAY
      if (event.action === "play") {
        if (event.mediaType && event.mediaType !== mediaTypeRef.current) {
          if (event.mediaType === "audio" && event.audioUrl) {
            pendingSyncRef.current = { ...event, isPlaying: true };
            loadAudio(event.audioUrl, event.position ?? 0);
            return;
          }
          if (event.mediaType === "youtube" && event.videoId) {
            pendingSyncRef.current = { ...event, isPlaying: true };
            loadYouTubeVideo(event.videoId, event.position ?? 0);
            return;
          }
        }

        clearSchedule();
        await applySyncSnapshot({ ...event, isPlaying: true });
        return;
      }

      // PAUSE
      if (event.action === "pause") {
        if (event.mediaType && event.mediaType !== mediaTypeRef.current) {
          return;
        }

        clearSchedule();
        resetPlaybackRate();
        intendedPlayingRef.current = false;
        pendingSyncRef.current = null;

        if (mediaTypeRef.current === "audio") {
          const audio = audioRef.current;
          if (audio) {
            audio.pause();
            if (typeof event.position === "number") {
              audio.currentTime = event.position;
            }
          }
        } else {
          const player = playerRef.current;
          if (player) {
            player.pauseVideo();
            if (typeof event.position === "number") {
              player.seekTo(event.position, true);
            }
          }
        }

        setSyncBadge("Paused");
        return;
      }

      // SEEK
      if (event.action === "seek" && typeof event.position === "number") {
        if (event.mediaType && event.mediaType !== mediaTypeRef.current) {
          return;
        }

        clearSchedule();
        resetPlaybackRate();
        lastCorrectionAtRef.current = performance.now();
        consecutiveLargeDriftRef.current = 0;

        const clock = await ensureClock();
        const targetPosition = clock
          ? computeTargetPosition(
              event.position,
              Boolean(event.isPlaying ?? intendedPlayingRef.current),
              event.sentAt,
              clock.now()
            )
          : event.position;

        if (mediaTypeRef.current === "audio") {
          if (audioRef.current) {
            audioRef.current.currentTime = targetPosition;
          }
        } else {
          const lead =
            event.isPlaying ?? intendedPlayingRef.current
              ? estimatedYouTubeStartupMsRef.current / 1000
              : 0;
          playerRef.current?.seekTo(targetPosition + lead, true);
        }

        return;
      }

      // PERIODIC HOST SYNC (also handles late joiners & mode switches)
      if (event.action === "sync" && typeof event.position === "number") {
        if (event.videoId) {
          const incomingTrack: SearchResult = {
            id: event.videoId,
            title: event.title || "YouTube track",
            thumbnail: event.thumbnail || `https://img.youtube.com/vi/${event.videoId}/hqdefault.jpg`,
            queueItemId: event.queueItemId,
            position: event.queuePosition,
          };
          currentTrackRef.current = incomingTrack;
          setCurrentTrack(incomingTrack);
        }
        if (typeof event.volume === "number") {
          const nextVolume = Math.max(0, Math.min(100, event.volume));
          setVolume(nextVolume);
          playerRef.current?.setVolume?.(nextVolume);
        }
        if (pendingScheduleRef.current) return;

        // Switch media if listener joined late or missed the load event
        if (
          event.mediaType === "audio" &&
          (mediaTypeRef.current !== "audio" ||
            (event.audioUrl && event.audioUrl !== audioUrlRef.current))
        ) {
          pendingSyncRef.current = event;
          loadAudio(event.audioUrl || "", event.position);
          return;
        }

        if (
          (event.mediaType === "youtube" || event.videoId) &&
          event.videoId &&
          (mediaTypeRef.current !== "youtube" ||
            event.videoId !== videoIdRef.current)
        ) {
          pendingSyncRef.current = event;
          loadYouTubeVideo(event.videoId, event.position);
          return;
        }

        if (!isMediaReady()) {
          pendingSyncRef.current = event;
          return;
        }

        pendingSyncRef.current = null;
        await applySyncSnapshot(event);
      }
    },
    [
      applySyncSnapshot,
      armScheduledPlayback,
      clearSchedule,
      ensureClock,
      finalizeHostStart,
      isCoordinator,
      isMediaReady,
      loadAudio,
      loadYouTubeVideo,
      resetPlaybackRate,
      sendReady,
      userId,
    ]
  );

  // Keep refs updated for stable long-lived effects
  useEffect(() => {
    handlePlaybackEventRef.current = handlePlaybackEvent;
  }, [handlePlaybackEvent]);

  useEffect(() => {
    onMediaReadyRef.current = () => {
      const preparation = pendingPreparationRef.current;
      if (
        preparation &&
        preparation.mediaType === mediaTypeRef.current &&
        typeof preparation.revision === "number"
      ) {
        sendReady(preparation.revision);
      }

      if (pendingScheduleRef.current && isMediaReady()) {
        void armScheduledPlayback(pendingScheduleRef.current);
        return;
      }

      if (
        autoPlayAfterLoadRef.current &&
        isCoordinator &&
        mediaTypeRef.current === "youtube" &&
        isMediaReady()
      ) {
        autoPlayAfterLoadRef.current = false;
        void preparePlayback();
        return;
      }

      if (pendingSyncRef.current && isMediaReady()) {
        const snapshot = pendingSyncRef.current;
        pendingSyncRef.current = null;
        void applySyncSnapshot(snapshot);
      }
    };
  }, [
    applySyncSnapshot,
    armScheduledPlayback,
    isCoordinator,
    isMediaReady,
    preparePlayback,
    sendReady,
  ]);

  useEffect(() => {
    onYouTubePlayingRef.current = () => {
      setYoutubeBlocked(false);
      if (autoplayCheckTimerRef.current) {
        clearTimeout(autoplayCheckTimerRef.current);
        autoplayCheckTimerRef.current = null;
      }

      const measurement = pendingYouTubeStartRef.current;
      if (!measurement) return;

      pendingYouTubeStartRef.current = null;

      const actualPlayingAt = performance.now();
      const startupDelayMs = actualPlayingAt - measurement.commandAt;

      estimatedYouTubeStartupMsRef.current = updateEmaLatencyMs(
        estimatedYouTubeStartupMsRef.current,
        startupDelayMs
      );

      const serverNow = clockRef.current?.now();
      if (serverNow === undefined) return;

      const expectedPosition =
        measurement.scheduledPosition +
        (serverNow - measurement.scheduledStartAt) / 1000;

      console.log("YouTube STARTUP MEASUREMENT:", {
        revision: measurement.revision,
        startupDelayMs: Math.round(startupDelayMs),
        emaStartupMs: estimatedYouTubeStartupMsRef.current,
        lateByMs: Math.round(serverNow - measurement.scheduledStartAt),
        expectedPosition,
        actualPosition: getCurrentPosition(),
      });

      // Immediately reconcile residual startup skew (prefer rate-nudge over seek!)
      applyYouTubeDriftCorrection(Math.max(0, expectedPosition), {
        fromStartMeasurement: true,
      });
    };
  }, [applyYouTubeDriftCorrection, getCurrentPosition]);

  useEffect(() => {
    onPresenceJoinRef.current = () => {
      if (!isCoordinator || !clockRef.current) return;

      if (pendingScheduleRef.current) {
        broadcast({
          action: "schedule_play",
          mediaType: pendingScheduleRef.current.mediaType,
          videoId: pendingScheduleRef.current.videoId,
          audioUrl: pendingScheduleRef.current.audioUrl,
          position: pendingScheduleRef.current.position,
          startAt: pendingScheduleRef.current.startAt,
          revision: pendingScheduleRef.current.revision,
        });
        return;
      }

      if (
        (mediaTypeRef.current === "youtube" && videoIdRef.current) ||
        (mediaTypeRef.current === "audio" && audioLoaded)
      ) {
        broadcast({
          action: "sync",
          mediaType: mediaTypeRef.current,
          videoId: videoIdRef.current || undefined,
          audioUrl:
            mediaTypeRef.current === "audio" ? audioUrlRef.current : undefined,
          title: currentTrackRef.current?.title,
          thumbnail: currentTrackRef.current?.thumbnail,
          queueItemId: currentTrackRef.current?.queueItemId,
          queuePosition: currentTrackRef.current?.position,
          position: getCurrentPosition(),
          isPlaying: intendedPlayingRef.current,
          volume: volumeRef.current,
          sentAt: clockRef.current.now(),
          revision: playbackRevisionRef.current,
        });
      }
    };

    onPresenceLeaveRef.current = (leftUserIds: string[]) => {
      if (!isCoordinator || !pendingHostStartRef.current) return;

      let changed = false;
      for (const id of leftUserIds) {
        if (expectedReadyRef.current.delete(id)) {
          changed = true;
        }
      }

      if (!changed) return;

      const everyoneReady = [...expectedReadyRef.current].every((id) =>
        receivedReadyRef.current.has(id)
      );

      if (everyoneReady) {
        void finalizeHostStart();
      } else {
        setStatus(
          `Waiting for listeners: ${receivedReadyRef.current.size}/${expectedReadyRef.current.size} ready`
        );
      }
    };
  }, [
    audioLoaded,
    broadcast,
    finalizeHostStart,
    getCurrentPosition,
    isCoordinator,
  ]);

  // --------------------------------------------------
  // Initialize YouTube player (mounted once)
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function initializePlayer() {
      try {
        await loadYouTubeAPI();

        if (cancelled || !playerContainerRef.current) return;

        const win = window as YouTubeWindow;
        if (!win.YT?.Player) {
          throw new Error("YouTube player unavailable.");
        }

        playerRef.current = new win.YT.Player(playerContainerRef.current, {
          width: "100%",
          height: "100%",

          playerVars: {
            playsinline: 1,
            controls: 0,
            rel: 0,
          },

          events: {
            onReady: () => {
              if (cancelled) return;
              playerReadyRef.current = true;
              const iframe = playerRef.current?.getIframe?.();
              iframe?.setAttribute(
                "allow",
                "autoplay; encrypted-media; picture-in-picture; fullscreen"
              );
              playerRef.current?.setVolume?.(volumeRef.current);
              const pendingCue = pendingYouTubeCueRef.current;
              const readyPlayer = playerRef.current;
              if (pendingCue && readyPlayer) {
                if (typeof readyPlayer.cueVideoById === "function") {
                  readyPlayer.cueVideoById(pendingCue);
                  pendingYouTubeCueRef.current = null;
                } else if (typeof readyPlayer.loadVideoById === "function") {
                  readyPlayer.loadVideoById(pendingCue);
                  pendingYouTubeCueRef.current = null;
                }
              }
              setPlayerReady(true);
              // A late joiner's sync may have arrived before the IFrame API was ready.
              // Re-run the existing readiness handler once the player is initialized.
              onMediaReadyRef.current();
            },

            onStateChange: (event) => {
              if (cancelled) return;

              const state = event.data;
              const ytWin = window as YouTubeWindow;
              const states = ytWin.YT?.PlayerState;
              if (!states) return;

              if (state === states.PLAYING) {
                isPlayingRef.current = true;
                setIsPlaying(true);
                if (mutedAutoplayRef.current) {
                  mutedAutoplayRef.current = false;
                  playerRef.current?.unMute?.();
                  playerRef.current?.setVolume?.(volumeRef.current);
                }
                setYoutubeBlocked(false);
                setStatus("Playing");
                onYouTubePlayingRef.current();
              } else if (state === states.PAUSED) {
                isPlayingRef.current = false;
                setIsPlaying(false);
                setStatus("Paused");
              } else if (state === states.BUFFERING) {
                setStatus("Buffering...");
              } else if (state === states.ENDED) {
                isPlayingRef.current = false;
                intendedPlayingRef.current = false;
                setIsPlaying(false);
                setStatus("Finished");
                // Only the host owns the queue; it advances once and broadcasts the next load.
                onYouTubeEndedRef.current();
              }

              if (
                [states.PLAYING, states.PAUSED, states.BUFFERING, states.CUED].includes(state)
              ) {
                onMediaReadyRef.current();
              }
            },

            onError: (event) => {
              if (cancelled) return;

              const messages: Record<number, string> = {
                2: "Invalid video ID.",
                5: "This video cannot be played in the HTML5 player.",
                100: "This video was removed or is private.",
                101: "The owner does not allow embedding this video.",
                150: "The owner does not allow embedding this video.",
              };

              setError(
                messages[event.data] || "YouTube could not play this video."
              );
              setStatus("Unavailable");
            },
          },
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Player initialization failed."
          );
        }
      }
    }

    void initializePlayer();

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
      playerReadyRef.current = false;
    };
  }, []);

  // --------------------------------------------------
  // Supabase Realtime subscription (stable across renders)
  // --------------------------------------------------

  useEffect(() => {
    if (!roomId || !userId) return;

    const supabase = createClient();

    const channel = supabase.channel(`playback:${roomId}`, {
      config: {
        broadcast: {
          self: false,
        },
        presence: {
          key: userId,
        },
      },
    });

    channelRef.current = channel;

    channel.on("broadcast", { event: "playback" }, ({ payload }) => {
      void handlePlaybackEventRef.current(payload as PlaybackEvent);
    });

    channel.on("presence", { event: "join" }, ({ key }) => {
      if (key !== userId) {
        onPresenceJoinRef.current();
      }
    });

    channel.on("presence", { event: "leave" }, ({ leftPresences }) => {
      const leftIds = leftPresences
        .map((p) => (p as { user_id?: string }).user_id)
        .filter((id): id is string => Boolean(id));
      if (leftIds.length > 0) onPresenceLeaveRef.current(leftIds);
    });

    // Elect one online host/admin. Host has priority while online; otherwise
    // admins are ordered by user ID so every client reaches the same result.
    channel.on("presence", { event: "sync" }, () => {
      const presence = channel.presenceState() as Record<string, Array<{
        user_id?: string; is_host?: boolean; is_admin?: boolean;
      }>>;
      const candidates = Object.values(presence).flat().filter((member) =>
        Boolean(member.user_id && (member.is_host || member.is_admin))
      );
      candidates.sort((a, b) => {
        if (Boolean(a.is_host) !== Boolean(b.is_host)) return a.is_host ? -1 : 1;
        return String(a.user_id).localeCompare(String(b.user_id));
      });
      const nextCoordinator = candidates[0]?.user_id ?? null;
      coordinatorRef.current = nextCoordinator;
      setCoordinatorId(nextCoordinator);
    });

    channel.subscribe((subStatus) => {
      if (subStatus === "SUBSCRIBED") {
        void channel.track({
          user_id: userId,
          is_host: isHost,
          is_admin: isAdmin,
          online_at: new Date().toISOString(),
        });
      }

      if (subStatus === "CHANNEL_ERROR" || subStatus === "TIMED_OUT") {
        setError("Realtime playback connection failed.");
      }
    });

    return () => {
      channelRef.current = null;

      clearReadinessTimeout();
      clearSchedule();
      clearRateResetTimer();
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current);
        seekDebounceRef.current = null;
      }

      pendingHostStartRef.current = null;
      pendingPreparationRef.current = null;
      pendingSyncRef.current = null;

      void supabase.removeChannel(channel);
    };
  }, [
    roomId,
    userId,
    isHost,
    isAdmin,
    clearRateResetTimer,
    clearReadinessTimeout,
    clearSchedule,
  ]);

  // --------------------------------------------------
  // Synchronize server clock (periodic + visibility resync)
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function refreshClock() {
      try {
        const clock = await resyncServerClock(clockRef.current);
        if (!cancelled) {
          clockRef.current = clock;
          setSyncBadge((prev) => prev ?? `Clock RTT ${clock.rttMs}ms`);
          console.log("Syncwave clock synchronized:", {
            offsetMs: clock.offsetMs,
            rttMs: clock.rttMs,
          });
        }
      } catch (err) {
        console.error("Unable to synchronize clock:", err);
        if (!cancelled && !clockRef.current) {
          setError("Unable to synchronize playback clock. Retrying...");
        }
      }
    }

    void refreshClock();

    const interval = window.setInterval(() => {
      void refreshClock();
    }, 60000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshClock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // --------------------------------------------------
  // Host heartbeat
  // --------------------------------------------------

  useEffect(() => {
    if (!isCoordinator) return;

    const interval = window.setInterval(() => {
      const channel = channelRef.current;
      const clock = clockRef.current;
      if (!channel || !clock) return;

      // Do not broadcast stale state while waiting for peers to prepare.
      if (pendingHostStartRef.current) return;

      // If a scheduled start countdown is active, re-send it for late joiners.
      if (pendingScheduleRef.current) {
        const sched = pendingScheduleRef.current;
        void channel.send({
          type: "broadcast",
          event: "playback",
          payload: {
            action: "schedule_play",
            mediaType: sched.mediaType,
            videoId: sched.videoId,
            audioUrl: sched.audioUrl,
            position: sched.position,
            startAt: sched.startAt,
            revision: sched.revision,
            senderId: userId,
          },
        });
        return;
      }

      if (mediaTypeRef.current === "youtube" && !videoIdRef.current) return;

      let position = getCurrentPosition();

      // If host just triggered play and YouTube is still buffering to start,
      // project from the scheduled start timeline so listeners aren't pulled back.
      const ytPending = pendingYouTubeStartRef.current;
      if (intendedPlayingRef.current && ytPending) {
        position =
          ytPending.scheduledPosition +
          Math.max(0, (clock.now() - ytPending.scheduledStartAt) / 1000);
      }

      if (!Number.isFinite(position)) return;

      void channel.send({
        type: "broadcast",
        event: "playback",
        payload: {
          action: "sync",
          mediaType: mediaTypeRef.current,
          videoId: videoIdRef.current || undefined,
          audioUrl:
            mediaTypeRef.current === "audio" ? audioUrlRef.current : undefined,
          title: currentTrackRef.current?.title,
          thumbnail: currentTrackRef.current?.thumbnail,
          queueItemId: currentTrackRef.current?.queueItemId,
          queuePosition: currentTrackRef.current?.position,
          position,
          isPlaying: intendedPlayingRef.current,
          volume: volumeRef.current,
          sentAt: clock.now(),
          revision: playbackRevisionRef.current,
          senderId: userId,
        },
      });
    }, HEARTBEAT_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [isCoordinator, userId, getCurrentPosition]);

  // --------------------------------------------------
  // Progress slider
  // --------------------------------------------------

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (isSeekingSliderRef.current) return;

      if (mediaTypeRef.current === "audio") {
        const audio = audioRef.current;
        if (!audio) return;

        if (Number.isFinite(audio.currentTime)) {
          setCurrentTime(audio.currentTime);
        }
        if (Number.isFinite(audio.duration)) {
          setDuration(audio.duration);
        }
      } else {
        const player = playerRef.current;
        if (!player || !playerReadyRef.current) return;

        const time = player.getCurrentTime();
        const total = player.getDuration();

        if (Number.isFinite(time)) setCurrentTime(time);
        if (Number.isFinite(total)) setDuration(total);
      }
    }, 400);

    return () => window.clearInterval(interval);
  }, []);

  // --------------------------------------------------
  // Music search and queue
  // --------------------------------------------------

  useEffect(() => {
    const query = searchTerm.trim();
    if (!query) {
      setSearchLoading(false);
      setSearchResults([]);
      setSearchError("");
      return;
    }

    let cancelled = false;
    setSearchLoading(false);
    const timeout = window.setTimeout(async () => {
      const directId = extractVideoId(query);
      if (directId) {
        if (!cancelled) {
          setSearchResults([{
            id: directId,
            title: `YouTube video (${directId})`,
            thumbnail: `https://img.youtube.com/vi/${directId}/mqdefault.jpg`,
          }]);
          setSearchError("");
        }
        return;
      }

      try {
        setSearchLoading(true);
        setSearchError("");
        const response = await fetch(
          `/api/search?query=${encodeURIComponent(query)}`
        );
        if (!response.ok) throw new Error("Search request failed");
        const data = await response.json();
        const items: SearchResult[] = (data.results ?? [])
          .filter((item: any) => item?.id)
          .map((item: any) => ({
            id: String(item.id),
            title: String(item.title ?? "YouTube video"),
            thumbnail:
              item.thumbnail ||
              `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`,
          }));
        if (!cancelled) setSearchResults(items);
      } catch (err) {
        console.error("Music search failed:", err);
        if (!cancelled) {
          setSearchResults([]);
          setSearchError("Couldn't search YouTube. Please try again.");
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, searchTrigger > 0 ? 0 : 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      // If the user clears or replaces the query, never leave a stale spinner.
      setSearchLoading(false);
    };
  }, [searchTerm, searchTrigger]);

  async function requestAdminCommand(command: Record<string, unknown>) {
    if (!isAdmin || isCoordinator) return false;
    const supabase = createClient();
    const { error: commandError } = await supabase.rpc(
      "request_room_playback_command",
      { p_room_id: roomId, p_command: command }
    );
    if (commandError) {
      console.error("Unable to send playback command:", commandError);
      setError(commandError.message || "Unable to send playback command.");
      return false;
    }
    setStatus("Sending command to playback coordinator...");
    return true;
  }

  async function persistCurrentQueuePointer(track: SearchResult | null) {
    const supabase = createClient();
    const { error: pointerError } = await supabase.rpc("set_current_queue_item", {
      p_room_id: roomId,
      p_queue_item_id: track?.queueItemId ?? null,
    });
    if (pointerError) {
      console.error("Unable to update current queue pointer:", pointerError);
      setError(pointerError.message || "Unable to update the current queue track.");
    }
  }

  function loadQueueTrack(track: SearchResult, startPlayback: boolean) {
    if (!isCoordinator) return;
    currentTrackRef.current = track;
    setCurrentTrack(track);

    clearSchedule();
    clearReadinessTimeout();
    resetPlaybackRate();
    intendedPlayingRef.current = false;
    pendingHostStartRef.current = null;
    pendingPreparationRef.current = null;
    playbackRevisionRef.current += 1;
    lastScheduledRevisionRef.current = null;

    pendingYouTubeStartRef.current = null;
    pendingAudioStartRef.current = null;
    autoPlayAfterLoadRef.current = startPlayback;
    loadYouTubeVideo(track.id, 0, true);
    void persistCurrentQueuePointer(track);

    broadcast({
      action: "load",
      mediaType: "youtube",
      videoId: track.id,
      title: track.title,
      thumbnail: track.thumbnail,
      queueItemId: track.queueItemId,
      queuePosition: track.position,
      position: 0,
      revision: playbackRevisionRef.current,
    });

    setStatus(startPlayback ? "Loading track before synchronized play..." : "Track loaded");
  }

  async function addTrackToQueue(track: SearchResult): Promise<SearchResult | null> {
    const supabase = createClient();
    const { data: queueItemId, error: addError } = await supabase.rpc("add_queue_item", {
      p_room_id: roomId,
      p_video_id: track.id,
      p_title: track.title,
      p_thumbnail_url: track.thumbnail,
    });
    if (addError || !queueItemId) {
      console.error("Unable to add track to room queue:", addError);
      setError(addError?.message || "Unable to add this track to the queue.");
      return null;
    }
    setSearchTerm("");
    await refreshRoomQueue();
    const queued = musicQueueRef.current.find((item) => item.queueItemId === queueItemId);
    return queued ?? { ...track, queueItemId };
  }

  async function removeQueuedTrack(track: SearchResult) {
    if (!track.queueItemId) return;
    const supabase = createClient();
    const { error: removeError } = await supabase
      .from("queue_items")
      .delete()
      .eq("id", track.queueItemId)
      .eq("room_id", roomId);
    if (removeError) {
      console.error("Unable to remove queued track:", removeError);
      setError(removeError.message || "Unable to remove this track.");
      return;
    }
    await refreshRoomQueue();
  }

  async function playTrackNow(track: SearchResult) {
    if (!isCoordinator) {
      if (isAdmin) {
        void requestAdminCommand({
          action: "load", mediaType: "youtube", videoId: track.id,
          title: track.title, thumbnail: track.thumbnail,
          queueItemId: track.queueItemId,
          queuePosition: track.position,
        });
        setSearchTerm("");
      }
      return;
    }
    let selectedTrack = track;
    // A track started directly from search also becomes part of the persistent
    // playlist, so the queue cursor always has a durable position.
    if (!selectedTrack.queueItemId) {
      const queued = await addTrackToQueue(selectedTrack);
      if (!queued) return;
      selectedTrack = queued;
    }
    if (currentTrackRef.current && currentTrackRef.current.id !== selectedTrack.id) {
      previousTracksRef.current.push(currentTrackRef.current);
    }
    setSearchTerm("");
    loadQueueTrack(selectedTrack, true);
  }

  function playNextTrack(fromEnded = false) {
    if (!isCoordinator) {
      if (isAdmin) void requestAdminCommand({ action: "next" });
      return;
    }

    const active = currentTrackRef.current;
    if (repeatMode === "one" && active) {
      loadQueueTrack(active, true);
      return;
    }

    const queue = musicQueueRef.current;
    const next = active?.position != null
      ? queue.find((item) => (item.position ?? 0) > active.position!)
      : queue[0];
    if (next) {
      if (active) previousTracksRef.current.push(active);
      loadQueueTrack(next, true);
      return;
    }

    // Repeat-all wraps the cursor to the first playlist item. Played rows stay
    // in the database; newly added rows remain after the current cursor.
    if (repeatMode === "all" && queue.length > 0) {
      const first = queue[0];
      previousTracksRef.current = [];
      loadQueueTrack(first, true);
      return;
    }

    if (fromEnded) setStatus("Queue finished");
  }

  function playPreviousTrack() {
    if (!isCoordinator) {
      if (isAdmin) void requestAdminCommand({ action: "previous" });
      return;
    }
    const previous = previousTracksRef.current.pop();
    if (previous) {
      loadQueueTrack(previous, true);
      return;
    }
    // No previous item: restart the current track.
    commitSeek(0);
    if (!intendedPlayingRef.current) void preparePlayback();
  }

  function changeVolume(value: number) {
    if (!isCoordinator) {
      if (isAdmin) {
        const nextVolume = Math.max(0, Math.min(100, value));
        setVolume(nextVolume);
        void requestAdminCommand({ action: "volume", volume: nextVolume });
      }
      return;
    }
    const nextVolume = Math.max(0, Math.min(100, value));
    setVolume(nextVolume);
    playerRef.current?.setVolume?.(nextVolume);
    broadcast({
      action: "volume",
      mediaType: "youtube",
      volume: nextVolume,
      revision: playbackRevisionRef.current,
    });
  }

  async function cycleRepeatMode() {
    if (!canControlPlayback) return;
    const nextMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    const supabase = createClient();
    const { error: repeatError } = await supabase.rpc("set_room_repeat_mode", {
      p_room_id: roomId,
      p_repeat_mode: nextMode,
    });
    if (repeatError) {
      console.error("Unable to update room repeat mode:", repeatError);
      setError(repeatError.message || "Unable to update repeat mode.");
      return;
    }
    // Update the controller immediately; other clients receive the DB change.
    setRepeatMode(nextMode);
  }

  async function reorderUpcomingTracks(draggedId: string, targetId: string) {
    if (!canControlPlayback || !draggedId || !targetId || draggedId === targetId) return;
    const queue = musicQueueRef.current;
    const currentPosition = currentTrackRef.current?.position;
    const upcoming = queue.filter((item) =>
      currentPosition == null || (item.position ?? 0) > currentPosition
    );
    const fromIndex = upcoming.findIndex((item) => item.queueItemId === draggedId);
    const toIndex = upcoming.findIndex((item) => item.queueItemId === targetId);
    if (fromIndex < 0 || toIndex < 0) return;

    const reordered = [...upcoming];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    const supabase = createClient();
    const { error: reorderError } = await supabase.rpc("reorder_room_queue", {
      p_room_id: roomId,
      p_queue_item_ids: reordered.map((item) => item.queueItemId),
    });
    if (reorderError) {
      console.error("Unable to reorder room queue:", reorderError);
      setError(reorderError.message || "Unable to reorder the queue.");
      return;
    }
    await refreshRoomQueue();
  }

  useEffect(() => {
    onYouTubeEndedRef.current = () => {
      if (!isCoordinator) return;
      playNextTrack(true);
    };
  }, [isCoordinator, musicQueue, repeatMode, currentTrack]);

  // --------------------------------------------------
  // Enable browser playback / unlock autoplay
  // --------------------------------------------------

  function resumeBlockedYouTube() {
    const player = playerRef.current;
    if (!player) return;
    setYoutubeBlocked(false);
    setStatus("Syncing video...");
    if (intendedPlayingRef.current && lastSyncSnapshotRef.current) {
      void applySyncSnapshot(lastSyncSnapshotRef.current);
    } else {
      player.playVideo();
    }
  }

  // --------------------------------------------------
  // Play / pause
  // --------------------------------------------------

  async function togglePlayback() {
    if (!isCoordinator) {
      if (isAdmin) await requestAdminCommand({ action: isPlaying ? "pause" : "play" });
      return;
    }

    if (mediaTypeRef.current === "audio") {
      const audio = audioRef.current;
      if (!audio || !audioLoaded) return;

      if (intendedPlayingRef.current || isPlayingRef.current) {
        const position = audio.currentTime;

        clearSchedule();
        clearReadinessTimeout();
        resetPlaybackRate();

        intendedPlayingRef.current = false;
        playbackRevisionRef.current += 1;
        pendingHostStartRef.current = null;
        pendingPreparationRef.current = null;

        expectedReadyRef.current.clear();
        receivedReadyRef.current.clear();

        audio.pause();

        broadcast({
          action: "pause",
          mediaType: "audio",
          position,
          revision: playbackRevisionRef.current,
          sentAt: clockRef.current?.now(),
        });

        return;
      }

      await preparePlayback();
      return;
    }

    const player = playerRef.current;
    if (!player || !playerReady || !videoId) return;

    if (intendedPlayingRef.current || isPlayingRef.current) {
      const position = player.getCurrentTime() || 0;

      clearSchedule();
      clearReadinessTimeout();
      resetPlaybackRate();

      intendedPlayingRef.current = false;
      playbackRevisionRef.current += 1;
      pendingHostStartRef.current = null;
      pendingPreparationRef.current = null;

      expectedReadyRef.current.clear();
      receivedReadyRef.current.clear();

      player.pauseVideo();

      broadcast({
        action: "pause",
        mediaType: "youtube",
        position,
        revision: playbackRevisionRef.current,
        sentAt: clockRef.current?.now(),
      });

      return;
    }

    await preparePlayback();
  }

  // --------------------------------------------------
  // Seek (debounced for smooth scrubbing without flooding peers)
  // --------------------------------------------------

  function commitSeek(value: number) {
    if (!isCoordinator) {
      if (isAdmin) void requestAdminCommand({ action: "seek", position: value });
      return;
    }

    clearSchedule();
    clearReadinessTimeout();
    resetPlaybackRate();

    pendingHostStartRef.current = null;
    pendingPreparationRef.current = null;
    playbackRevisionRef.current += 1;
    lastCorrectionAtRef.current = performance.now();

    if (mediaTypeRef.current === "audio") {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = value;
    } else {
      playerRef.current?.seekTo(value, true);
    }

    broadcast({
      action: "seek",
      mediaType: mediaTypeRef.current,
      position: value,
      isPlaying: intendedPlayingRef.current,
      sentAt: clockRef.current?.now(),
      revision: playbackRevisionRef.current,
    });
  }

  function handleSeekChange(value: number) {
    if (!isHost && !isAdmin) return;

    isSeekingSliderRef.current = true;
    setCurrentTime(value);

    if (seekDebounceRef.current) {
      clearTimeout(seekDebounceRef.current);
    }

    seekDebounceRef.current = setTimeout(() => {
      isSeekingSliderRef.current = false;
      seekDebounceRef.current = null;
      commitSeek(value);
    }, 120);
  }

  // Keep the host command listener connected to the latest render's handlers.
  const commandHandlersRef = useRef<{
    togglePlayback: () => Promise<void>;
    commitSeek: (value: number) => void;
    changeVolume: (value: number) => void;
    playTrackNow: (track: SearchResult) => void;
    playNextTrack: (fromEnded?: boolean) => void;
    playPreviousTrack: () => void;
  }>({
    togglePlayback,
    commitSeek,
    changeVolume,
    playTrackNow,
    playNextTrack,
    playPreviousTrack,
  });

  commandHandlersRef.current = {
    togglePlayback,
    commitSeek,
    changeVolume,
    playTrackNow,
    playNextTrack,
    playPreviousTrack,
  };

  // --------------------------------------------------
  // Secure admin command relay: only the elected coordinator executes commands
  // --------------------------------------------------

  useEffect(() => {
    if (!isCoordinator || !roomId) return;

    const supabase = createClient();
    const seenCommandIds = new Set<string>();
    let commandQueue = Promise.resolve();

    const enqueueCommand = (row: {
      id: string;
      command: Record<string, unknown>;
    }) => {
      if (!row?.id || seenCommandIds.has(row.id)) return;
      seenCommandIds.add(row.id);

      commandQueue = commandQueue.then(async () => {
        try {
          const command = row.command || {};
          const action = command.action;
          const handlers = commandHandlersRef.current;

          if (
            action === "play" &&
            !intendedPlayingRef.current &&
            !isPlayingRef.current
          ) {
            await handlers.togglePlayback();
          } else if (
            action === "pause" &&
            (intendedPlayingRef.current || isPlayingRef.current)
          ) {
            await handlers.togglePlayback();
          } else if (
            action === "seek" &&
            typeof command.position === "number"
          ) {
            handlers.commitSeek(command.position);
          } else if (
            action === "volume" &&
            typeof command.volume === "number"
          ) {
            handlers.changeVolume(command.volume);
          } else if (
            action === "load" &&
            typeof command.videoId === "string"
          ) {
            const track: SearchResult = {
              id: command.videoId,
              title:
                typeof command.title === "string"
                  ? command.title
                  : "YouTube track",
              thumbnail:
                typeof command.thumbnail === "string"
                  ? command.thumbnail
                  : `https://img.youtube.com/vi/${command.videoId}/hqdefault.jpg`,
              queueItemId:
                typeof command.queueItemId === "string" ? command.queueItemId : undefined,
              position:
                typeof command.queuePosition === "number" ? command.queuePosition : undefined,
            };
            handlers.playTrackNow(track);
          } else if (action === "next") {
            handlers.playNextTrack(false);
          } else if (action === "previous") {
            handlers.playPreviousTrack();
          }
        } catch (commandError) {
          console.error(
            "Failed to execute admin playback command:",
            commandError
          );
        } finally {
          const { error: deleteError } = await supabase
            .from("room_playback_commands")
            .delete()
            .eq("id", row.id);

          if (deleteError) {
            console.error(
              "Unable to clear processed command:",
              deleteError
            );
          }
        }
      }).catch((queueError) => {
        console.error("Playback command queue failed:", queueError);
      });
    };

    const recoverPendingCommands = async () => {
      const { data, error: fetchError } = await supabase
        .from("room_playback_commands")
        .select("id, command")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

      if (fetchError) {
        console.error("Unable to recover pending commands:", fetchError);
        return;
      }

      for (const row of data || []) {
        enqueueCommand(row as {
          id: string;
          command: Record<string, unknown>;
        });
      }
    };

    const commandChannel = supabase
      .channel(`playback-commands:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "room_playback_commands",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          enqueueCommand(payload.new as {
            id: string;
            command: Record<string, unknown>;
          });
        }
      )
      .subscribe((status) => {
        // Recover only after the live subscription is active, avoiding a gap
        // between the recovery query and Realtime subscription.
        if (status === "SUBSCRIBED") {
          void recoverPendingCommands();
        }
      });

    return () => {
      void supabase.removeChannel(commandChannel);
    };
  }, [isCoordinator, roomId]);

  // --------------------------------------------------
  // UI
  // --------------------------------------------------

  const hasMedia = Boolean(videoId);
  const canControlPlayback = isHost || isAdmin;

  async function toggleVideoFullscreen() {
    const element = videoSectionRef.current;
    if (!element) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        setIsVideoVisible(true);
        await element.requestFullscreen();
      }
    } catch (fullscreenError) {
      console.error("Unable to toggle video fullscreen:", fullscreenError);
    }
  }

  return (
    <section className="border border-white/10 bg-[#07101f] p-3 pb-28">
      {/* Top section: search + room/sync status */}
      <div className="relative z-30 mb-4 rounded-2xl">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="w-12"></div>
          <div className="min-w-0 flex-1">
            <div className="relative">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        setSearchTerm((value) => value.trim());
                        setSearchTrigger((value) => value + 1);
                      }
                    }}
                    placeholder="Search songs, artists, or paste a YouTube URL..."
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#07101f] px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-500"
                  />
                </div>

                {(searchLoading || searchError || searchResults.length > 0) && searchTerm.trim() && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-[#081426] p-2 shadow-2xl shadow-black/50">
                    {searchLoading && (
                      <p className="px-3 py-2 text-xs text-cyan-300">Searching YouTube...</p>
                    )}
                    {searchError && (
                      <p className="px-3 py-2 text-sm text-red-400">{searchError}</p>
                    )}
                    {searchResults.map((track) => (
                      <div key={track.id} className="flex items-center gap-3 rounded-lg p-2 transition hover:bg-white/[0.05]">
                        <img src={track.thumbnail} alt="" className="h-10 w-14 rounded object-cover" />
                        <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{track.title}</span>
                        {canControlPlayback && <button
                          type="button"
                          onClick={() => playTrackNow(track)}
                          aria-label={`Play ${track.title} now`}
                          title="Play now"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500 text-[#06101B] transition hover:bg-cyan-400"
                        >
                          <FaPlay />
                        </button>}
                        <button
                            type="button"
                            onClick={() => addTrackToQueue(track)}
                            aria-label={`Add ${track.title} to queue`}
                            title="Add to queue"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
                          >
                            <FaPlus />
                        </button>
                      </div>
                    ))}
                    {!searchLoading && !searchError && searchResults.length === 0 && (
                      <p className="px-3 py-2 text-xs text-gray-500">No results found.</p>
                    )}
                  </div>
                )}
              </div>
          </div>

          <div className="flex shrink-0 flex-row flex-wrap items-center gap-2 border-t border-white/10 pt-3 lg:min-w-48 lg:flex-col lg:items-stretch lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#07101f] px-3 py-2">
              <span className={`h-2 w-2 rounded-full ${syncBadge ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
              <span className="text-xs font-medium text-gray-200">{syncBadge || status}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main layout: video (2/3) + queue (1/3) */}
      {error && (
        <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">{error}</p>
      )}

      {youtubeBlocked && activeMediaType === "youtube" && (
        <button
          type="button"
          onClick={resumeBlockedYouTube}
          className="mb-4 w-full rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm font-semibold text-cyan-300 hover:bg-cyan-500/20"
        >
          Tap to Start Synced Video Playback
        </button>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {/* Video area: two-thirds on desktop */}
        <div className="min-w-0 space-y-3 lg:col-span-2">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0B1729]">
            <div
              ref={videoSectionRef}
              className="relative aspect-video w-full overflow-hidden bg-black fullscreen:aspect-auto fullscreen:h-screen fullscreen:w-screen fullscreen:rounded-none"
            >
              <div className={`absolute inset-0 z-10 transition-opacity duration-200 ${isVideoVisible && hasMedia && activeMediaType === "youtube" ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
                <div ref={playerContainerRef} className="h-full w-full" />
              </div>

              {(!isVideoVisible || !hasMedia || activeMediaType !== "youtube") && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#050b14]">
                  {currentTrack?.thumbnail ? (
                    <img src={currentTrack.thumbnail} alt={currentTrack.title} className="h-full w-full object-cover opacity-70" />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-2xl text-cyan-300"><FaMusic /></div>
                      <p className="text-sm text-gray-400">Your synchronized video will appear here</p>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/20" />
                  {hasMedia && activeMediaType === "youtube" && (
                    <button
                      type="button"
                      onClick={() => setIsVideoVisible(true)}
                      className="absolute rounded-full border border-white/20 bg-black/50 px-5 py-3 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-cyan-500 hover:text-[#06101B]"
                    >
                      ▶ Show video
                    </button>
                  )}
                </div>
              )}

              {/* Video controls stay anchored inside the bottom-right of the media frame. */}
              <div className="absolute bottom-3 right-3 z-30 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsVideoVisible((visible) => !visible)}
                  disabled={!hasMedia || activeMediaType !== "youtube"}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-black/65 text-white shadow-lg backdrop-blur-md transition hover:bg-cyan-500 hover:text-[#06101B] disabled:cursor-not-allowed disabled:opacity-40"
                  title={isVideoVisible ? "Hide video" : "Show video"}
                  aria-label={isVideoVisible ? "Hide video" : "Show video"}
                >
                  {isVideoVisible ? <FaVideoSlash /> : <FaVideo />}
                </button>
                <button
                  type="button"
                  onClick={toggleVideoFullscreen}
                  disabled={!hasMedia || activeMediaType !== "youtube"}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-black/65 text-cyan-300 shadow-lg backdrop-blur-md transition hover:bg-cyan-400 hover:text-[#06101B] disabled:cursor-not-allowed disabled:opacity-40"
                  title="Fullscreen video"
                  aria-label="Fullscreen video"
                >
                  <GoScreenFull />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Queue area: one-third on desktop */}
        <aside className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0B1729] lg:col-span-1">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
            <div>
              <h3 className="font-semibold text-white">Music queue</h3>
              <p className="mt-1 text-xs text-gray-500">Playlist history and upcoming tracks</p>
            </div>
            <span className="rounded-full bg-cyan-950 px-2.5 py-1 text-xs font-medium text-cyan-300">{musicQueue.length}</span>
          </div>

          {musicQueue.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center px-5 py-8 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] text-xl text-gray-500"><FaMusic /></div>
              <p className="text-sm font-medium text-gray-300">Queue is empty</p>
              <p className="mt-1 max-w-48 text-xs leading-5 text-gray-500">
                Search for a song above and add it to the shared room queue.
              </p>
            </div>
          ) : (
            <div className="max-h-[min(60vh,560px)] space-y-1 overflow-y-auto p-2">
              {musicQueue.map((track, index) => {
                const isCurrentQueueTrack = !!track.queueItemId && track.queueItemId === currentTrack?.queueItemId;
                const isPlayedTrack = !!currentTrack?.position && (track.position ?? 0) < currentTrack.position;
                const isUpcomingTrack = !isCurrentQueueTrack && !isPlayedTrack;
                return (
                <div
                  key={`${track.queueItemId || track.id}-${index}`}
                  onPointerDown={(event) => {
                    if (event.pointerType !== "touch" || (!canControlPlayback && track.addedBy !== userId)) return;
                    if ((event.target as HTMLElement).closest("button, [data-reorder-handle]")) return;
                    queueSwipeRef.current = {
                      pointerId: event.pointerId,
                      startX: event.clientX,
                      startY: event.clientY,
                      card: event.currentTarget,
                    };
                    event.currentTarget.style.transition = "none";
                  }}
                  onPointerMove={(event) => {
                    const swipe = queueSwipeRef.current;
                    if (!swipe || swipe.pointerId !== event.pointerId || swipe.card !== event.currentTarget) return;
                    const deltaX = event.clientX - swipe.startX;
                    const deltaY = event.clientY - swipe.startY;
                    if (Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY)) {
                      event.currentTarget.style.transform = `translateX(${Math.max(-130, Math.min(130, deltaX))}px)`;
                      event.currentTarget.style.opacity = String(Math.max(0.45, 1 - Math.abs(deltaX) / 260));
                    }
                  }}
                  onPointerUp={(event) => {
                    const swipe = queueSwipeRef.current;
                    if (!swipe || swipe.pointerId !== event.pointerId || swipe.card !== event.currentTarget) return;
                    const deltaX = event.clientX - swipe.startX;
                    const deltaY = event.clientY - swipe.startY;
                    queueSwipeRef.current = null;
                    event.currentTarget.style.transition = "transform 180ms ease, opacity 180ms ease";
                    if (Math.abs(deltaX) >= 90 && Math.abs(deltaX) > Math.abs(deltaY)) {
                      event.currentTarget.style.transform = `translateX(${deltaX > 0 ? 140 : -140}px)`;
                      event.currentTarget.style.opacity = "0";
                      window.setTimeout(() => void removeQueuedTrack(track), 150);
                    } else {
                      event.currentTarget.style.transform = "translateX(0)";
                      event.currentTarget.style.opacity = "";
                    }
                  }}
                  onPointerCancel={(event) => {
                    const swipe = queueSwipeRef.current;
                    if (!swipe || swipe.pointerId !== event.pointerId || swipe.card !== event.currentTarget) return;
                    queueSwipeRef.current = null;
                    event.currentTarget.style.transition = "transform 180ms ease, opacity 180ms ease";
                    event.currentTarget.style.transform = "translateX(0)";
                    event.currentTarget.style.opacity = "";
                  }}
                  draggable={Boolean(canControlPlayback && isUpcomingTrack && track.queueItemId)}
                  onDragStart={(event) => {
                    if (!canControlPlayback || !isUpcomingTrack || !track.queueItemId) {
                      event.preventDefault();
                      return;
                    }
                    setDraggingQueueItemId(track.queueItemId);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", track.queueItemId);
                  }}
                  onDragOver={(event) => {
                    if (canControlPlayback && isUpcomingTrack && draggingQueueItemId) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const draggedId = event.dataTransfer.getData("text/plain") || draggingQueueItemId;
                    if (draggedId && track.queueItemId) void reorderUpcomingTracks(draggedId, track.queueItemId);
                    setDraggingQueueItemId(null);
                  }}
                  onDragEnd={() => setDraggingQueueItemId(null)}
                  className={`group flex touch-pan-y items-center gap-2 rounded-xl border p-2 transition ${isCurrentQueueTrack ? "border-cyan-400/50 bg-cyan-400/10" : "border-transparent hover:bg-white/[0.05]"} ${isPlayedTrack ? "opacity-45" : ""} ${draggingQueueItemId === track.queueItemId ? "opacity-40" : ""} ${Boolean(canControlPlayback && isUpcomingTrack && track.queueItemId) ? "cursor-grab touch-none" : ""}`}
                >
                  <div className="group/thumbnail relative h-10 w-14 shrink-0 overflow-hidden rounded-lg">
                    <img src={track.thumbnail} alt="" className="h-full w-full object-cover" />
                    {canControlPlayback && isUpcomingTrack && (
                      <button
                        type="button"
                        onClick={() => playTrackNow(track)}
                        aria-label={`Play ${track.title}`}
                        title={`Play ${track.title} now`}
                        className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-25 transition-opacity duration-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300 cursor-pointer"
                      >
                        <FaPlay className="drop-shadow" />
                      </button>
                    )}
                  </div>
                  <span className="min-w-0 flex-1 text-xs leading-5 text-gray-300 line-clamp-2">
                    <span className="block">{track.title}</span>
                    {isCurrentQueueTrack && <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wider text-cyan-300">Now playing</span>}
                    {!isCurrentQueueTrack && isPlayedTrack && <span className="mt-0.5 block text-[10px] text-gray-500">Played</span>}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {!isCurrentQueueTrack && (canControlPlayback || track.addedBy === userId) && (
                      <button
                        type="button"
                        onClick={() => void removeQueuedTrack(track)}
                        className="rounded-md px-1.5 py-1 text-xl leading-none text-gray-500 transition hover:bg-red-500/10 hover:text-red-400"
                        aria-label={`Remove ${track.title} from queue`}
                        title="Remove from queue"
                      >
                        <FaXmark size={12} />
                      </button>
                    )}
                  </div>
                </div>
                );})}
            </div>
          )}
        </aside>
      </div>

      {/* Fixed room-wide playback dock */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#07101f]/95 px-3 py-3 shadow-[0_-12px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-2">
          <div className="flex items-center gap-2 text-[11px] tabular-nums text-gray-400">
            <span className="w-10 text-right">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={(event) => handleSeekChange(Number(event.target.value))}
              disabled={!canControlPlayback || !hasMedia || duration <= 0}
              aria-label="Playback timeline"
              className="min-w-0 flex-1 accent-cyan-400 disabled:opacity-40"
            />
            <span className="w-10">{formatTime(duration)}</span>
          </div>

          <div className="relative flex items-center justify-between gap-3">
            <div className="hidden min-w-0 flex-1 sm:block">
              <p className="truncate text-sm font-medium text-white">{currentTrack?.title || "Nothing playing"}</p>
              <p className="text-[11px] text-gray-500">{canControlPlayback ? "Room controls" : "Controlled by admins and host"}</p>
            </div>

            <div className="flex items-center justify-center gap-2 sm:gap-3">
              <button type="button" onClick={playPreviousTrack} disabled={!canControlPlayback || !hasMedia} aria-label="Previous track" title="Previous track" className="rounded-full p-2 text-gray-300 hover:bg-white/10 disabled:opacity-40"><FaBackwardStep /></button>
              <button type="button" onClick={togglePlayback} disabled={!canControlPlayback || !hasMedia} aria-label={isPlaying ? "Pause" : "Play"} className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-cyan-400 text-lg font-bold leading-none text-[#06101B] hover:bg-cyan-300 disabled:opacity-40">{isPlaying ? <FaPause className="block" /> : <FaPlay className="ml-0.5 block" />}</button>
              <button type="button" onClick={() => playNextTrack(false)} disabled={!canControlPlayback || musicQueue.length === 0 && repeatMode === "off"} aria-label="Next track" title="Next track" className="rounded-full p-2 text-gray-300 hover:bg-white/10 disabled:opacity-40"><FaForwardStep /></button>
              <button type="button" onClick={cycleRepeatMode} disabled={!canControlPlayback} aria-label={`Repeat ${repeatMode}`} title={`Repeat: ${repeatMode}`} className={`rounded-lg px-2 py-2 text-xs font-semibold ${repeatMode !== "off" ? "bg-cyan-400/15 text-cyan-300" : "text-gray-400 hover:bg-white/10"}`}>{repeatMode === "one" ? <BsRepeat1 /> : <BsRepeat />}</button>
            </div>

            <div className="flex w-28 shrink-0 items-center justify-end gap-2 sm:w-40">
              <span className="text-sm text-gray-400" aria-hidden="true">{volume === 0 ? <FaVolumeXmark /> : <FaVolumeHigh />}</span>
              <input type="range" min={0} max={100} step={1} value={volume} onChange={(event) => changeVolume(Number(event.target.value))} disabled={!canControlPlayback} aria-label="Room volume" className="w-full accent-cyan-400 disabled:opacity-40" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
