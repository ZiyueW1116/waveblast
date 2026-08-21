import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import argon2 from "argon2";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { Server } from "socket.io";

import { resolveRound, type GameState } from "@game/engine";

import { acceptAction, type ActiveGame } from "./room.js";
import { turnActionInputSchema } from "./validation.js";

type AuthenticatedUser = { id: string; username: string };

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  credentials: true,
});
await app.register(cookie);
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

const db = new Database(process.env.DB_FILE ?? "game.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const usernamePattern = /^[\p{L}\p{N}_-]{3,32}$/u;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function findSessionUser(
  token: string | undefined,
): AuthenticatedUser | undefined {
  if (!token) return undefined;

  return db
    .prepare(
      `SELECT u.id, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), Date.now()) as AuthenticatedUser | undefined;
}

function authenticatedUser(
  request: FastifyRequest,
): AuthenticatedUser | undefined {
  return findSessionUser(request.cookies.session);
}

async function createSession(
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
    hashToken(token),
    userId,
    Date.now() + 30 * 86_400_000,
  );
  reply.setCookie("session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86_400,
  });
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function parseCredentials(
  body: unknown,
): { username: string; password: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (
    typeof record.username !== "string" ||
    typeof record.password !== "string"
  ) {
    return undefined;
  }

  const username = record.username.trim();
  if (!usernamePattern.test(username)) return undefined;
  if (record.password.length < 8 || record.password.length > 128)
    return undefined;
  return { username, password: record.password };
}

app.post(
  "/api/register",
  { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
  async (request, reply) => {
    const credentials = parseCredentials(request.body);
    if (!credentials) return reply.code(400).send({ error: "输入不合法" });

    const id = crypto.randomUUID();
    const passwordHash = await argon2.hash(credentials.password, {
      type: argon2.argon2id,
    });

    try {
      db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(
        id,
        credentials.username.toLowerCase(),
        passwordHash,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return reply.code(409).send({ error: "用户名已存在" });
      }
      throw error;
    }

    await createSession(reply, id);
    return { id, name: credentials.username };
  },
);

app.post(
  "/api/login",
  { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
  async (request, reply) => {
    const credentials = parseCredentials(request.body);
    if (!credentials) {
      return reply.code(400).send({ error: "用户名或密码错误" });
    }

    const row = db
      .prepare(
        "SELECT id, username, password_hash FROM users WHERE username = ?",
      )
      .get(credentials.username.toLowerCase()) as
      { id: string; username: string; password_hash: string } | undefined;

    if (
      !row ||
      !(await argon2.verify(row.password_hash, credentials.password))
    ) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }

    await createSession(reply, row.id);
    return { id: row.id, name: row.username };
  },
);

app.get("/api/me", async (request, reply) => {
  return (
    authenticatedUser(request) ?? reply.code(401).send({ error: "未登录" })
  );
});

const games = new Map<string, ActiveGame>();

app.post("/api/games", async (request, reply) => {
  const user = authenticatedUser(request);
  if (!user) return reply.code(401).send({ error: "未登录" });

  const id = crypto.randomUUID();
  const state: GameState = {
    id,
    round: 1,
    players: [
      {
        id: user.id,
        name: user.username,
        armor: 0,
        alive: true,
        moves: [],
        effects: [],
      },
    ],
  };
  games.set(id, {
    state,
    host: user.id,
    actions: new Map(),
    started: false,
  });
  return { id };
});

app.post<{ Params: { id: string } }>(
  "/api/games/:id/join",
  async (request, reply) => {
    const user = authenticatedUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });

    const game = games.get(request.params.id);
    if (!game) return reply.code(404).send({ error: "房间不存在" });
    if (game.started || game.state.players.length >= 12) {
      return reply.code(409).send({ error: "房间已开始或已满" });
    }

    if (!game.state.players.some((player) => player.id === user.id)) {
      game.state.players.push({
        id: user.id,
        name: user.username,
        armor: 0,
        alive: true,
        moves: [],
        effects: [],
      });
    }
    return game.state;
  },
);

const io = new Server(app.server, {
  cors: {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  },
});

function stopGameAfterInternalError(gameId: string, error: unknown): void {
  const game = games.get(gameId);
  if (game) {
    game.started = false;
    game.timer = undefined;
  }
  app.log.error({ error, gameId }, "回合结算失败");
  io.to(gameId).emit("game-error", {
    error: "服务器未能完成本回合结算，对局已暂停",
  });
}

function startRound(gameId: string): void {
  const game = games.get(gameId);
  if (!game) return;

  const deadlineAt = Date.now() + 5_000;
  game.timer = setTimeout(() => {
    try {
      finishRound(gameId);
    } catch (error) {
      stopGameAfterInternalError(gameId, error);
    }
  }, 5_000);
  io.to(gameId).emit("round-open", {
    round: game.state.round,
    deadlineAt,
    state: game.state,
  });
}

function finishRound(gameId: string): void {
  const game = games.get(gameId);
  if (!game) return;

  const result = resolveRound(
    game.state,
    [...game.actions.values()].map((record) => record.prepared),
  );
  game.state = result.state;
  game.actions.clear();
  game.timer = undefined;
  io.to(gameId).emit("round-result", {
    state: game.state,
    events: result.events,
  });

  if (game.state.players.filter((player) => player.alive).length > 1) {
    startRound(gameId);
  }
}

io.use((socket, next) => {
  const rawCookie = socket.handshake.headers.cookie ?? "";
  const token = rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("session="))
    ?.slice("session=".length);
  const user = findSessionUser(token ? decodeURIComponent(token) : undefined);
  if (!user) return next(new Error("unauthorized"));
  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  socket.on(
    "join-game",
    (gameId: unknown, acknowledge?: (result: unknown) => void) => {
      if (typeof gameId !== "string") {
        return acknowledge?.({ error: "房间编号不合法" });
      }
      const game = games.get(gameId);
      if (
        !game ||
        !game.state.players.some((player) => player.id === socket.data.user.id)
      ) {
        return acknowledge?.({ error: "不可加入" });
      }
      socket.join(gameId);
      acknowledge?.({ state: game.state });
    },
  );

  socket.on(
    "start-game",
    (gameId: unknown, acknowledge?: (result: unknown) => void) => {
      if (typeof gameId !== "string") {
        return acknowledge?.({ error: "房间编号不合法" });
      }
      const game = games.get(gameId);
      if (!game || game.host !== socket.data.user.id || game.started) {
        return acknowledge?.({ error: "不可开始" });
      }
      game.started = true;
      startRound(gameId);
      acknowledge?.({ ok: true });
    },
  );

  socket.on(
    "submit-action",
    (raw: unknown, acknowledge?: (result: unknown) => void) => {
      const parsed = turnActionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return acknowledge?.({ error: "动作格式不合法" });
      }

      const game = games.get(parsed.data.gameId);
      if (!game) return acknowledge?.({ error: "对局不存在" });

      try {
        const result = acceptAction(game, socket.data.user.id, parsed.data);
        acknowledge?.(result);
      } catch (error) {
        acknowledge?.({
          error: error instanceof Error ? error.message : "动作无效",
        });
      }
    },
  );
});

const address = await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: "0.0.0.0",
});
app.log.info(`listening ${address}`);
