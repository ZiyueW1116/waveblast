import assert from "node:assert/strict";
import test from "node:test";

import type { GameState } from "@game/engine";
import type { TurnActionInput } from "@game/protocol";

import { acceptAction, type ActiveGame } from "../src/room.js";
import { turnActionInputSchema } from "../src/validation.js";

function game(): ActiveGame {
  const state: GameState = {
    id: "game-1",
    round: 1,
    players: [
      {
        id: "player-1",
        name: "玩家一",
        armor: 0,
        alive: true,
        moves: [],
        effects: [],
      },
    ],
  };
  return { state, host: "player-1", actions: new Map(), started: true };
}

function action(
  actionId = "01933f5e-51e1-7a22-9ed8-a7288d474f01",
): TurnActionInput {
  return {
    gameId: "game-1",
    round: 1,
    actionId,
    play: { type: "direct", moveId: "运" },
    attackToDefense: 0,
  };
}

test("网络动作拒绝客户端声明的额外玩家编号", () => {
  const parsed = turnActionInputSchema.safeParse({
    ...action(),
    playerId: "attacker",
  });
  assert.equal(parsed.success, false);
});

test("网络动作拒绝畸形输入", () => {
  assert.equal(turnActionInputSchema.safeParse(null).success, false);
  assert.equal(
    turnActionInputSchema.safeParse({ gameId: "game-1" }).success,
    false,
  );
  assert.equal(
    turnActionInputSchema.safeParse({ ...action(), actionId: "not-a-uuid" })
      .success,
    false,
  );
});

test("相同 actionId 重试返回首次成功结果", () => {
  const activeGame = game();
  const first = acceptAction(activeGame, "player-1", action());
  const replay = acceptAction(activeGame, "player-1", action());

  assert.deepEqual(first, {
    ok: true,
    actionId: action().actionId,
    replayed: false,
  });
  assert.deepEqual(replay, {
    ok: true,
    actionId: action().actionId,
    replayed: true,
  });
  assert.equal(activeGame.actions.size, 1);
});

test("同一玩家不能用不同 actionId 重复出招", () => {
  const activeGame = game();
  acceptAction(activeGame, "player-1", action());

  assert.throws(
    () =>
      acceptAction(
        activeGame,
        "player-1",
        action("01933f5e-51e1-7a22-9ed8-a7288d474f02"),
      ),
    /本回合已经提交动作/,
  );
});
