import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { availableParallelism } from "node:os";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";
let userOnLine = [];
let userOffLine = [];
let userWriting = [];
//Reconocer un estado desde el cliente que me indique si se desconecto :D
if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }

  setupPrimary();
} else {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT,
      user TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter(),
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  io.on("connection", async (socket) => {
    socket.on("chat message", async (msg, user, clientOffset, callback) => {
      if (userWriting.includes(user)) {
        let position = userWriting.indexOf(user);
        userWriting.splice(position, 1);
        console.log(userWriting);
        io.emit("writing", userWriting);
        socket.emit("users", userOnLine);
        callback();
      }
      let result;
      try {
        result = await db.run(
          "INSERT INTO messages (content,user, client_offset) VALUES (?,?, ?)",
          msg,
          user,
          clientOffset
        );
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          callback();
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      //brodcast para que no se envie a quien lo emite, pero si a todos.
      io.emit("chat message", msg, user, result.lastID);
      callback();
    });

    // socket.on("userstatus", async (status, nickname) => {
    //   console.log(`El servidor emite estado: ${status} usuario: ${nickname}`);
    //   io.emit("userstatus", status, nickname);
    // });
    if (!socket.recovered) {
      try {
        await db.each(
          "SELECT id, content,user FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.user, row.id);
          }
        );
      } catch (e) {
        // something went wrong
      }
    }
    socket.on("writing", async (user, callback) => {
      userWriting.push(user);
      console.log(userWriting);
      socket.broadcast.emit("writing", userWriting);
      callback();
    });
    socket.on("removeUserWriting", async (user, callback) => {
      if (userWriting.includes(user)) {
        let position = userWriting.indexOf(user);
        userWriting.splice(position, 1);
      }
      callback();
    });

    socket.on("users", async (user, callback) => {
      if (!userOnLine.includes(user)) {
        userOnLine.push(user);
        console.log(`Usuarios en linea: ${userOnLine}`);
      }
      callback();
    });
    // socket.on("removeWriting", async (user, callback) => {
    //   console.log(userWriting.includes(user));
    //   if (userWriting.includes(user)) {
    //     let position = userWriting.indexOf(user);
    //     userWriting.splice(position, 1);
    //     console.log(userWriting);
    //     socket.broadcast.emit("writing", userWriting);
    //     callback();
    //   }
    // });

    //Fin socket
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}
