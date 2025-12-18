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
    mustContinueFrom: null,
  };
}

function hasCaptureFrom(game, row, col) {
  const { board } = game;
  const piece = board[row]?.[col];
  if (!piece) return false;

  const isKing = piece === piece.toUpperCase();

  if (isKing) {
    // King can capture at any distance along diagonals
    return hasKingCaptureFrom(game, row, col);
  } else {
    // Regular piece can only capture adjacent (1 square away)
    return hasRegularCaptureFrom(game, row, col);
  }
}

function hasRegularCaptureFrom(game, row, col) {
  const { board } = game;
  const piece = board[row][col];

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

    return true;
  }

  return false;
}

function hasKingCaptureFrom(game, row, col) {
  const { board } = game;
  const piece = board[row][col];

  const directions = [
    { dr: -1, dc: -1 },
    { dr: -1, dc: 1 },
    { dr: 1, dc: -1 },
    { dr: 1, dc: 1 },
  ];

  for (const { dr, dc } of directions) {
    let distance = 1;
    let foundEnemy = false;

    // Scan along the diagonal
    while (true) {
      const checkR = row + dr * distance;
      const checkC = col + dc * distance;

      if (checkR < 0 || checkR >= 8 || checkC < 0 || checkC >= 8) {
        break;
      }

      const checkPiece = board[checkR][checkC];

      if (checkPiece === null) {
        // Empty square
        if (foundEnemy) {
          // We found an enemy and now found an empty square beyond it
          // This is a valid capture opportunity
          return true;
        }
      } else if (checkPiece.toLowerCase() === piece.toLowerCase()) {
        // Our own piece blocks the path
        break;
      } else {
        // Enemy piece
        if (foundEnemy) {
          // Can't jump over two pieces
          break;
        }
        foundEnemy = true;
        // Continue to see if there's an empty square beyond
      }

      distance++;
    }
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

function getAllPlayerPieces(board, color) {
  const pieces = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece && piece.toLowerCase() === color) {
        pieces.push({ row, col, piece });
      }
    }
  }
  return pieces;
}

function playerHasAnyCapture(game, playerColor) {
  const { board, mustContinueFrom } = game;

  // If in the middle of a capture chain, only that piece matters
  if (mustContinueFrom) {
    return hasCaptureFrom(game, mustContinueFrom.row, mustContinueFrom.col);
  }

  // Check all player's pieces
  const pieces = getAllPlayerPieces(board, playerColor);
  for (const { row, col } of pieces) {
    if (hasCaptureFrom(game, row, col)) {
      return true;
    }
  }
  return false;
}

function isValidMove(game, from, to, playerColor) {
  const { board, currentPlayer, status, mustContinueFrom } = game;
  console.log("Validating move:", from, to, "for player", playerColor);

  if (status !== "playing") return false;
  if (currentPlayer !== playerColor) return false;

  const { row: fr, col: fc } = from;
  const { row: tr, col: tc } = to;

  if (fr === tr && fc === tc) return false;
  if (tr < 0 || tr >= 8 || tc < 0 || tc >= 8) return false;

  const piece = board[fr]?.[fc];
  if (!piece) return false;
  if (piece.toLowerCase() !== playerColor) return false;

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

  // Check if this is a capture move
  let isCapture = false;
  if (isKing) {
    // For kings, check if there's an enemy along the diagonal path
    const dirR = dr > 0 ? 1 : -1;
    const dirC = dc > 0 ? 1 : -1;
    for (let dist = 1; dist < absDr; dist++) {
      const checkR = fr + dirR * dist;
      const checkC = fc + dirC * dist;
      const checkPiece = board[checkR][checkC];
      if (checkPiece && checkPiece.toLowerCase() !== piece.toLowerCase()) {
        isCapture = true;
        break;
      }
    }
  } else {
    isCapture = absDr === 2 && absDc === 2;
  }

  // MANDATORY CAPTURE RULE: If player has any capture available, they MUST capture
  if (!isCapture && playerHasAnyCapture(game, playerColor)) {
    return false; // Non-capture move when capture is available = invalid
  }

  // Kings have special movement rules
  if (isKing) {
    return isValidKingMove(game, from, to, piece, mustContinueFrom);
  }

  // Regular piece logic
  const isSimpleMove = absDr === 1 && absDc === 1;

  if (!isCapture && !isSimpleMove) {
    return false;
  }

  if (isCapture) {
    const midR = fr + dr / 2;
    const midC = fc + dc / 2;
    const midPiece = board[midR]?.[midC];
    if (!midPiece) return false;
    if (midPiece.toLowerCase() === piece.toLowerCase()) return false;
    return true;
  }

  if (mustContinueFrom) {
    return false;
  }

  if (isWhite && dr >= 0) return false;
  if (!isWhite && dr <= 0) return false;

  return true;
}

