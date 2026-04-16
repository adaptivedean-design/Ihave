const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active rooms and their state
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join_room', ({ roomId, playerId }) => {
    socket.join(roomId);
    
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        pendingPlays: {},
        activeBattle: null
      };
    }
    
    rooms[roomId].players[playerId] = {
      socketId: socket.id,
      playerId: playerId
    };
    
    console.log(`Player ${playerId} joined room ${roomId}`);
  });

  // Card played - check for battle
  socket.on('card_played', ({ roomId, playerId, card, isHost }) => {
    console.log(`Card played: ${playerId} in room ${roomId}`);
    
    const room = rooms[roomId];
    if (!room) return;

    const now = Date.now();
    
    // Check if another player has a pending play within 2000ms
    let battleOpponent = null;
    for (const [pid, pending] of Object.entries(room.pendingPlays)) {
      if (pid !== playerId && (now - pending.timestamp) < 2000) {
        battleOpponent = { playerId: pid, card: pending.card, isHost: pending.isHost };
        break;
      }
    }

    if (battleOpponent && !room.activeBattle) {
      // BATTLE!
      console.log(`BATTLE triggered between ${playerId} and ${battleOpponent.playerId}`);
      
      // Determine who is student and apply 1/3 chance bonus
      const player1IsStudent = !battleOpponent.isHost;
      const player2IsStudent = !isHost;
      const hasStudentBonus = Math.random() < 0.333;
      
      room.activeBattle = {
        player1: battleOpponent.playerId,
        player2: playerId,
        card1: battleOpponent.card,
        card2: card,
        clicks1: 0,
        clicks2: 0,
        startTime: now,
        studentBonus: hasStudentBonus,
        student: player1IsStudent ? battleOpponent.playerId : (player2IsStudent ? playerId : null)
      };
      
      // Clear pending plays
      room.pendingPlays = {};
      
      // Notify both players battle started
      io.to(roomId).emit('battle_start', room.activeBattle);
      
    } else if (!room.activeBattle) {
      // No battle - add to pending or play immediately
      room.pendingPlays[playerId] = {
        card: card,
        timestamp: now,
        isHost: isHost
      };
      
      // If no other pending plays, play immediately
      if (Object.keys(room.pendingPlays).length === 1) {
        console.log(`No opponent pending, playing card immediately for ${playerId}`);
        socket.emit('play_card_now', { card: card });
        delete room.pendingPlays[playerId];
      }
    }
  });

  // Battle click
  socket.on('battle_click', ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || !room.activeBattle) return;
    
    const battle = room.activeBattle;
    
    if (battle.player1 === playerId) {
      battle.clicks1++;
    } else if (battle.player2 === playerId) {
      battle.clicks2++;
    }
    
    // Broadcast updated click counts
    io.to(roomId).emit('battle_update', {
      clicks1: battle.clicks1,
      clicks2: battle.clicks2
    });
  });

  // Battle ended (time's up)
  socket.on('battle_end', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.activeBattle) return;
    
    const battle = room.activeBattle;
    
    // Apply student bonus (1.2x multiplier)
    let effectiveClicks1 = battle.clicks1;
    let effectiveClicks2 = battle.clicks2;
    
    if (battle.studentBonus && battle.student) {
      if (battle.student === battle.player1) {
        effectiveClicks1 = Math.round(battle.clicks1 * 1.2);
      } else if (battle.student === battle.player2) {
        effectiveClicks2 = Math.round(battle.clicks2 * 1.2);
      }
    }
    
    // Determine winner
    const winner = effectiveClicks1 > effectiveClicks2 ? battle.player1 : battle.player2;
    const winnerCard = effectiveClicks1 > effectiveClicks2 ? battle.card1 : battle.card2;
    
    console.log(`Battle resolved: ${winner} wins with ${effectiveClicks1} vs ${effectiveClicks2}`);
    
    // Notify both players
    io.to(roomId).emit('battle_result', {
      winner: winner,
      winnerCard: winnerCard,
      clicks1: battle.clicks1,
      clicks2: battle.clicks2,
      effectiveClicks1: effectiveClicks1,
      effectiveClicks2: effectiveClicks2
    });
    
    // Clear battle
    room.activeBattle = null;
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Clean up player from rooms
    for (const roomId in rooms) {
      for (const playerId in rooms[roomId].players) {
        if (rooms[roomId].players[playerId].socketId === socket.id) {
          delete rooms[roomId].players[playerId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Battle server running on port ${PORT}`);
});
