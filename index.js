require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 4000;

const rooms = {}; // roomId -> { game, players }

// ---------- Game logic (simple dam/checkers) ----------

function createInitialBoard() {
  const size = 8;
  const board = Array.from({ length: size }, () => Array(size).fill(null));

  // Black at top (rows 0,1,2)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < size; col++) {
      if ((row + col) % 2 === 1) {
        board[row][col] = "b"; // black piece
      }
    }
  }

  // White at bottom (rows 5,6,7)
  for (let row = size - 3; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if ((row + col) % 2 === 1) {
        board[row][col] = "w"; // white piece
      }
    }
  }

  return board;
}

function createNewGame() {
  return {
    board: createInitialBoard(),
    currentPlayer: "w", // 'w' | 'b'
    status: "waiting", // 'waiting' | 'playing' | 'finished'
    winner: null,
    // if not null, the same piece must continue capturing from this square
    mustContinueFrom: null,
  };
}

function hasCaptureFrom(game, row, col) {
  const { board } = game;
  const piece = board[row]?.[col];
  if (!piece) return false;

  const directions = [
    { dr: -1, dc: -1 },
    { dr: -1, dc: 1 },
    { dr: 1, dc: -1 },
    { dr: 1, dc: 1 },
  ];

  for (const { dr, dc } of directions) {
    const midR = row + dr;
    const midC = col + dc;
    const landR = row + 2 * dr;
    const landC = col + 2 * dc;

    if (
      landR < 0 ||
      landR >= 8 ||
      landC < 0 ||
      landC >= 8 ||
      midR < 0 ||
      midR >= 8 ||
      midC < 0 ||
      midC >= 8
    ) {
      continue;
    }

    const midPiece = board[midR][midC];
    const landPiece = board[landR][landC];

    if (!midPiece || landPiece !== null) continue;
    if (midPiece.toLowerCase() === piece.toLowerCase()) continue;

    // There is at least one legal capture from here
    return true;
  }

  return false;
}

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      game: createNewGame(),
      players: {}, // socket.id -> { name, color }
    };
  }
  return rooms[roomId];
}

function countPlayers(room) {
  return Object.keys(room.players).length;
}

function getPlayerColor(room, socketId) {
  return room.players[socketId]?.color;
}

// Very simplified check for valid moves (no multi jumps / forced captures)
function isValidMove(game, from, to, playerColor) {
  const { board, currentPlayer, status, mustContinueFrom } = game;
  if (status !== "playing") return false;
  if (currentPlayer !== playerColor) return false;

  const { row: fr, col: fc } = from;
  const { row: tr, col: tc } = to;

  if (fr === tr && fc === tc) return false;
  if (tr < 0 || tr >= 8 || tc < 0 || tc >= 8) return false;

  const piece = board[fr]?.[fc];
  if (!piece) return false;
  if (piece.toLowerCase() !== playerColor) return false;

  // If we are in the middle of a capture chain, you must move the same piece
  if (mustContinueFrom) {
    if (mustContinueFrom.row !== fr || mustContinueFrom.col !== fc) {
      return false;
    }
  }

  if (board[tr][tc] !== null) return false;

  const dr = tr - fr;
  const dc = tc - fc;
  const absDr = Math.abs(dr);
  const absDc = Math.abs(dc);

  const isWhite = piece.toLowerCase() === "w";
  const isKing = piece === piece.toUpperCase();

  const isCapture = absDr === 2 && absDc === 2;
  const isSimpleMove = absDr === 1 && absDc === 1;

  if (!isCapture && !isSimpleMove) {
    return false;
  }

  if (isCapture) {
    // For captures we allow BOTH forward and backward
    const midR = fr + dr / 2;
    const midC = fc + dc / 2;
    const midPiece = board[midR]?.[midC];
    if (!midPiece) return false;
    if (midPiece.toLowerCase() === piece.toLowerCase()) return false;
    return true;
  }

  // From here on: simple (non-capture) move
  // During a capture chain, only capture moves are allowed
  if (mustContinueFrom) {
    return false;
  }

  // Men move only forward; kings move any direction
  if (!isKing) {
    // White moves "up" (row decreasing)
    if (isWhite && dr >= 0) return false;
    // Black moves "down" (row increasing)
    if (!isWhite && dr <= 0) return false;
  }

  return true;
}

function applyMove(game, from, to) {
  const { board } = game;
  const { row: fr, col: fc } = from;
  const { row: tr, col: tc } = to;
  const piece = board[fr][fc];

  board[fr][fc] = null;

  const dr = tr - fr;
  const dc = tc - fc;
  const absDr = Math.abs(dr);
  const absDc = Math.abs(dc);

  let didCapture = false;

  // If this is a capture move, remove the jumped piece
  if (absDr === 2 && absDc === 2) {
    const mr = fr + dr / 2;
    const mc = fc + dc / 2;
    board[mr][mc] = null;
    didCapture = true;
  }

  board[tr][tc] = piece;

  // King promotion
  if (piece === "w" && tr === 0) board[tr][tc] = "W";
  if (piece === "b" && tr === 7) board[tr][tc] = "B";

  // If we captured and can capture again from the new position,
  // same player continues and must move this same piece.
  if (didCapture && hasCaptureFrom(game, tr, tc)) {
    game.mustContinueFrom = { row: tr, col: tc };
  } else {
    game.mustContinueFrom = null;
    game.currentPlayer = game.currentPlayer === "w" ? "b" : "w";
  }
}

// ---------- Socket.IO events ----------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    const playersCount = countPlayers(room);

    if (playersCount >= 2) {
      socket.emit("roomFull");
      return;
    }

    const color = playersCount === 0 ? "w" : "b";

    room.players[socket.id] = {
      name: name || "Player",
      color,
    };

    if (countPlayers(room) === 2) {
      room.game.status = "playing";
    }

    socket.join(roomId);

    // Send joined player their info & game state
    socket.emit("joinedRoom", {
      roomId,
      playerColor: color,
      gameState: room.game,
      players: room.players,
    });

    // Notify others in the room
    socket.to(roomId).emit("playerJoined", {
      socketId: socket.id,
      name,
      color,
      gameState: room.game,
      players: room.players,
    });

    // Sync full game state to all clients
    io.to(roomId).emit("gameUpdate", room.game);
  });

  socket.on("makeMove", ({ roomId, from, to }) => {
    const room = rooms[roomId];
    if (!room) return;

    const { game } = room;
    const playerColor = getPlayerColor(room, socket.id);
    if (!playerColor) return;

    if (!isValidMove(game, from, to, playerColor)) {
      socket.emit("invalidMove");
      return;
    }

    applyMove(game, from, to);
    io.to(roomId).emit("gameUpdate", game);
  });

  socket.on("resetGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.game = createNewGame();
    if (countPlayers(room) === 2) {
      room.game.status = "playing";
    }

    io.to(roomId).emit("gameUpdate", room.game);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(roomId).emit("playerLeft", { socketId: socket.id });

        if (countPlayers(room) === 0) {
          delete rooms[roomId];
        } else {
          // Reset game if one player leaves
          room.game = createNewGame();
          io.to(roomId).emit("gameUpdate", room.game);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
