import { prepareAction, type GameState, type Prepared } from "@game/engine";
import type { TurnAction, TurnActionInput } from "@game/protocol";

export type AcceptedAction = {
  actionId: string;
  prepared: Prepared;
};

export type ActiveGame = {
  state: GameState;
  host: string;
  actions: Map<string, AcceptedAction>;
  timer?: NodeJS.Timeout;
  started: boolean;
};

export type ActionAcknowledgement = {
  ok: true;
  actionId: string;
  replayed: boolean;
};

export function acceptAction(
  game: ActiveGame,
  playerId: string,
  input: TurnActionInput,
): ActionAcknowledgement {
  if (!game.started || input.round !== game.state.round) {
    throw new Error("动作回合无效");
  }

  const existing = game.actions.get(playerId);
  if (existing) {
    if (existing.actionId === input.actionId) {
      return { ok: true, actionId: existing.actionId, replayed: true };
    }
    throw new Error("本回合已经提交动作");
  }

  // 玩家身份只来自已验证的连接，不能接受客户端声明的玩家编号。
  const action: TurnAction = { ...input, playerId };
  const prepared = prepareAction(game.state, action);
  game.actions.set(playerId, { actionId: input.actionId, prepared });
  return { ok: true, actionId: input.actionId, replayed: false };
}
