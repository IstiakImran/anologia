// src/app/page.tsx
"use client";

import { useState } from "react";
import VideoChat from "@/components/VideoChat";
import WelcomeScreen from "@/components/WelcomeScreen";

export default function Home() {
  const [isStarted, setIsStarted] = useState(false);

  const handleStart = () => {
    setIsStarted(true);
  };

  const handleStop = () => {
    setIsStarted(false);
  };

  return (
    <main className="min-h-screen">
      {!isStarted ? (
        <WelcomeScreen onStart={handleStart} />
      ) : (
        <VideoChat onStop={handleStop} />
      )}
    </main>
  );
}
