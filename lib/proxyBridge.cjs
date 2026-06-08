"use strict";
// Локальный HTTP-прокси (БЕЗ авторизации, слушает 127.0.0.1), который туннелирует
// HTTPS-трафик (метод CONNECT) через upstream SOCKS5 С АВТОРИЗАЦИЕЙ.
// Зачем: Chromium/Electron не поддерживает логин/пароль для SOCKS5. Окно конторы ходит
// на этот локальный мост (без пароля), а он авторизуется в твоём SOCKS5.
// Конторы работают по HTTPS → метод CONNECT покрывает всё нужное.
const http = require("node:http");
const { SocksClient } = require("socks");

function startSocksBridge({ host, port, user, pass }) {
  const proxy = { host, port: Number(port), type: 5 };
  if (user) proxy.userId = user;
  if (pass) proxy.password = pass;

  const server = http.createServer((req, res) => {
    // Обычный HTTP (не CONNECT) почти не нужен конторам (они https) — мягко отвечаем.
    try { res.writeHead(501); res.end("bridge: only HTTPS (CONNECT) supported"); } catch { /* ignore */ }
  });

  server.on("connect", (req, clientSocket, head) => {
    const i = req.url.lastIndexOf(":");
    const dhost = req.url.slice(0, i);
    const dport = Number(req.url.slice(i + 1)) || 443;
    SocksClient.createConnection({ proxy, command: "connect", destination: { host: dhost, port: dport } })
      .then(({ socket }) => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) socket.write(head);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
        const kill = () => { try { socket.destroy(); } catch { /* ignore */ } try { clientSocket.destroy(); } catch { /* ignore */ } };
        socket.on("error", kill);
        clientSocket.on("error", kill);
        clientSocket.on("close", kill);
      })
      .catch(() => { try { clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); clientSocket.end(); } catch { /* ignore */ } });
  });

  server.on("clientError", (_e, sock) => { try { sock.destroy(); } catch { /* ignore */ } });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({ url: `http://127.0.0.1:${p}`, port: p, close: () => { try { server.close(); } catch { /* ignore */ } } });
    });
  });
}

module.exports = { startSocksBridge };
