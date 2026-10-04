// A stand-in for the Plow API, just enough for an agent image to boot, list
// its chats, receive messages over the websocket and call the model. Every
// model request is recorded and answered with a short reply, so a turn
// shows the exact system prompt, tools and user message the image assembles.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const latch = JSON.parse(readFileSync(new URL("./latch-stub.json", import.meta.url), "utf8"));

// The Mac's MCP server, as far as boot and tool listing need it.
function mcp(rpc) {
  if (rpc.method === "initialize") return { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "replay-latch-stub", version: "1" }, instructions: latch.instructions };
  if (rpc.method === "tools/list") return { tools: latch.tools };
  if (rpc.method === "tools/call") return { content: [{ type: "text", text: "{}" }] };
  return {};
}

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

// The smallest websocket server the plow transport needs: text frames out,
// pings answered, everything else ignored.
function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([header, payload]);
}
function acceptSocket(req, socket, onOpen) {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, masked = buffer[1] & 128;
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === 9) socket.write(frame(10, payload));
      if (opcode === 8) socket.end();
    }
  });
  socket.on("error", () => {});
  onOpen(text => socket.write(frame(1, Buffer.from(text))));
}

/**
 * world: { agentName, apiBase (as the agent reaches this server), chats: [{ uid, trusted, members: [{ uid, name, role, handle }] }] }
 * Returns { port, send(chatUid, memberUid, body), requests, close() }.
 */
export async function startFakePlow(world, port = 0) {
  const line = { uid: "ln_replay", display_name: world.agentName };
  const self = { type: "agent", relationship: "self", line };
  const member = m => ({ type: "member", uid: m.uid, display_name: m.name, role: m.role, provider_key: m.handle });
  const chats = new Map(world.chats.map(c => [c.uid, { uid: c.uid, status: "active", trusted: c.trusted, participants: [...c.members.map(member), self] }]));
  const messages = new Map(world.chats.map(c => [c.uid, []]));
  const sockets = [];
  const requests = [];
  let seq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = url.pathname;
    if (process.env.REPLAY_DEBUG) console.error(`fake-plow: ${req.method} ${req.url} ${body.slice(0, 120)}`);
    if (path === "/v1/agents/me") {
      return json(res, 200, { agent: { name: world.agentName }, line, chats: [...chats.values()], mcp_url: `${world.apiBase}/mcp` });
    }
    if (path === "/mcp") {
      // No server-initiated stream: streamable HTTP clients fall back to POST only.
      if (req.method !== "POST") { res.writeHead(405); return res.end(); }
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: mcp(rpc) });
    }
    if (path === "/v1/chats") return json(res, 200, { data: [...chats.values()], has_more: false });
    if (path === "/v1/ws/ticket") return json(res, 200, { ticket: "replay" });
    if (path === "/v1/chat/completions") {
      const request = JSON.parse(body);
      requests.push(request);
      const reply = { role: "assistant", content: "ok" };
      if (!request.stream) return json(res, 200, { id: "replay", object: "chat.completion", model: request.model, choices: [{ index: 0, message: reply, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: "replay", object: "chat.completion.chunk", model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk(reply, null);
      chunk({}, "stop");
      return res.end("data: [DONE]\n\n");
    }
    const chat = /^\/v1\/chats\/([^/]+)(\/.*)?$/.exec(path);
    if (chat && chats.has(chat[1])) {
      if (!chat[2]) return json(res, 200, chats.get(chat[1]));
      if (chat[2] === "/messages" && req.method === "GET") {
        // Newest first; this world has no history beyond the probes.
        return json(res, 200, { data: [], has_more: false });
      }
      if (chat[2] === "/messages") return json(res, 200, { uid: `msg_out_${++seq}` });
      return json(res, 200, {});
    }
    json(res, 404, { detail: "not in the replay fake" });
  });
  const raw = new Set();
  server.on("upgrade", (req, socket) => { raw.add(socket); acceptSocket(req, socket, send => sockets.push(send)); });
  await new Promise(resolve => server.listen(port, "0.0.0.0", resolve));

  return {
    port: server.address().port,
    connected: () => sockets.length > 0,
    requests,
    send(chatUid, memberUid, body) {
      const sender = member(world.chats.find(c => c.uid === chatUid).members.find(m => m.uid === memberUid));
      const message = { uid: `msg_in_${++seq}`, direction: "inbound", body, sender, created_at: new Date().toISOString(), attachments: [] };
      messages.get(chatUid).push(message);
      for (const send of sockets) send(JSON.stringify({ event_type: "message_received", chat_id: chatUid, data: { message } }));
    },
    close: () => { for (const socket of raw) socket.destroy(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}
