const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const suits = ['♠', '♥', '♦', '♣'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

let users = {}; // { username: balance }
let rooms = {}; // Active poker tables

function getDeck() {
    let deck = [];
    suits.forEach(suit => values.forEach((value, idx) => 
        deck.push({ suit, value, valNum: idx + 2, color: (suit === '♥' || suit === '♦') ? 'text-red-600' : 'text-black' })
    ));
    return deck.sort(() => Math.random() - 0.5);
}

// Minimal Server Poker Hand Evaluator (Simplified Scoring)
function evaluateHand(hand, board) {
    let cards = [...hand, ...board].sort((a,b) => b.valNum - a.valNum);
    if(cards.length === 0) return 0;
    
    let counts = {}, flushSuit = null, suitCounts = { '♠':0, '♥':0, '♦':0, '♣':0 };
    cards.forEach(c => { counts[c.valNum] = (counts[c.valNum]||0)+1; suitCounts[c.suit]++; });
    for (let s in suitCounts) if(suitCounts[s] >= 5) flushSuit = s;
    let freqs = Object.entries(counts).sort((a,b) => b[1] - a[1] || b[0] - a[0]);
    
    let score = 0;
    let topVal = parseInt(freqs[0][0]);
    if(flushSuit) score += 5000 + topVal; 
    else if(freqs[0][1] === 4) score += 4000 + topVal; // 4 of kind
    else if(freqs[0][1] === 3 && freqs.length > 1 && freqs[1][1] >= 2) score += 3000 + topVal; // Full house
    else if(freqs[0][1] === 3) score += 2000 + topVal; // 3 of kind
    else if(freqs[0][1] === 2 && freqs.length > 1 && freqs[1][1] === 2) score += 1000 + topVal; // Two pair
    else if(freqs[0][1] === 2) score += 500 + topVal; // Pair
    else score += topVal; // High card
    
    return score;
}

function broadcastLobby() {
    let activeRooms = Object.values(rooms).map(r => ({ id: r.id, players: r.players.length }));
    io.emit('lobby_update', activeRooms);
}

io.on('connection', (socket) => {
    socket.on('login', (username) => {
        socket.username = username;
        if (users[username] === undefined) users[username] = 1000;
        socket.emit('update_balance', users[username]);
        broadcastLobby();
    });

    socket.on('request_pity', () => {
        if (users[socket.username] <= 0) {
            users[socket.username] = 100;
            socket.emit('update_balance', users[socket.username]);
            socket.emit('chat_msg', { sys: true, msg: "Boss felt bad for you. +100 Pity Money added." });
        }
    });

    // --- SLOTS MINI GAME ---
    socket.on('play_slots', (bet) => {
        if (users[socket.username] < bet) return socket.emit('chat_msg', { sys: true, msg: "Not enough funds!" });
        users[socket.username] -= bet;
        
        const symbols = ['🍒', '🍋', '🔔', 'BAR', '7️⃣'];
        let result = [symbols[Math.floor(Math.random()*5)], symbols[Math.floor(Math.random()*5)], symbols[Math.floor(Math.random()*5)]];
        
        let win = 0;
        if(result[0] === result[1] && result[1] === result[2]) win = bet * 15; // Jackpot!
        else if (result[0] === result[1] || result[1] === result[2]) win = bet * 2; // Small win
        
        users[socket.username] += win;
        socket.emit('slots_result', { result, win });
        socket.emit('update_balance', users[socket.username]);
    });

    // --- ROOM MANAGEMENT ---
    socket.on('create_room', (roomId) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { id: roomId, players: [], deck: getDeck(), center: [], state: 'waiting', turnIdx: 0, pot: 0, highestBet: 0 };
        }
        broadcastLobby();
    });

    socket.on('join_room', (roomId) => {
        if(socket.roomId) socket.leave(socket.roomId); // Ensure single room handling
        socket.join(roomId);
        let r = rooms[roomId];
        socket.roomId = roomId;
        // Don't duplicate users on multiple fast clicks
        if (!r.players.find(p => p.id === socket.id)) {
            r.players.push({ id: socket.id, user: socket.username, hand: [], bet: 0, folded: false, allIn: false });
        }
        io.to(roomId).emit(`update_poker`, r);
        broadcastLobby();
    });

    socket.on('leave_room', () => {
        if (!socket.roomId) return;
        let r = rooms[socket.roomId];
        if(!r) return;
        r.players = r.players.filter(p => p.id !== socket.id);
        socket.leave(socket.roomId);
        socket.roomId = null;
        
        if(r.players.length === 0) { delete rooms[r.id]; }
        else { io.to(r.id).emit(`update_poker`, r); }
        broadcastLobby();
    });

    // --- POKER ENGINE LOOP ---
    function checkRoundEnd(r) {
        let active = r.players.filter(p => !p.folded);
        if(active.length === 1) return finishPokerRound(r, active[0]); // Only 1 guy left, he wins!
        
        // See if all active/non-allin players match the highest bet
        let betMismatch = active.some(p => !p.allIn && p.bet !== r.highestBet);
        
        if (!betMismatch) {
            // Next street! Wait 1.5 seconds so humans can process before instantly dealing cards
            setTimeout(() => advanceStreet(r), 1500); 
        } else {
            cycleTurn(r);
        }
    }

    function advanceStreet(r) {
        if(!rooms[r.id]) return; // Failsafe
        
        r.highestBet = 0; // Reset bets for street
        r.players.forEach(p => p.bet = 0);
        r.turnIdx = 0;
        
        // Set turnIdx to the first non-folded person
        cycleTurn(r, true); 

        if(r.state === 'preflop') { r.state = 'flop'; r.center = [r.deck.pop(), r.deck.pop(), r.deck.pop()]; }
        else if(r.state === 'flop') { r.state = 'turn'; r.center.push(r.deck.pop()); }
        else if(r.state === 'turn') { r.state = 'river'; r.center.push(r.deck.pop()); }
        else if(r.state === 'river') {
            let winners = r.players.filter(p => !p.folded)
                          .map(p => ({ p, score: evaluateHand(p.hand, r.center) }))
                          .sort((a,b) => b.score - a.score);
            return finishPokerRound(r, winners[0].p); // Winner Found
        }
        io.to(r.id).emit('update_poker', r);
    }

    function cycleTurn(r, initialize = false) {
        let maxChecks = r.players.length + 1;
        let checks = 0;
        
        if (!initialize) { r.turnIdx = (r.turnIdx + 1) % r.players.length; }

        while ((r.players[r.turnIdx].folded || r.players[r.turnIdx].allIn) && checks < maxChecks) {
            r.turnIdx = (r.turnIdx + 1) % r.players.length;
            checks++;
        }
        
        // Failsafe if literally everyone is All-In
        if (checks >= r.players.length) { advanceStreet(r); } 
        else { io.to(r.id).emit('update_poker', r); }
    }

    function finishPokerRound(r, winnerData) {
        r.state = 'showdown';
        io.to(r.id).emit('update_poker', r);
        io.to(r.id).emit('chat_msg', {sys: true, msg: `${winnerData.user} wins Pot of $${r.pot}!`});
        users[winnerData.user] += r.pot;
        
        // Evict bankrupted
        r.players.forEach(p => { 
            if (users[p.user] <= 0 && p.id) {
                let s = io.sockets.sockets.get(p.id);
                if (s) { s.emit('boot_lobby'); s.leave(r.id); }
            }
        });
        r.players = r.players.filter(p => users[p.user] > 0);

        setTimeout(() => {
            if(!rooms[r.id]) return;
            r.players.forEach(p => { p.hand = []; p.bet = 0; p.folded = false; p.allIn = false; });
            r.state = 'waiting';
            r.center = []; r.pot = 0; r.highestBet = 0; r.deck = getDeck();
            
            io.to(r.id).emit('update_poker', r);
            // Refresh player balances to frontend
            r.players.forEach(p => {
                 let sock = io.sockets.sockets.get(p.id);
                 if(sock) sock.emit('update_balance', users[p.user]);
            });
        }, 5000);
    }

    socket.on('start_poker', () => {
        let r = rooms[socket.roomId];
        if(!r || r.players.length < 2) return;
        r.state = 'preflop'; r.deck = getDeck(); r.pot = 0; r.center = []; r.highestBet = 0;
        r.players.forEach(p => {
            p.folded = false; p.bet = 0; p.allIn = (users[p.user] <= 0);
            if(!p.allIn) p.hand = [r.deck.pop(), r.deck.pop()];
        });
        r.turnIdx = 0; // Starts with dealer (no blinds to keep math clean for casual family game)
        io.to(r.id).emit('update_poker', r);
    });

    socket.on('poker_action', (data) => {
        let r = rooms[socket.roomId];
        if(!r || r.state === 'waiting' || r.state === 'showdown') return;
        
        let p = r.players[r.turnIdx];
        if(!p || p.id !== socket.id) return; // Wait ur turn!

        let amountNeeded = r.highestBet - p.bet;

        if (data.type === 'fold') {
            p.folded = true;
        } else if (data.type === 'check_call') {
            let actualCall = amountNeeded;
            if (users[p.user] <= actualCall) { // He can't afford a full call! All-In side case.
                actualCall = users[p.user];
                p.allIn = true;
            }
            p.bet += actualCall; r.pot += actualCall; users[p.user] -= actualCall;
        } else if (data.type === 'raise') {
            let totalRaiseTo = data.amount;
            if (totalRaiseTo <= r.highestBet) totalRaiseTo = r.highestBet + 10; // Forced min-raise 
            
            let amountFromWallet = totalRaiseTo - p.bet;

            if (users[p.user] <= amountFromWallet) { // Cannot afford! Forced All In!
                amountFromWallet = users[p.user];
                p.allIn = true;
                totalRaiseTo = p.bet + amountFromWallet; 
            }
            p.bet += amountFromWallet; r.pot += amountFromWallet; users[p.user] -= amountFromWallet;
            r.highestBet = totalRaiseTo; 
        }

        socket.emit('update_balance', users[p.user]);
        checkRoundEnd(r); // Moves system to next phase if math is sound
    });

    socket.on('disconnect', () => {
        if(socket.roomId && rooms[socket.roomId]) {
            rooms[socket.roomId].players = rooms[socket.roomId].players.filter(p => p.id !== socket.id);
            if(rooms[socket.roomId].players.length === 0) delete rooms[socket.roomId];
            else io.to(socket.roomId).emit(`update_poker`, rooms[socket.roomId]);
        }
        broadcastLobby();
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Vintage Casino API Live on ${PORT}`));

