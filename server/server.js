//Import dependencies
const path = require('path');
const http = require('http');
const express = require('express');
const socketIO = require('socket.io');

//Import classes
const { LiveGames } = require('./utils/liveGames');
const { Players } = require('./utils/players');

const publicPath = path.join(__dirname, '../public');
var app = express();
var server = http.createServer(app);
var io = socketIO(server);
var games = new LiveGames();
var players = new Players();

//Mongodb setup - ATUALIZADO PARA VERSÃO NOVA
const { MongoClient } = require('mongodb');
var url = "mongodb://localhost:27017/";
const client = new MongoClient(url);

app.use(express.static(publicPath));

//Starting server on port 3000
server.listen(3000, () => {
    console.log("Server started on port 3000");
});

//When a connection to server is made from client
io.on('connection', (socket) => {

    //When host connects for the first time
    socket.on('host-join', async (data) => {
        try {
            await client.connect();
            const db = client.db("kahootDB");
            const query = { id: parseInt(data.id) };

            const result = await db.collection('kahootGames').find(query).toArray();

            //A kahoot was found with the id passed in url
            if (result[0] !== undefined) {
                var gamePin = Math.floor(Math.random() * 90000) + 10000; //new pin for game

                games.addGame(gamePin, socket.id, false, { playersAnswered: 0, questionLive: false, gameid: data.id, question: 1 });

                var game = games.getGame(socket.id);
                socket.join(game.pin);

                console.log('Game Created with pin:', game.pin);

                socket.emit('showGamePin', {
                    pin: game.pin
                });
            } else {
                socket.emit('noGameFound');
            }
        } catch (err) {
            console.log("Erro no host-join:", err);
        }
    });

    //When the host connects from the game view
    socket.on('host-join-game', async (data) => {
        var oldHostId = data.id;
        var game = games.getGame(oldHostId);

        if (game) {
            game.hostId = socket.id;
            socket.join(game.pin);
            var playerData = players.getPlayers(oldHostId);

            for (var i = 0; i < Object.keys(players.players).length; i++) {
                if (players.players[i].hostId == oldHostId) {
                    players.players[i].hostId = socket.id;
                }
            }
            var gameid = game.gameData['gameid'];

            try {
                await client.connect();
                const db = client.db('kahootDB');
                const query = { id: parseInt(gameid) };
                const res = await db.collection("kahootGames").find(query).toArray();

                var question = res[0].questions[0].question;
                var answer1 = res[0].questions[0].answers[0];
                var answer2 = res[0].questions[0].answers[1];
                var answer3 = res[0].questions[0].answers[2];
                var answer4 = res[0].questions[0].answers[3];
                var correctAnswer = res[0].questions[0].correct;

                socket.emit('gameQuestions', {
                    q1: question,
                    a1: answer1,
                    a2: answer2,
                    a3: answer3,
                    a4: answer4,
                    correct: correctAnswer,
                    playersInGame: playerData.length
                });

                io.to(game.pin).emit('gameStartedPlayer');
                game.gameData.questionLive = true;

            } catch (err) {
                console.log("Erro no host-join-game:", err);
            }
        } else {
            socket.emit('noGameFound');
        }
    });

    //When player connects for the first time
    socket.on('player-join', (params) => {
        var gameFound = false;

        for (var i = 0; i < games.games.length; i++) {
            if (params.pin == games.games[i].pin) {
                console.log('Player connected to game');
                var hostId = games.games[i].hostId;
                players.addPlayer(hostId, socket.id, params.name, { score: 0, answer: 0 });
                socket.join(params.pin);
                var playersInGame = players.getPlayers(hostId);
                io.to(params.pin).emit('updatePlayerLobby', playersInGame);
                gameFound = true;
            }
        }

        if (gameFound == false) {
            socket.emit('noGameFound');
        }
    });

    //When the player connects from game view
    socket.on('player-join-game', (data) => {
        var player = players.getPlayer(data.id);
        if (player) {
            var game = games.getGame(player.hostId);
            socket.join(game.pin);
            player.playerId = socket.id;
            var playerData = players.getPlayers(game.hostId);
            socket.emit('playerGameData', playerData);
        } else {
            socket.emit('noGameFound');
        }
    });

    //When a host or player leaves the site
    socket.on('disconnect', () => {
        var game = games.getGame(socket.id);
        if (game) {
            if (game.gameLive == false) {
                games.removeGame(socket.id);
                console.log('Game ended with pin:', game.pin);

                var playersToRemove = players.getPlayers(game.hostId);

                for (var i = 0; i < playersToRemove.length; i++) {
                    players.removePlayer(playersToRemove[i].playerId);
                }

                io.to(game.pin).emit('hostDisconnect');
                socket.leave(game.pin);
            }
        } else {
            var player = players.getPlayer(socket.id);
            if (player) {
                var hostId = player.hostId;
                var game = games.getGame(hostId);
                var pin = game.pin;

                if (game.gameLive == false) {
                    players.removePlayer(socket.id);
                    var playersInGame = players.getPlayers(hostId);
                    io.to(pin).emit('updatePlayerLobby', playersInGame);
                    socket.leave(pin);
                }
            }
        }
    });

    //Sets data in player class to answer from player
    socket.on('playerAnswer', async function (num) {
        var player = players.getPlayer(socket.id);
        var hostId = player.hostId;
        var playerNum = players.getPlayers(hostId);
        var game = games.getGame(hostId);

        if (game.gameData.questionLive == true) {
            player.gameData.answer = num;
            game.gameData.playersAnswered += 1;

            var gameQuestion = game.gameData.question;
            var gameid = game.gameData.gameid;

            try {
                await client.connect();
                const db = client.db('kahootDB');
                const query = { id: parseInt(gameid) };
                const res = await db.collection("kahootGames").find(query).toArray();

                var correctAnswer = res[0].questions[gameQuestion - 1].correct;

                if (num == correctAnswer) {
                    player.gameData.score += 100;
                    io.to(game.pin).emit('getTime', socket.id);
                    socket.emit('answerResult', true);
                }

                if (game.gameData.playersAnswered == playerNum.length) {
                    game.gameData.questionLive = false;
                    var playerData = players.getPlayers(game.hostId);
                    io.to(game.pin).emit('questionOver', playerData, correctAnswer);
                } else {
                    io.to(game.pin).emit('updatePlayersAnswered', {
                        playersInGame: playerNum.length,
                        playersAnswered: game.gameData.playersAnswered
                    });
                }
            } catch (err) {
                console.log("Erro no playerAnswer", err);
            }
        }
    });

    socket.on('getScore', function () {
        var player = players.getPlayer(socket.id);
        socket.emit('newScore', player.gameData.score);
    });

    socket.on('time', function (data) {
        var time = data.time / 20;
        time = time * 100;
        var playerid = data.player;
        var player = players.getPlayer(playerid);
        player.gameData.score += time;
    });

    socket.on('timeUp', async function () {
        var game = games.getGame(socket.id);
        game.gameData.questionLive = false;
        var playerData = players.getPlayers(game.hostId);

        var gameQuestion = game.gameData.question;
        var gameid = game.gameData.gameid;

        try {
            await client.connect();
            const db = client.db('kahootDB');
            const query = { id: parseInt(gameid) };
            const res = await db.collection("kahootGames").find(query).toArray();

            var correctAnswer = res[0].questions[gameQuestion - 1].correct;
            io.to(game.pin).emit('questionOver', playerData, correctAnswer);
        } catch (err) {
            console.log("Erro no timeUp", err);
        }
    });

    socket.on('nextQuestion', async function () {
        var playerData = players.getPlayers(socket.id);

        for (var i = 0; i < Object.keys(players.players).length; i++) {
            if (players.players[i].hostId == socket.id) {
                players.players[i].gameData.answer = 0;
            }
        }

        var game = games.getGame(socket.id);
        game.gameData.playersAnswered = 0;
        game.gameData.questionLive = true;
        game.gameData.question += 1;
        var gameid = game.gameData.gameid;

        try {
            await client.connect();
            const db = client.db('kahootDB');
            const query = { id: parseInt(gameid) };
            const res = await db.collection("kahootGames").find(query).toArray();

            if (res[0].questions.length >= game.gameData.question) {
                var questionNum = game.gameData.question;
                questionNum = questionNum - 1;
                var question = res[0].questions[questionNum].question;
                var answer1 = res[0].questions[questionNum].answers[0];
                var answer2 = res[0].questions[questionNum].answers[1];
                var answer3 = res[0].questions[questionNum].answers[2];
                var answer4 = res[0].questions[questionNum].answers[3];
                var correctAnswer = res[0].questions[questionNum].correct;

                socket.emit('gameQuestions', {
                    q1: question,
                    a1: answer1,
                    a2: answer2,
                    a3: answer3,
                    a4: answer4,
                    correct: correctAnswer,
                    playersInGame: playerData.length
                });
            } else {
                // Lógica de Fim de Jogo (Podium)
                var playersInGame = players.getPlayers(game.hostId);
                var first = { name: "", score: 0 };
                var second = { name: "", score: 0 };
                var third = { name: "", score: 0 };
                var fourth = { name: "", score: 0 };
                var fifth = { name: "", score: 0 };

                for (var i = 0; i < playersInGame.length; i++) {
                    if (playersInGame[i].gameData.score > fifth.score) {
                        if (playersInGame[i].gameData.score > fourth.score) {
                            if (playersInGame[i].gameData.score > third.score) {
                                if (playersInGame[i].gameData.score > second.score) {
                                    if (playersInGame[i].gameData.score > first.score) {
                                        //First Place logic push
                                        fifth.name = fourth.name; fifth.score = fourth.score;
                                        fourth.name = third.name; fourth.score = third.score;
                                        third.name = second.name; third.score = second.score;
                                        second.name = first.name; second.score = first.score;
                                        first.name = playersInGame[i].name; first.score = playersInGame[i].gameData.score;
                                    } else {
                                        //Second Place
                                        fifth.name = fourth.name; fifth.score = fourth.score;
                                        fourth.name = third.name; fourth.score = third.score;
                                        third.name = second.name; third.score = second.score;
                                        second.name = playersInGame[i].name; second.score = playersInGame[i].gameData.score;
                                    }
                                } else {
                                    //Third Place
                                    fifth.name = fourth.name; fifth.score = fourth.score;
                                    fourth.name = third.name; fourth.score = third.score;
                                    third.name = playersInGame[i].name; third.score = playersInGame[i].gameData.score;
                                }
                            } else {
                                //Fourth Place
                                fifth.name = fourth.name; fifth.score = fourth.score;
                                fourth.name = playersInGame[i].name; fourth.score = playersInGame[i].gameData.score;
                            }
                        } else {
                            //Fifth Place
                            fifth.name = playersInGame[i].name; fifth.score = playersInGame[i].gameData.score;
                        }
                    }
                }

                io.to(game.pin).emit('GameOver', {
                    num1: first.name, num2: second.name, num3: third.name, num4: fourth.name, num5: fifth.name
                });
            }
        } catch (err) {
            console.log("Erro no nextQuestion", err);
        }
    });

    //When the host starts the game
    socket.on('startGame', () => {
        var game = games.getGame(socket.id);
        game.gameLive = true;
        socket.emit('gameStarted', game.hostId);
    });

    //Give user game names data
    socket.on('requestDbNames', async function () {
        try {
            await client.connect();
            const db = client.db('kahootDB');
            const res = await db.collection("kahootGames").find().toArray();
            socket.emit('gameNamesData', res);
        } catch (err) {
            console.log("Erro ao pedir nomes", err);
        }
    });

    // --- AQUI ESTAVA O ERRO ---
    socket.on('newQuiz', async function (data) {
        try {
            await client.connect();
            const db = client.db('kahootDB');
            const result = await db.collection('kahootGames').find({}).toArray();

            var num = result.length;
            if (num == 0) {
                data.id = 1;
                num = 1;
            } else {
                data.id = result[num - 1].id + 1;
            }

            var game = data;
            await db.collection("kahootGames").insertOne(game);
            socket.emit('startGameFromCreator', num);

        } catch (err) {
            console.log("Erro ao criar Quiz:", err);
        }
    });

});