function isValidKingMove(game, from, to, piece, mustContinueFrom) {
  const { board } = game;
  const { row: fr, col: fc } = from;
  const { row: tr, col: tc } = to;

  const dr = tr - fr;
  const dc = tc - fc;
  const absDr = Math.abs(dr);
  const absDc = Math.abs(dc);

  // Must move diagonally
  if (absDr !== absDc) return false;

  // King can move 1 square OR multiple squares
  if (absDr < 1) return false;

  const dirR = dr > 0 ? 1 : -1;
  const dirC = dc > 0 ? 1 : -1;

  let foundEnemy = false;
  let enemyRow = -1;
  let enemyCol = -1;
  let distance = 1;

  // Scan the diagonal path
  while (distance < absDr) {
    const checkR = fr + dirR * distance;
    const checkC = fc + dirC * distance;

    const checkPiece = board[checkR][checkC];

    if (checkPiece === null) {
      // Empty square, continue scanning
    } else if (checkPiece.toLowerCase() === piece.toLowerCase()) {
      // Our own piece blocks the path
      return false;
    } else {
      // Enemy piece
      if (foundEnemy) {
        // Can't jump over two pieces
        return false;
      }
      foundEnemy = true;
      enemyRow = checkR;
      enemyCol = checkC;
    }

    distance++;
  }

  // Check destination square
  if (board[tr][tc] !== null) {
    return false;
  }

  // If we found an enemy, this is a capture move
  if (foundEnemy) {
    // King can land on any empty square after the captured piece
    // Just verify the path after the enemy is clear (already checked above)
    return true;
  } else {
    // This is a simple move (no capture)
    if (mustContinueFrom) {
      // During capture chain, only captures allowed
      return false;
    }
    // King can move any number of empty squares diagonally
    return true;
  }
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

  let didCapture = false;

  const isKing = piece === piece.toUpperCase();

  if (isKing) {
    // King capture: find and remove the jumped piece along the diagonal
    const dirR = dr > 0 ? 1 : -1;
    const dirC = dc > 0 ? 1 : -1;

    for (let dist = 1; dist < absDr; dist++) {
      const checkR = fr + dirR * dist;
      const checkC = fc + dirC * dist;
      const checkPiece = board[checkR][checkC];

      if (checkPiece && checkPiece.toLowerCase() !== piece.toLowerCase()) {
        board[checkR][checkC] = null;
        didCapture = true;
        break;
      }
    }
  } else {
    // Regular piece capture
    const absDc = Math.abs(tc - fc);
    if (absDr === 2 && absDc === 2) {
      const mr = fr + dr / 2;
      const mc = fc + dc / 2;
      board[mr][mc] = null;
      didCapture = true;
    }
  }

  board[tr][tc] = piece;

  // King promotion
  if (piece === "w" && tr === 0) board[tr][tc] = "W";
  if (piece === "b" && tr === 7) board[tr][tc] = "B";

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

    socket.emit("joinedRoom", {
      roomId,
      playerColor: color,
      gameState: room.game,
      players: room.players,
    });

    socket.to(roomId).emit("playerJoined", {
      socketId: socket.id,
      name,
      color,
      gameState: room.game,
      players: room.players,
    });

    io.to(roomId).emit("gameUpdate", room.game);
  });

  socket.on("makeMove", ({ roomId, from, to }) => {
    const room = rooms[roomId];
    if (!room) return;

    const { game } = room;
    const playerColor = getPlayerColor(room, socket.id);
    if (!playerColor) return;

    // Check if the move is valid
    if (!isValidMove(game, from, to, playerColor)) {
      // Check if player tried to make a non-capture move when capture was available
      const { row: fr, col: fc } = from;
      const { row: tr, col: tc } = to;
      const piece = game.board[fr]?.[fc];

      if (piece && piece.toLowerCase() === playerColor) {
        const dr = tr - fr;
        const dc = tc - fc;
        const absDr = Math.abs(dr);
        const absDc = Math.abs(dc);
        const isKing = piece === piece.toUpperCase();

        // Check if this was a simple move attempt
        let isSimpleMoveAttempt = false;
        if (isKing) {
          // King simple move: diagonal with no captures
          if (absDr === absDc && absDr > 0) {
            const dirR = dr > 0 ? 1 : -1;
            const dirC = dc > 0 ? 1 : -1;
            let hasEnemyInPath = false;
            for (let dist = 1; dist < absDr; dist++) {
              const checkR = fr + dirR * dist;
              const checkC = fc + dirC * dist;
              const checkPiece = game.board[checkR]?.[checkC];
              if (
                checkPiece &&
                checkPiece.toLowerCase() !== piece.toLowerCase()
              ) {
                hasEnemyInPath = true;
                break;
              }
            }
            if (!hasEnemyInPath && game.board[tr]?.[tc] === null) {
              isSimpleMoveAttempt = true;
            }
          }
        } else {
          // Regular piece simple move
          if (absDr === 1 && absDc === 1 && game.board[tr]?.[tc] === null) {
            isSimpleMoveAttempt = true;
          }
        }

        // If player tried simple move but has capture available, send warning
        if (isSimpleMoveAttempt && playerHasAnyCapture(game, playerColor)) {
          socket.emit("mustCapture", {
            message: "You must capture when a capture is available!",
          });
          return;
        }
      }

      socket.emit("invalidMove");
      return;
    }

    applyMove(game, from, to);
    io.to(roomId).emit("gameUpdate", game);
  });

  socket.on("resetGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const playerColor = getPlayerColor(room, socket.id);
    if (!playerColor) return;

    // Send reset request to the other player
    socket.to(roomId).emit("resetRequest", {
      fromPlayer: playerColor,
      requesterId: socket.id,
    });
  });

  socket.on("resetResponse", ({ roomId, accepted, requesterId }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (accepted) {
      // Reset the game
      room.game = createNewGame();
      if (countPlayers(room) === 2) {
        room.game.status = "playing";
      }

      io.to(roomId).emit("gameUpdate", room.game);
      io.to(roomId).emit("resetConfirmed");
    } else {
      // Notify requester that reset was declined
      io.to(requesterId).emit("resetDeclined");
    }
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
