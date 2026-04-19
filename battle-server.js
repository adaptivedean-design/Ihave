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
  socket.on('join_room', ({ roomId, playerId, isHost }) => {
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
      playerId: playerId,
      isHost: isHost || false
    };
    
    console.log(`Player ${playerId} joined room ${roomId} (host: ${isHost})`);
  });

  // Card played - check for battle
  socket.on('card_played', ({ roomId, playerId, card, isHost }) => {
    console.log(`\n========== CARD PLAYED ==========`);
    console.log(`Player: ${playerId}`);
    console.log(`Room: ${roomId}`);
    console.log(`Card: ${card.iHave}`);
    console.log(`IsHost: ${isHost}`);
    
    const room = rooms[roomId];
    if (!room) {
      console.log(`❌ Room ${roomId} not found!`);
      return;
    }

    const now = Date.now();
    
    console.log(`Current pending plays:`, Object.keys(room.pendingPlays).map(pid => ({
      playerId: pid,
      age: now - room.pendingPlays[pid].timestamp
    })));
    
    // Check if another player has a pending play within 2000ms
    // FOR TESTING: Allow same player to trigger battle with themselves
    let battleOpponent = null;
    for (const [pid, pending] of Object.entries(room.pendingPlays)) {
      const age = now - pending.timestamp;
      console.log(`Checking pending play from ${pid}, age: ${age}ms`);
      
      if (age < 2000) {
        // Found a pending play within time window
        if (pid !== playerId) {
          // Different player - normal battle
          console.log(`✅ DIFFERENT PLAYER - Battle triggered!`);
          battleOpponent = { playerId: pid, card: pending.card, isHost: pending.isHost };
          break;
        } else {
          // Same player - testing mode (allow battle with self)
          console.log('🧪 TESTING MODE: same player triggering battle');
          battleOpponent = { playerId: pid + '_clone', card: pending.card, isHost: pending.isHost };
          break;
        }
      }
    }

    if (battleOpponent && !room.activeBattle) {
      // BATTLE!
      console.log(`🎮 BATTLE triggered between ${playerId} and ${battleOpponent.playerId}`);
      
      // Determine who is student and apply 1/3 chance bonus
      const player1IsStudent = !battleOpponent.isHost;
      const player2IsStudent = !isHost;
      const hasStudentBonus = Math.random() < 0.333;
      
      room.activeBattle = {
        player1: battleOpponent.playerId.replace('_clone', ''), // Remove clone suffix
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
      console.log(`📢 Emitting battle_start to room ${roomId}`);
      io.to(roomId).emit('battle_start', room.activeBattle);
      
    } else if (!room.activeBattle) {
      // No battle - add to pending
      console.log(`No battle opponent found, adding to pending plays`);
      room.pendingPlays[playerId] = {
        card: card,
        timestamp: now,
        isHost: isHost
      };
      
      // Set timeout to auto-play after 2.1 seconds if no battle occurs
      setTimeout(() => {
        // Check if this pending play still exists and no battle started
        if (room.pendingPlays[playerId] && !room.activeBattle) {
          console.log(`⏰ Timeout: Auto-playing card for ${playerId} (no battle occurred)`);
          socket.emit('play_card_now', { card: card });
          delete room.pendingPlays[playerId];
        }
      }, 2100);
      
      console.log(`⏳ Pending play registered, will auto-play in 2.1s if no battle. Pending count: ${Object.keys(room.pendingPlays).length}`);
    } else {
      console.log(`⚠️ Battle already active, ignoring card play`);
    }
    console.log(`================================\n`);
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
