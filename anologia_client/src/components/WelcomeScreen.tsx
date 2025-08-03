// src/components/WelcomeScreen.tsx
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Smartphone, Wifi } from "lucide-react";

interface WelcomeScreenProps {
  onStart: () => void;
}

export default function WelcomeScreen({ onStart }: WelcomeScreenProps) {
  const [showMobileWarning, setShowMobileWarning] = useState(false);
  const [showHttpsWarning, setShowHttpsWarning] = useState(false);

  useEffect(() => {
    // Check if on mobile
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
    setShowMobileWarning(isMobile);

    // Check if HTTPS is required
    const needsHttps =
      location.protocol !== "https:" &&
      location.hostname !== "localhost" &&
      location.hostname !== "127.0.0.1";
    setShowHttpsWarning(needsHttps);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      <div className="max-w-md w-full mx-4">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            VideoChat
          </h1>
          <p className="text-gray-300 text-lg">
            Connect with random people around the world
          </p>
        </div>

        {/* HTTPS Warning */}
        {showHttpsWarning && (
          <div className="bg-red-800 border border-red-600 rounded-lg p-4 mb-6">
            <div className="flex items-center space-x-2 mb-2">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <h3 className="font-semibold text-red-100">HTTPS Required</h3>
            </div>
            <p className="text-red-200 text-sm">
              Camera and microphone access requires HTTPS. Please use HTTPS or
              access via localhost for testing.
            </p>
          </div>
        )}

        {/* Mobile Warning */}
        {showMobileWarning && (
          <div className="bg-yellow-800 border border-yellow-600 rounded-lg p-4 mb-6">
            <div className="flex items-center space-x-2 mb-2">
              <Smartphone className="w-5 h-5 text-yellow-400" />
              <h3 className="font-semibold text-yellow-100">
                Mobile Device Detected
              </h3>
            </div>
            <p className="text-yellow-200 text-sm">
              Make sure to allow camera and microphone permissions when
              prompted.
            </p>
          </div>
        )}

        <div className="bg-gray-800 rounded-xl p-6 shadow-2xl border border-gray-700">
          <div className="space-y-4 mb-6">
            <div className="flex items-center space-x-3">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span className="text-gray-300">Anonymous & secure</span>
            </div>
            <div className="flex items-center space-x-3">
              <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
              <span className="text-gray-300">Instant connections</span>
            </div>
            <div className="flex items-center space-x-3">
              <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
              <span className="text-gray-300">Skip to next person anytime</span>
            </div>
          </div>

          <button
            onClick={onStart}
            disabled={showHttpsWarning}
            className="w-full btn-primary py-3 text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Start Video Chat
          </button>

          <p className="text-xs text-gray-400 text-center mt-4">
            By continuing, you agree to our terms of service and privacy policy
          </p>
        </div>

        {/* Requirements */}
        <div className="mt-6 text-center">
          <p className="text-gray-400 text-sm mb-2">Requirements:</p>
          <div className="flex justify-center space-x-4 text-xs text-gray-500">
            <span>📷 Camera</span>
            <span>🎤 Microphone</span>
            <span>🔒 HTTPS</span>
          </div>
        </div>
      </div>
    </div>
  );
}
