const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

let rooms = {};
const MAX_ROUNDS = 5;
const BET_TIME = 20;
const TURN_TIME = 20;
const RESULT_TIME = 8;
const DEALER_WAIT_TIME = 2000;

function getRoomIdFromSocket(socket) {
    let roomId = null;
    for (const r of socket.rooms) {
        if (r !== socket.id) { roomId = r; break; }
    }
    return roomId;
}

io.on('connection', (socket) => {

    function checkAndEndActionPhase(roomId) {
        const room = rooms[roomId];
        if (!room || room.gameState !== 'actionPhase') return;
        const allPlayersDone = Object.values(room.players).every(player => {
            if (player.bet > 0 && !player.isEliminated) {
                return player.status === 'stand' || player.status === 'bust';
            }
            return true;
        });
        if (allPlayersDone) {
            clearInterval(room.timers.actionTimer);
            io.to(roomId).emit('notification', { message: '全員の行動が確定しました。ディーラーのターンです...'});
            setTimeout(() => {
                dealerTurn(roomId);
            }, DEALER_WAIT_TIME);
        }
    }

    socket.on('createRoom', (data) => {
        const { roomId, playerName } = data;
        if (rooms[roomId]) { socket.emit('errorMsg', 'そのルームIDは既に使用されています。'); return; }
        socket.join(roomId);
        rooms[roomId] = { players: { [socket.id]: createPlayer(playerName) }, gameState: 'waiting', round: 0, dealer: { hand: [], score: 0 }, timers: {} };
        socket.emit('roomJoined', { roomId });
        updateGameState(roomId);
    });

    socket.on('joinRoom', (data) => {
        const { roomId, playerName } = data;
        if (!rooms[roomId]) { socket.emit('errorMsg', 'そのルームIDは存在しません。'); return; }
        if (Object.keys(rooms[roomId].players).length >= 5) { socket.emit('errorMsg', 'このルームは満員です。'); return; }
        socket.join(roomId);
        rooms[roomId].players[socket.id] = createPlayer(playerName);
        socket.emit('roomJoined', { roomId });
        updateGameState(roomId);
    });
    
    socket.on('requestStartGame', () => {
        const roomId = getRoomIdFromSocket(socket);
        if (!roomId) { return; }
        const room = rooms[roomId];
        if (room && room.gameState === 'waiting' && Object.keys(room.players).length >= 1) {
            startGame(roomId);
        }
    });

    socket.on('placeBet', (data) => {
        const { roomId, amount } = data;
        const room = rooms[roomId];
        if (!room || !room.players[socket.id] || room.gameState !== 'betting') return;
        const player = room.players[socket.id];
        if (player.isEliminated) return;
        const betAmount = parseInt(amount, 10);
        if (betAmount > 0) {
            player.bet = betAmount;
            player.status = 'betted';
            const allPlayersBetted = Object.values(room.players).every(p => p.status === 'betted' || p.isEliminated);
            if (allPlayersBetted) {
                clearTimeout(room.timers.betTimeout);
                clearInterval(room.timers.betCountdown);
                dealCards(roomId);
            } else {
                updateGameState(roomId);
            }
        }
    });

    socket.on('hit', (roomId) => {
        const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
        const player = room.players[socket.id];
        if (room.gameState !== 'actionPhase' || player.status !== 'playing') { return; }
        player.hand.push(dealCard(room.deck));
        player.score = calculateScore(player.hand);
        if (player.score > 21) { player.status = 'bust'; }
        updateGameState(roomId);
        checkAndEndActionPhase(roomId);
    });

    socket.on('stand', (roomId) => {
        const room = rooms[roomId]; if (!room || !room.players[socket.id]) return;
        const player = room.players[socket.id];
        if (room.gameState !== 'actionPhase' || player.status !== 'playing') { return; }
        player.status = 'stand';
        updateGameState(roomId);
        checkAndEndActionPhase(roomId);
    });

    socket.on('disconnect', () => {
        const roomId = getRoomIdFromSocket(socket);
        if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
            delete rooms[roomId].players[socket.id];
            if (Object.keys(rooms[roomId].players).length === 0) {
                clearAllTimers(roomId); delete rooms[roomId];
            } else {
                updateGameState(roomId);
                checkAndEndActionPhase(roomId);
            }
        }
    });
    
    function createPlayer(playerName) {
        return { name: playerName, chips: 1000, bet: 0, hand: [], score: 0, status: 'waiting', isEliminated: false };
    }

    function startGame(roomId) { const room = rooms[roomId]; room.round = 1; startRound(roomId); }

    function startRound(roomId) {
        const room = rooms[roomId]; if (!room) return;
        clearAllTimers(roomId);
        room.gameState = 'betting'; room.deck = createDeck(); room.dealer = { hand: [], score: 0, status: '' };
        for (const id in room.players) {
            const player = room.players[id];
            player.hand = []; player.score = 0; player.bet = 0; player.result = '';
            if (player.isEliminated) {
                player.status = '脱落';
            } else {
                player.status = 'betting';
            }
        }
        let countdown = BET_TIME;
        const betCountdown = setInterval(() => {
            io.to(roomId).emit('betCountdown', { seconds: countdown });
            countdown--;
            if(countdown < 0) { clearInterval(betCountdown); }
        }, 1000);
        room.timers.betCountdown = betCountdown;

        const betTimeout = setTimeout(() => {
            if (rooms[roomId] && rooms[roomId].gameState === 'betting') {
                for(const id in room.players){
                    if(room.players[id].status === 'betting'){
                        room.players[id].bet = 0;
                        room.players[id].status = 'betted';
                    }
                }
                dealCards(roomId);
            }
        }, BET_TIME * 1000 + 500);
        room.timers.betTimeout = betTimeout;
        updateGameState(roomId);
    }
    
    function dealCards(roomId) {
        const room = rooms[roomId]; if (!room || room.gameState !== 'betting') return;
        clearAllTimers(roomId);
        for (const id in room.players) {
            const player = room.players[id];
            if(player.bet > 0 && !player.isEliminated) {
                player.hand.push(dealCard(room.deck)); player.hand.push(dealCard(room.deck));
                player.score = calculateScore(player.hand); player.status = 'playing';
            } else {
                if (!player.isEliminated) player.status = 'stand';
            }
        }
        room.dealer.hand.push(dealCard(room.deck)); room.dealer.hand.push(dealCard(room.deck));
        room.dealer.score = calculateScore(room.dealer.hand);
        startActionPhase(roomId);
    }

    function startActionPhase(roomId) {
        const room = rooms[roomId]; if (!room) return;
        room.gameState = 'actionPhase';
        updateGameState(roomId);
        let countdown = TURN_TIME;
        const actionTimer = setInterval(() => {
            io.to(roomId).emit('actionCountdown', { seconds: countdown });
            countdown--;
            if (countdown < 0) {
                clearInterval(actionTimer);
                for (const id in room.players) { if (room.players[id].status === 'playing') { room.players[id].status = 'stand'; }}
                updateGameState(roomId);
                io.to(roomId).emit('notification', { message: 'ディーラーのターンです...'});
                setTimeout(() => {
                    dealerTurn(roomId);
                }, DEALER_WAIT_TIME);
            }
        }, 1000);
        room.timers.actionTimer = actionTimer;
    }

    function dealerTurn(roomId) {
        const room = rooms[roomId]; if (!room) return;
        room.gameState = 'dealer'; updateGameState(roomId);
        room.timers.dealerTurn = setInterval(() => {
            if (room.dealer.score < 17) { room.dealer.hand.push(dealCard(room.deck)); room.dealer.score = calculateScore(room.dealer.hand); updateGameState(roomId); }
            else { clearInterval(room.timers.dealerTurn); determineWinner(roomId); }
        }, 1500);
    }
    
    // UPDATED: この関数を修正しました
    function determineWinner(roomId) {
        const room = rooms[roomId]; if (!room) return;
        room.gameState = 'result'; const dealerScore = room.dealer.score;
        for (const id in room.players) {
            const player = room.players[id];
            if (player.bet > 0) {
                let resultMsg = '';
                if (player.status === 'bust') {
                    resultMsg = '負け (バスト)';
                    player.chips -= player.bet;
                    if (player.chips < 0) player.isEliminated = true;
                }
                else if (dealerScore > 21 || player.score > dealerScore) {
                    resultMsg = '勝ち！';
                    player.chips += player.bet;
                }
                else if (player.score < dealerScore) {
                    resultMsg = '負け...';
                    player.chips -= player.bet;
                    if (player.chips < 0) player.isEliminated = true;
                }
                else {
                    resultMsg = '引き分け';
                }
                player.result = resultMsg;
            }
        }
        updateGameState(roomId);

        if (room.round >= MAX_ROUNDS) {
            io.to(roomId).emit('notification', { message: '最終結果を集計しています...'});
            setTimeout(() => {
                // タイムアウト時にルームが存在するか再度チェック
                if (!rooms[roomId]) return;

                const fullRanking = Object.keys(rooms[roomId].players).map(id => ({
                    id: id, name: rooms[roomId].players[id].name, chips: rooms[roomId].players[id].chips
                })).sort((a, b) => b.chips - a.chips);

                const top5Ranking = fullRanking.slice(0, 5);
                const socketsInRoom = io.sockets.adapter.rooms.get(roomId);

                if (socketsInRoom) {
                    socketsInRoom.forEach(socketId => {
                        const targetSocket = io.sockets.sockets.get(socketId);
                        const myRankIndex = fullRanking.findIndex(p => p.id === socketId);
                        const myData = fullRanking[myRankIndex];

                        // myDataが存在する場合のみ送信（接続切れ対策）
                        if (targetSocket && myData) {
                            const payload = {
                                top5: top5Ranking,
                                personal: { rank: myRankIndex + 1, chips: myData.chips }
                            };
                            targetSocket.emit('finalRanking', payload);
                        }
                    });
                }
                // 処理が完了したらルームを削除
                delete rooms[roomId];
            }, 2000);
        } else {
            let countdown = RESULT_TIME;
            room.timers.countdownTimer = setInterval(() => {
                io.to(roomId).emit('nextRoundCountdown', { seconds: countdown });
                countdown--;
                if (countdown < 0) {
                    clearInterval(room.timers.countdownTimer);
                    room.round++;
                    startRound(roomId);
                }
            }, 1000);
        }
    }

    function updateGameState(roomId) {
        const room = rooms[roomId]; if (!room) return;
        const hideDealerCard = room.gameState === 'actionPhase';
        const stateForClient = { players: room.players, gameState: room.gameState, round: room.round, dealer: { hand: (hideDealerCard) ? [room.dealer.hand[0], { suit: 'hidden', value: ' ' }] : room.dealer.hand, score: (hideDealerCard) ? calculateScore([room.dealer.hand[0]]) : room.dealer.score }};
        io.to(roomId).emit('gameStateUpdate', stateForClient);
    }
    function clearAllTimers(roomId) { const room = rooms[roomId]; if(room && room.timers) { for (const timer in room.timers) { clearInterval(room.timers[timer]); clearTimeout(room.timers[timer]); }}}
});
function createDeck() { const suits = ['♥', '♦', '♣', '♠']; const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']; let deck = []; for (const suit of suits) { for (const value of values) { deck.push({ suit, value }); } } return deck.sort(() => Math.random() - 0.5); }
function dealCard(deck) { return deck.pop(); }
function calculateScore(hand) { let score = 0; let aceCount = 0; for (const card of hand) { if (card.value === 'A') { aceCount++; score += 11; } else if (['J', 'Q', 'K'].includes(card.value)) { score += 10; } else { score += parseInt(card.value); }} while (score > 21 && aceCount > 0) { score -= 10; aceCount--; } return score; }
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));