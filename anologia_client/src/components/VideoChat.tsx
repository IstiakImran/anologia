import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import SimplePeer from "simple-peer";
import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  SkipForward,
  X,
  Settings,
  Users,
  Clock,
  Wifi,
  WifiOff,
  AlertTriangle,
  Loader,
} from "lucide-react";

interface VideoChatProps {
  onStop: () => void;
}

interface PeerData {
  peerSocketId: string;
  isInitiator: boolean;
  matchId: string;
}

// Updated to match server response structure
interface HealthData {
  status: string;
  timestamp: string;
  activeConnections: number;
  waitingQueue: number;
  activePairs: number;
}

interface ConnectionState {
  isConnected: boolean;
  isWaiting: boolean;
  isConnecting: boolean;
  hasError: boolean;
  errorMessage: string;
  status: string;
}

interface MediaState {
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
  isVideoLoading: boolean;
}

interface ServerStats {
  activeUsers: number;
  waitingQueue: number;
  activePairs: number;
  totalMatches: number;
  serverStatus: string;
}

export default function VideoChat({ onStop }: VideoChatProps) {
  // Core state
  const [socket, setSocket] = useState<Socket | null>(null);
  const [peer, setPeer] = useState<SimplePeer.Instance | null>(null);

  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    isConnected: false,
    isWaiting: true,
    isConnecting: false,
    hasError: false,
    errorMessage: "",
    status: "Initializing...",
  });

  // Media state
  const [mediaState, setMediaState] = useState<MediaState>({
    isVideoEnabled: true,
    isAudioEnabled: true,
    hasVideoTrack: false,
    hasAudioTrack: false,
    isVideoLoading: true,
  });

  // Server stats
  const [serverStats, setServerStats] = useState<ServerStats>({
    activeUsers: 0,
    waitingQueue: 0,
    activePairs: 0,
    totalMatches: 0,
    serverStatus: "unknown",
  });

  // UI state
  const [showStats, setShowStats] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [lastActivity, setLastActivity] = useState<Date>(new Date());

  // Refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<SimplePeer.Instance | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Get server URL with improved detection
  const getServerUrl = useCallback(() => {
    if (process.env.NEXT_PUBLIC_SERVER_URL) {
      return process.env.NEXT_PUBLIC_SERVER_URL;
    }

    if (typeof window !== "undefined") {
      const hostname = window.location.hostname;
      const protocol = window.location.protocol === "https:" ? "https" : "http";

      if (hostname === "localhost" || hostname === "127.0.0.1") {
        return `${protocol}://${hostname}:8080`;
      } else if (hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        return `https://${hostname}:8080`;
      }
    }

    return "https://192.168.1.106:8080"; // Fallback
  }, []);

  // Safe video operations
  const safeVideoPlay = useCallback(async (videoElement: HTMLVideoElement) => {
    try {
      if (!videoElement.srcObject || !videoElement.paused) {
        return;
      }
      await videoElement.play();
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Video play error:", error.message);
      }
    }
  }, []);

  const setVideoStream = useCallback(
    async (videoElement: HTMLVideoElement, stream: MediaStream | null) => {
      try {
        if (!videoElement.paused) {
          videoElement.pause();
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
        videoElement.srcObject = stream;

        if (stream) {
          await safeVideoPlay(videoElement);
        }
      } catch (error) {
        console.error("Error setting video stream:", error);
      }
    },
    [safeVideoPlay]
  );

  // Update connection state helper
  const updateConnectionState = useCallback(
    (updates: Partial<ConnectionState>) => {
      setConnectionState((prev) => ({ ...prev, ...updates }));
      setLastActivity(new Date());
    },
    []
  );

  // Update media state helper
  const updateMediaState = useCallback((updates: Partial<MediaState>) => {
    setMediaState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Fixed health check functionality
  const performHealthCheck = useCallback(async () => {
    try {
      const serverUrl = getServerUrl();
      const response = await fetch(`${serverUrl}/health`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const data: HealthData = await response.json();

        // Updated to match server response structure
        setServerStats({
          activeUsers: data.activeConnections,
          waitingQueue: data.waitingQueue,
          activePairs: data.activePairs,
          totalMatches: 0, // Server doesn't track this, set to 0 or remove
          serverStatus: data.status,
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error("Health check failed:", error);
      setServerStats((prev) => ({
        ...prev,
        serverStatus: "error",
      }));
      return false;
    }
  }, [getServerUrl]);

  // Handle peer disconnection
  const handlePeerDisconnected = useCallback(
    async (reason: string = "unknown") => {
      console.log("Handling peer disconnection:", reason);

      updateConnectionState({
        isConnected: false,
        isWaiting: true,
        status:
          reason === "peer_skipped"
            ? "Stranger skipped. Looking for someone new..."
            : "Stranger disconnected. Looking for someone new...",
      });

      if (peerRef.current) {
        peerRef.current.destroy();
        setPeer(null);
        peerRef.current = null;
      }

      if (remoteVideoRef.current) {
        await setVideoStream(remoteVideoRef.current, null);
      }
    },
    [updateConnectionState, setVideoStream]
  );

  // Initialize peer connection
  const initializePeerConnection = useCallback(
    (isInitiator: boolean, socketInstance: Socket) => {
      if (!streamRef.current) {
        console.error("No stream for peer connection");
        return;
      }

      console.log("Initializing peer connection, initiator:", isInitiator);

      // Clean up existing peer
      if (peerRef.current) {
        peerRef.current.destroy();
      }

      const newPeer = new SimplePeer({
        initiator: isInitiator,
        trickle: false,
        stream: streamRef.current,
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun.cloudflare.com:3478" },
            {
              urls: "turn:openrelay.metered.ca:80",
              username: "openrelayproject",
              credential: "openrelayproject",
            },
          ],
          iceCandidatePoolSize: 10,
        },
      });

      peerRef.current = newPeer;
      setPeer(newPeer);

      // Peer event handlers
      newPeer.on("signal", (data) => {
        console.log("Sending signal:", data.type);
        socketInstance.emit("signal", data);
      });

      newPeer.on("stream", async (remoteStream) => {
        console.log("Remote stream received");
        if (remoteVideoRef.current) {
          await setVideoStream(remoteVideoRef.current, remoteStream);
        }
        updateConnectionState({
          isConnected: true,
          status: "Connected",
        });
      });

      newPeer.on("connect", () => {
        console.log("Peer connected");
        updateConnectionState({
          isConnected: true,
          status: "Connected",
        });
      });

      newPeer.on("close", () => {
        console.log("Peer connection closed");
        handlePeerDisconnected("connection_closed");
      });

      newPeer.on("error", (error) => {
        console.error("Peer error:", error);
        updateConnectionState({
          status: `Connection failed: ${error.message}`,
          hasError: true,
          errorMessage: error.message,
        });
        handlePeerDisconnected("connection_error");
      });
    },
    [setVideoStream, updateConnectionState, handlePeerDisconnected]
  );

  // Initialize media stream
  const initializeMedia = useCallback(async () => {
    try {
      updateConnectionState({ status: "Requesting camera access..." });
      updateMediaState({ isVideoLoading: true });

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera/microphone not supported on this device");
      }

      const constraints = {
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          facingMode: "user",
          frameRate: { ideal: 30, max: 60 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100,
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // Update media state based on tracks
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();

      updateMediaState({
        hasVideoTrack: videoTracks.length > 0,
        hasAudioTrack: audioTracks.length > 0,
        isVideoEnabled: videoTracks.length > 0 && videoTracks[0].enabled,
        isAudioEnabled: audioTracks.length > 0 && audioTracks[0].enabled,
        isVideoLoading: false,
      });

      if (localVideoRef.current) {
        await setVideoStream(localVideoRef.current, stream);
      }

      updateConnectionState({
        status: "Camera ready. Connecting to server...",
        hasError: false,
        errorMessage: "",
      });

      return true;
    } catch (error) {
      console.error("Media initialization error:", error);

      let errorMessage = "Error accessing camera/microphone";
      if (error instanceof Error) {
        switch (error.name) {
          case "NotAllowedError":
            errorMessage =
              "Camera/microphone access denied. Please allow permissions and refresh.";
            break;
          case "NotFoundError":
            errorMessage = "No camera/microphone found";
            break;
          case "NotSupportedError":
            errorMessage = "Camera/microphone not supported";
            break;
          case "NotReadableError":
            errorMessage = "Camera/microphone already in use";
            break;
          default:
            errorMessage = error.message;
        }
      }

      updateConnectionState({
        hasError: true,
        errorMessage,
        status: errorMessage,
      });

      updateMediaState({ isVideoLoading: false });
      return false;
    }
  }, [updateConnectionState, updateMediaState, setVideoStream]);

  // Initialize socket connection
  const initializeSocket = useCallback(async () => {
    if (!streamRef.current) {
      console.log("No stream available for socket connection");
      return;
    }

    // Check server health first
    const serverHealthy = await performHealthCheck();
    if (!serverHealthy) {
      updateConnectionState({
        hasError: true,
        errorMessage: "Server is not responding",
        status: "Server unavailable",
      });
      return;
    }

    const serverUrl = getServerUrl();
    updateConnectionState({
      status: "Connecting to server...",
      isConnecting: true,
    });

    const newSocket = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 20000,
      forceNew: true,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    // Socket event handlers
    newSocket.on("connect", () => {
      console.log("Connected to server:", newSocket.id);
      updateConnectionState({
        status: "Looking for someone...",
        isConnecting: false,
        hasError: false,
        errorMessage: "",
        isWaiting: true,
      });
      setRetryCount(0);

      // Start heartbeat
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      heartbeatIntervalRef.current = setInterval(() => {
        newSocket.emit("ping");
      }, 30000);
    });

    newSocket.on("connect_error", (error) => {
      console.error("Connection error:", error);
      updateConnectionState({
        hasError: true,
        errorMessage: `Connection failed: ${error.message}`,
        status: "Connection failed",
        isConnecting: false,
      });

      // Auto retry with exponential backoff
      if (retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 2000;
        reconnectTimeoutRef.current = setTimeout(() => {
          setRetryCount((prev) => prev + 1);
          initializeSocket();
        }, delay);
      }
    });

    newSocket.on("disconnect", (reason) => {
      console.log("Disconnected:", reason);
      updateConnectionState({
        status: `Disconnected: ${reason}`,
        isConnected: false,
        isWaiting: true,
      });

      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    });

    newSocket.on("waiting-for-peer", (data) => {
      console.log("Waiting for peer:", data);
      updateConnectionState({
        isWaiting: true,
        isConnected: false,
        status: data?.queuePosition
          ? `Position in queue: ${data.queuePosition}`
          : "Looking for someone...",
      });
    });

    newSocket.on("match-found", (data: PeerData) => {
      console.log("Match found:", data);
      updateConnectionState({
        isWaiting: false,
        status: "Connecting to peer...",
      });
      initializePeerConnection(data.isInitiator, newSocket);
    });

    newSocket.on("signal", (data) => {
      console.log("Signal received:", data.type);
      if (peerRef.current && !peerRef.current.destroyed) {
        try {
          peerRef.current.signal(data);
        } catch (error) {
          console.error("Signal handling error:", error);
        }
      }
    });

    newSocket.on("peer-disconnected", (data) => {
      console.log("Peer disconnected:", data?.reason);
      handlePeerDisconnected(data?.reason || "unknown");
    });

    newSocket.on("error", (error) => {
      console.error("Socket error:", error);
      updateConnectionState({
        hasError: true,
        errorMessage: error.message || "Socket error",
        status: "Connection error",
      });
    });

    newSocket.on("pong", () => {
      // Heartbeat response received
      setLastActivity(new Date());
    });
  }, [
    getServerUrl,
    performHealthCheck,
    retryCount,
    updateConnectionState,
    initializePeerConnection,
    handlePeerDisconnected,
  ]);

  // Control functions
  const handleSkip = useCallback(async () => {
    if (!socketRef.current) return;

    console.log("Skipping to next peer");
    socketRef.current.emit("find-next");

    if (peerRef.current) {
      peerRef.current.destroy();
      setPeer(null);
      peerRef.current = null;
    }

    updateConnectionState({
      isConnected: false,
      isWaiting: true,
      status: "Looking for someone new...",
    });

    if (remoteVideoRef.current) {
      await setVideoStream(remoteVideoRef.current, null);
    }
  }, [updateConnectionState, setVideoStream]);

  const toggleVideo = useCallback(() => {
    if (!streamRef.current) return;

    const videoTrack = streamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      updateMediaState({ isVideoEnabled: videoTrack.enabled });
    }
  }, [updateMediaState]);

  const toggleAudio = useCallback(() => {
    if (!streamRef.current) return;

    const audioTrack = streamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      updateMediaState({ isAudioEnabled: audioTrack.enabled });
    }
  }, [updateMediaState]);

  const handleStop = useCallback(() => {
    console.log("Stopping video chat");

    // Clear all timeouts and intervals
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    // Stop media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    // Clean up peer
    if (peerRef.current) {
      peerRef.current.destroy();
    }

    // Close socket
    if (socketRef.current) {
      socketRef.current.close();
    }

    onStop();
  }, [onStop]);

  // Initialize everything
  useEffect(() => {
    const initialize = async () => {
      const mediaInitialized = await initializeMedia();
      if (mediaInitialized) {
        await initializeSocket();

        // Start health checks
        healthCheckIntervalRef.current = setInterval(performHealthCheck, 30000);
      }
    };

    initialize();

    return () => {
      handleStop();
    };
  }, [initializeMedia, initializeSocket, performHealthCheck, handleStop]);

  // Render status indicator
  const renderStatusIndicator = () => {
    if (connectionState.hasError) {
      return <WifiOff className="w-4 h-4" />;
    } else if (connectionState.isConnected) {
      return <Wifi className="w-4 h-4" />;
    } else if (connectionState.isConnecting) {
      return <Loader className="w-4 h-4 animate-spin" />;
    } else {
      return <Clock className="w-4 h-4" />;
    }
  };

  const getStatusColor = () => {
    if (connectionState.hasError) return "bg-red-600";
    if (connectionState.isConnected) return "bg-green-600";
    if (connectionState.isConnecting) return "bg-blue-600";
    return "bg-yellow-600";
  };

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 p-4">
        <div className="flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <h1 className="text-xl font-bold text-white">VideoChat</h1>
            {showStats && (
              <div className="text-sm text-gray-300 hidden md:flex items-center space-x-4">
                <span>Online: {serverStats.activeUsers}</span>
                <span>Queue: {serverStats.waitingQueue}</span>
                <span>Active: {serverStats.activePairs}</span>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <div
              className={`flex items-center space-x-2 px-3 py-1 rounded-full text-sm text-white ${getStatusColor()}`}
            >
              {renderStatusIndicator()}
              <span className="hidden sm:inline">{connectionState.status}</span>
            </div>

            <button
              onClick={() => setShowStats(!showStats)}
              className="p-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
              title="Toggle Stats"
            >
              <Users className="w-4 h-4" />
            </button>

            <button
              onClick={handleStop}
              className="p-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
              title="Stop Chat"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Error message */}
        {connectionState.hasError && (
          <div className="mt-2 flex items-center space-x-2 text-red-400 text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>{connectionState.errorMessage}</span>
            {retryCount < 3 && (
              <button
                onClick={() => initializeSocket()}
                className="ml-2 px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {/* Stats Panel */}
      {showStats && (
        <div className="bg-gray-700 p-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            <div>
              <div className="font-semibold text-green-400">
                {serverStats.activeUsers}
              </div>
              <div className="text-gray-300">Online Users</div>
            </div>
            <div>
              <div className="font-semibold text-yellow-400">
                {serverStats.waitingQueue}
              </div>
              <div className="text-gray-300">In Queue</div>
            </div>
            <div>
              <div className="font-semibold text-blue-400">
                {serverStats.activePairs}
              </div>
              <div className="text-gray-300">Active Pairs</div>
            </div>
            <div>
              <div className="font-semibold text-purple-400">
                {serverStats.serverStatus}
              </div>
              <div className="text-gray-300">Server Status</div>
            </div>
          </div>
        </div>
      )}

      {/* Video Container */}
      <div className="flex-1 flex flex-col md:flex-row">
        {/* Remote Video */}
        <div className="flex-1 relative bg-gray-800">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />

          {!connectionState.isConnected && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-90">
              <div className="text-center max-w-md px-4">
                {connectionState.isConnecting || mediaState.isVideoLoading ? (
                  <Loader className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-500" />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center mx-auto mb-4">
                    <Users className="w-6 h-6 text-gray-400" />
                  </div>
                )}
                <p className="text-gray-300 mb-2">{connectionState.status}</p>
                {connectionState.isWaiting && serverStats.waitingQueue > 0 && (
                  <p className="text-sm text-gray-400">
                    {serverStats.waitingQueue} people waiting
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Local Video */}
        <div className="w-full md:w-80 h-60 md:h-full relative bg-gray-700">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />

          <div className="absolute top-2 left-2 flex items-center space-x-2">
            <span className="bg-black bg-opacity-60 text-white px-2 py-1 rounded text-sm">
              You
            </span>
            {!mediaState.isVideoEnabled && (
              <div className="bg-red-600 bg-opacity-80 p-1 rounded">
                <CameraOff className="w-4 h-4" />
              </div>
            )}
            {!mediaState.isAudioEnabled && (
              <div className="bg-red-600 bg-opacity-80 p-1 rounded">
                <MicOff className="w-4 h-4" />
              </div>
            )}
          </div>

          {mediaState.isVideoLoading && (
            <div className="absolute inset-0 bg-gray-700 bg-opacity-90 flex items-center justify-center">
              <Loader className="w-8 h-8 animate-spin text-blue-500" />
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="bg-gray-800 border-t border-gray-700 p-4">
        <div className="flex justify-center space-x-4">
          <button
            onClick={toggleVideo}
            disabled={!mediaState.hasVideoTrack}
            className={`p-3 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              mediaState.isVideoEnabled
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-red-600 hover:bg-red-700"
            }`}
            title={
              mediaState.isVideoEnabled ? "Turn off camera" : "Turn on camera"
            }
          >
            {mediaState.isVideoEnabled ? (
              <Camera className="w-6 h-6" />
            ) : (
              <CameraOff className="w-6 h-6" />
            )}
          </button>

          <button
            onClick={toggleAudio}
            disabled={!mediaState.hasAudioTrack}
            className={`p-3 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              mediaState.isAudioEnabled
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-red-600 hover:bg-red-700"
            }`}
            title={
              mediaState.isAudioEnabled
                ? "Mute microphone"
                : "Unmute microphone"
            }
          >
            {mediaState.isAudioEnabled ? (
              <Mic className="w-6 h-6" />
            ) : (
              <MicOff className="w-6 h-6" />
            )}
          </button>

          <button
            onClick={handleSkip}
            disabled={
              connectionState.isWaiting || !socketRef.current?.connected
            }
            className="p-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-full transition-colors"
            title="Skip to next person"
          >
            <SkipForward className="w-6 h-6" />
          </button>
        </div>

        <div className="mt-4 text-center text-xs text-gray-400">
          Server:{" "}
          {getServerUrl().replace("https://", "").replace("http://", "")} • Last
          activity: {lastActivity.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
