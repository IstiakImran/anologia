// server/src/index.js
const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// / Home page
app.get("/", (req, res) => {
  res.json({
    message: "Welcome to the Video Chat Signaling Server!",
    version: "1.0.0",
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeConnections: io.sockets.sockets.size,
    waitingQueue: waitingQueue.length,
    activePairs: peers.size / 2,
  });
});

// HTTPS Configuration - Only use HTTPS if explicitly requested AND certificates exist
const useHTTPS = process.env.USE_HTTPS === 'true' && process.env.NODE_ENV !== 'production';
let server;

if (useHTTPS) {
  // Try to load SSL certificates
  let sslOptions;
  try {
    // Look for certificates in multiple locations
    const certPaths = [
      // mkcert generated certificates
      { key: 'localhost+2-key.pem', cert: 'localhost+2.pem' },
      // OpenSSL generated certificates
      { key: 'private-key.pem', cert: 'certificate.pem' },
      // Alternative names
      { key: 'server-key.pem', cert: 'server-cert.pem' }
    ];

    let certificatesFound = false;
    for (const paths of certPaths) {
      if (fs.existsSync(paths.key) && fs.existsSync(paths.cert)) {
        sslOptions = {
          key: fs.readFileSync(paths.key),
          cert: fs.readFileSync(paths.cert)
        };
        certificatesFound = true;
        console.log(`✅ SSL certificates loaded: ${paths.key}, ${paths.cert}`);
        break;
      }
    }

    if (!certificatesFound) {
      console.log('⚠️  No SSL certificates found. Falling back to HTTP.');
      server = http.createServer(app);
    } else {
      server = https.createServer(sslOptions, app);
    }
  } catch (error) {
    console.error('❌ Error loading SSL certificates:', error.message);
    console.log('📋 Falling back to HTTP server');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for development - CHANGE THIS FOR PRODUCTION
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Enhanced data structures
let waitingQueue = [];
let peers = new Map();
let userInfo = new Map();

// Utility functions
const cleanupUser = (socketId) => {
  // Remove from peers
  const peerSocketId = peers.get(socketId);
  if (peerSocketId) {
    peers.delete(peerSocketId);
    peers.delete(socketId);
  }

  // Remove from waiting queue
  waitingQueue = waitingQueue.filter((user) => user.socketId !== socketId);

  // Remove user info
  userInfo.delete(socketId);
};

const findMatch = (currentSocketId) => {
  if (waitingQueue.length === 0) return null;

  // For now, just take the first user in queue
  // You could add more sophisticated matching logic here
  const matchedUser = waitingQueue.shift();
  return matchedUser.socketId;
};

const logConnection = (socketId, event, details) => {
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] ${event}: ${socketId}`,
    details ? JSON.stringify(details) : ""
  );
};

io.on("connection", (socket) => {
  const userAgent = socket.handshake.headers["user-agent"];
  const user = {
    socketId: socket.id,
    joinedAt: new Date(),
    userAgent,
  };

  userInfo.set(socket.id, user);
  logConnection(socket.id, "USER_CONNECTED", { userAgent });

  // --- Enhanced Matchmaking Logic ---
  const peerSocketId = findMatch(socket.id);

  if (peerSocketId) {
    // Store the peer connection
    peers.set(socket.id, peerSocketId);
    peers.set(peerSocketId, socket.id);

    logConnection(socket.id, "MATCH_FOUND", { peer: peerSocketId });

    // Notify both users - the user from queue becomes initiator
    io.to(peerSocketId).emit("match-found", {
      peerSocketId: socket.id,
      isInitiator: true,
    });
    io.to(socket.id).emit("match-found", {
      peerSocketId: peerSocketId,
      isInitiator: false,
    });
  } else {
    // Add to waiting queue
    waitingQueue.push(user);
    logConnection(socket.id, "ADDED_TO_QUEUE", {
      queuePosition: waitingQueue.length,
    });

    // Notify user they're waiting
    socket.emit("waiting-for-peer");
  }

  // --- WebRTC Signaling Handler ---
  socket.on("signal", (payload) => {
    try {
      const peerSocketId = peers.get(socket.id);
      if (peerSocketId && io.sockets.sockets.has(peerSocketId)) {
        logConnection(socket.id, "SIGNAL_RELAY", {
          to: peerSocketId,
          type: payload.type,
        });
        io.to(peerSocketId).emit("signal", payload);
      } else {
        logConnection(socket.id, "SIGNAL_ERROR", { error: "No active peer" });
        socket.emit("error", { message: "No active peer connection" });
      }
    } catch (error) {
      logConnection(socket.id, "SIGNAL_ERROR", { error: error.message });
    }
  });

  // --- Find Next Peer Handler ---
  socket.on("find-next", () => {
    logConnection(socket.id, "FIND_NEXT_REQUESTED");

    const currentPeer = peers.get(socket.id);
    if (currentPeer) {
      // Notify current peer about disconnection
      io.to(currentPeer).emit("peer-disconnected");
      peers.delete(currentPeer);
      peers.delete(socket.id);
    }

    // Try to find a new match
    const newPeerSocketId = findMatch(socket.id);

    if (newPeerSocketId) {
      peers.set(socket.id, newPeerSocketId);
      peers.set(newPeerSocketId, socket.id);

      logConnection(socket.id, "NEW_MATCH_FOUND", { peer: newPeerSocketId });

      io.to(newPeerSocketId).emit("match-found", {
        peerSocketId: socket.id,
        isInitiator: true,
      });
      io.to(socket.id).emit("match-found", {
        peerSocketId: newPeerSocketId,
        isInitiator: false,
      });
    } else {
      waitingQueue.push(user);
      logConnection(socket.id, "ADDED_TO_QUEUE_AGAIN", {
        queuePosition: waitingQueue.length,
      });
      socket.emit("waiting-for-peer");
    }
  });

  // --- Enhanced Disconnect Handler ---
  socket.on("disconnect", (reason) => {
    logConnection(socket.id, "USER_DISCONNECTED", { reason });

    const peerSocketId = peers.get(socket.id);
    if (peerSocketId && io.sockets.sockets.has(peerSocketId)) {
      io.to(peerSocketId).emit("peer-disconnected");
    }

    cleanupUser(socket.id);
  });

  // --- Error Handler ---
  socket.on("error", (error) => {
    logConnection(socket.id, "SOCKET_ERROR", { error: error.message });
  });
});

// Cleanup inactive connections periodically
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  waitingQueue = waitingQueue.filter((user) => {
    const isExpired = now - user.joinedAt.getTime() > timeout;
    if (isExpired) {
      logConnection(user.socketId, "QUEUE_TIMEOUT");
    }
    return !isExpired;
  });
}, 60000); // Run every minute

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0"; // Bind to all network interfaces

server.listen(PORT, HOST, () => {
  const protocol = server instanceof https.Server ? 'https' : 'http';
  const protocolEmoji = protocol === 'https' ? '🔒' : '🌐';

  console.log(`🚀 Enhanced signaling server running on port ${PORT} (${protocol.toUpperCase()})`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);

  // Log network interfaces for easy access (only in development)
  if (process.env.NODE_ENV !== 'production') {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    console.log(`\n${protocolEmoji} Server accessible at:`);
    console.log(`   Local: ${protocol}://localhost:${PORT}`);

    Object.keys(interfaces).forEach(name => {
      interfaces[name].forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`   Network: ${protocol}://${iface.address}:${PORT}`);
          console.log(`   Health: ${protocol}://${iface.address}:${PORT}/health`);
        }
      });
    });
    console.log('\n');
  } else {
    console.log(`${protocolEmoji} Server is running in production mode`);
  }
});