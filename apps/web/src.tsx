import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";

import { MOVES, RECIPES } from "@game/data";
import type { TurnActionInput } from "@game/protocol";

import "./style.css";

type User = { id: string; name: string };
type MoveInstance = {
  id: string;
  moveId: string;
  availableFromRound: number;
  consumed: boolean;
};
type Player = {
  id: string;
  name: string;
  armor: number;
  alive: boolean;
  moves: MoveInstance[];
};
type GameState = { id: string; round: number; players: Player[] };
type Acknowledgement = { ok?: true; replayed?: boolean; error?: string };

const API = import.meta.env.VITE_API_URL ?? "";
const socket = io(API || undefined, {
  withCredentials: true,
  autoConnect: false,
  retries: 3,
  ackTimeout: 3_000,
});

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: "include",
    ...init,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "请求失败");
  return body;
}

function App() {
  const [user, setUser] = useState<User>();
  const [gameId, setGameId] = useState("");
  const [state, setState] = useState<GameState>();
  const [message, setMessage] = useState("");
  const [deadline, setDeadline] = useState(0);
  const [mode, setMode] = useState<"direct" | "synthesis">("direct");
  const [move, setMove] = useState("运");
  const [product, setProduct] = useState("小波");
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [converted, setConverted] = useState(0);

  useEffect(() => {
    void requestJson<User>("/api/me")
      .then((authenticatedUser) => {
        setUser(authenticatedUser);
        socket.connect();
      })
      .catch(() => undefined);

    socket.on(
      "round-open",
      (payload: { state: GameState; deadlineAt: number }) => {
        setState(payload.state);
        setDeadline(payload.deadlineAt);
        setSelected([]);
      },
    );
    socket.on("round-result", (payload: { state: GameState }) =>
      setState(payload.state),
    );
    socket.on("game-error", (payload: { error: string }) =>
      setMessage(payload.error),
    );

    return () => {
      socket.off("round-open");
      socket.off("round-result");
      socket.off("game-error");
    };
  }, []);

  const ownPlayer = useMemo(
    () => state?.players.find((player) => player.id === user?.id),
    [state, user],
  );
  const available = (ownPlayer?.moves ?? []).filter(
    (instance) =>
      !instance.consumed &&
      state !== undefined &&
      instance.availableFromRound <= state.round,
  );

  async function authenticate(
    path: "register" | "login",
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const authenticatedUser = await requestJson<User>(`/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      setUser(authenticatedUser);
      setMessage("");
      socket.connect();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
    }
  }

  function joinSocket(id: string) {
    socket.emit(
      "join-game",
      id,
      (result: Acknowledgement & { state?: GameState }) => {
        if (result.error) setMessage(result.error);
        if (result.state) setState(result.state);
      },
    );
  }

  async function createGame() {
    try {
      const created = await requestJson<{ id: string }>("/api/games", {
        method: "POST",
      });
      setGameId(created.id);
      joinSocket(created.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建房间失败");
    }
  }

  async function joinGame() {
    try {
      await requestJson<GameState>(`/api/games/${gameId}/join`, {
        method: "POST",
      });
      joinSocket(gameId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加入房间失败");
    }
  }

  function toggleMaterial(id: string) {
    setSelected((ids) =>
      ids.includes(id)
        ? ids.filter((candidate) => candidate !== id)
        : [...ids, id],
    );
  }

  function submitAction() {
    if (!state) return;
    const play: TurnActionInput["play"] =
      mode === "direct"
        ? { type: "direct", moveId: move }
        : {
            type: "synthesis",
            productId: product,
            ingredientInstanceIds: selected,
          };
    const action: TurnActionInput = {
      gameId,
      round: state.round,
      actionId: crypto.randomUUID(),
      play,
      targetPlayerId: target || undefined,
      attackToDefense: converted,
    };

    socket.emit("submit-action", action, (result: Acknowledgement) => {
      setMessage(result.error ?? (result.replayed ? "动作已确认" : "已提交"));
    });
  }

  if (!user) {
    return (
      <main>
        <h1>Waveblast · 波波气</h1>
        <p>{message}</p>
        {(["register", "login"] as const).map((path) => (
          <form key={path} onSubmit={(event) => void authenticate(path, event)}>
            <h2>{path === "register" ? "注册" : "登录"}</h2>
            <input name="username" placeholder="用户名" />
            <input name="password" type="password" placeholder="至少8位密码" />
            <button>确认</button>
          </form>
        ))}
      </main>
    );
  }

  return (
    <main>
      <h1>Waveblast · 波波气</h1>
      <p>你好，{user.name}</p>
      <section>
        <button onClick={() => void createGame()}>创建房间</button>
        <input
          value={gameId}
          onChange={(event) => setGameId(event.target.value)}
          placeholder="房间 ID"
        />
        <button onClick={() => void joinGame()}>加入</button>
        <button onClick={() => socket.emit("start-game", gameId)}>开始</button>
      </section>

      {state && (
        <section>
          <h2>第 {state.round} 回合</h2>
          <p>
            截止：
            {deadline ? new Date(deadline).toLocaleTimeString() : "等待开始"}
          </p>
          <ul>
            {state.players.map((player) => (
              <li key={player.id}>
                {player.name}　护甲 {player.armor}　
                {player.alive ? "存活" : "死亡"}
              </li>
            ))}
          </ul>

          <label>
            方式{" "}
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as "direct" | "synthesis")
              }
            >
              <option value="direct">直接出招</option>
              <option value="synthesis">合成出招</option>
            </select>
          </label>

          {mode === "direct" ? (
            <label>
              招式{" "}
              <select
                value={move}
                onChange={(event) => setMove(event.target.value)}
              >
                {Object.keys(MOVES)
                  .filter((id) => MOVES[id].direct)
                  .map((id) => (
                    <option key={id}>{id}</option>
                  ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                产物{" "}
                <select
                  value={product}
                  onChange={(event) => {
                    setProduct(event.target.value);
                    setSelected([]);
                  }}
                >
                  {Object.keys(RECIPES).map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
              <div>
                <strong>具体材料实例</strong>
                {available.map((instance) => (
                  <label className="material" key={instance.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(instance.id)}
                      onChange={() => toggleMaterial(instance.id)}
                    />
                    {instance.moveId} <small>{instance.id}</small>
                  </label>
                ))}
              </div>
              <p className="hint">
                配方：
                {RECIPES[product]
                  .map((recipe) => recipe.join(" + "))
                  .join("；")}
              </p>
            </>
          )}

          <label>
            目标{" "}
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">选择目标</option>
              {state.players
                .filter((player) => player.id !== user.id && player.alive)
                .map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            攻击转防{" "}
            <input
              type="number"
              min="0"
              value={converted}
              onChange={(event) => setConverted(Number(event.target.value))}
            />
          </label>
          <button onClick={submitAction}>提交动作</button>

          <h3>我的未消费招式实例</h3>
          {available.length ? (
            <ul>
              {available.map((instance) => (
                <li key={instance.id}>
                  {instance.moveId}（{instance.id}）
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无</p>
          )}
        </section>
      )}
      <p>{message}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
