// src/components/VideoChat.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import SimplePeer from "simple-peer";
import { Camera, CameraOff, Mic, MicOff, SkipForward, X } from "lucide-react";

interface VideoChatProps {
  onStop: () => void;
}

interface PeerData {
  peerSocketId: string;
  isInitiator: boolean;
}

export default function VideoChat({ onStop }: VideoChatProps) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [peer, setPeer] = useState<SimplePeer.Instance | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isWaiting, setIsWaiting] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [connectionStatus, setConnectionStatus] =
    useState<string>("Connecting...");

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<SimplePeer.Instance | null>(null);

  // Get server URL - improved for cross-device testing
  const getServerUrl = () => {
    // First priority: environment variable
    if (process.env.NEXT_PUBLIC_SERVER_URL) {
      return process.env.NEXT_PUBLIC_SERVER_URL;
    }

    // Second priority: detect based on how we're accessing the app
    if (typeof window !== "undefined") {
      const hostname = window.location.hostname;

      // If accessing via localhost, use localhost for server too
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        return `http://${hostname}:8080`;
      }
      // If accessing via IP (like from mobile), use same IP for server
      else if (hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        return `http://192.168.1.106:8080`;
      }
    }

    // Fallback - REPLACE THIS WITH YOUR ACTUAL PC IP
    return "http://127.0.0.1:8080"; // ⚠️ CHANGE THIS TO YOUR PC's IP
  };

  // Initialize media stream
  useEffect(() => {
    const initializeMedia = async () => {
      try {
        console.log("Requesting media access...");

        // Check if getUserMedia is supported
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setConnectionStatus("Camera/microphone not supported on this device");
          console.error("getUserMedia not supported");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            facingMode: "user",
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        console.log("Media access granted");
        streamRef.current = stream;

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          // Ensure video plays
          localVideoRef.current.play().catch(console.error);
        }

        setConnectionStatus("Connecting to server...");
      } catch (error) {
        console.error("Error accessing media devices:", error);

        // Handle specific error types
        if (error instanceof Error) {
          switch (error.name) {
            case "NotAllowedError":
              setConnectionStatus(
                "Camera/microphone access denied. Please allow permissions and refresh."
              );
              break;
            case "NotFoundError":
              setConnectionStatus("No camera/microphone found");
              break;
            case "NotSupportedError":
              setConnectionStatus("Camera/microphone not supported");
              break;
            case "NotReadableError":
              setConnectionStatus("Camera/microphone already in use");
              break;
            default:
              setConnectionStatus(`Error: ${error.message}`);
          }
        } else {
          setConnectionStatus("Error accessing camera/microphone");
        }
      }
    };

    initializeMedia();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Initialize socket connection
  useEffect(() => {
    if (!streamRef.current) {
      console.log("Waiting for media stream before connecting to server");
      return;
    }

    const serverUrl = getServerUrl();
    console.log("Connecting to server:", serverUrl);

    const newSocket = io(serverUrl, {
      transports: ["websocket", "polling"], // Fallback to polling if websocket fails
      timeout: 20000,
      forceNew: true,
      autoConnect: true,
    });

    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("Connected to server with ID:", newSocket.id);
      setConnectionStatus("Looking for someone...");
    });

    newSocket.on("connect_error", (error) => {
      console.error("Connection error:", error);
      setConnectionStatus(`Connection failed: ${error.message}`);
    });

    newSocket.on("disconnect", (reason) => {
      console.log("Disconnected from server:", reason);
      setConnectionStatus(`Disconnected: ${reason}`);
    });

    newSocket.on("waiting-for-peer", () => {
      console.log("Waiting for peer");
      setIsWaiting(true);
      setConnectionStatus("Looking for someone...");
    });

    newSocket.on("match-found", (data: PeerData) => {
      console.log("Match found:", data);
      setIsWaiting(false);
      setConnectionStatus("Connecting to peer...");
      initializePeerConnection(data.isInitiator, newSocket);
    });

    newSocket.on("signal", (data) => {
      console.log("Received signal:", data.type);
      if (peerRef.current) {
        try {
          peerRef.current.signal(data);
        } catch (error) {
          console.error("Error handling signal:", error);
        }
      }
    });

    newSocket.on("peer-disconnected", () => {
      console.log("Peer disconnected");
      handlePeerDisconnected();
    });

    newSocket.on("error", (error) => {
      console.error("Socket error:", error);
      setConnectionStatus(
        `Connection error: ${error.message || "Unknown error"}`
      );
    });

    return () => {
      console.log("Cleaning up socket connection");
      newSocket.close();
    };
  }, [streamRef.current]); // Re-run when stream is available

  const initializePeerConnection = (
    isInitiator: boolean,
    socketInstance: Socket
  ) => {
    if (!streamRef.current) {
      console.error("No stream available for peer connection");
      return;
    }

    console.log("Initializing peer connection, isInitiator:", isInitiator);

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
        ],
      },
    });

    newPeer.on("signal", (data) => {
      console.log("Sending signal:", data.type);
      socketInstance.emit("signal", data);
    });

    newPeer.on("stream", (remoteStream) => {
      console.log("Received remote stream");
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
        remoteVideoRef.current.play().catch(console.error);
      }
      setIsConnected(true);
      setConnectionStatus("Connected");
    });

    newPeer.on("connect", () => {
      console.log("Peer connection established");
      setIsConnected(true);
      setConnectionStatus("Connected");
    });

    newPeer.on("close", () => {
      console.log("Peer connection closed");
      handlePeerDisconnected();
    });

    newPeer.on("error", (error) => {
      console.error("Peer connection error:", error);
      setConnectionStatus(`Connection failed: ${error.message}`);
      handlePeerDisconnected();
    });

    setPeer(newPeer);
    peerRef.current = newPeer;
  };

  const handlePeerDisconnected = () => {
    console.log("Handling peer disconnection");
    setIsConnected(false);
    setIsWaiting(true);
    setConnectionStatus("Stranger disconnected. Looking for someone new...");

    if (peerRef.current) {
      peerRef.current.destroy();
      setPeer(null);
      peerRef.current = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const handleSkip = () => {
    console.log("Skipping to next peer");
    if (socket) {
      socket.emit("find-next");
    }

    if (peerRef.current) {
      peerRef.current.destroy();
      setPeer(null);
      peerRef.current = null;
    }

    setIsConnected(false);
    setIsWaiting(true);
    setConnectionStatus("Looking for someone new...");

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const toggleVideo = () => {
    if (streamRef.current) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
      }
    }
  };

  const toggleAudio = () => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
      }
    }
  };

  const handleStop = () => {
    console.log("Stopping video chat");

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    if (peerRef.current) {
      peerRef.current.destroy();
    }

    if (socket) {
      socket.close();
    }

    onStop();
  };

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 p-4">
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-bold">VideoChat</h1>
          <div className="flex items-center space-x-2">
            <span
              className={`px-3 py-1 rounded-full text-sm ${
                isConnected
                  ? "bg-green-600 text-white"
                  : isWaiting
                  ? "bg-yellow-600 text-white"
                  : "bg-red-600 text-white"
              }`}
            >
              {connectionStatus}
            </span>
            <button onClick={handleStop} className="btn-danger">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Debug info - remove in production */}
      <div className="bg-gray-700 p-2 text-xs text-gray-300">
        Server: {getServerUrl()} | Host: {window?.location?.hostname}
      </div>

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
          {!isConnected && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
                <p className="text-gray-300 max-w-md px-4">
                  {connectionStatus}
                </p>
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
          <div className="absolute top-2 left-2">
            <span className="bg-black bg-opacity-50 text-white px-2 py-1 rounded text-sm">
              You
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-gray-800 border-t border-gray-700 p-4">
        <div className="flex justify-center space-x-4">
          <button
            onClick={toggleVideo}
            className={`p-3 rounded-full transition-colors ${
              isVideoEnabled
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {isVideoEnabled ? (
              <Camera className="w-6 h-6" />
            ) : (
              <CameraOff className="w-6 h-6" />
            )}
          </button>

          <button
            onClick={toggleAudio}
            className={`p-3 rounded-full transition-colors ${
              isAudioEnabled
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {isAudioEnabled ? (
              <Mic className="w-6 h-6" />
            ) : (
              <MicOff className="w-6 h-6" />
            )}
          </button>

          <button
            onClick={handleSkip}
            disabled={isWaiting}
            className="btn-primary p-3 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            <SkipForward className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
