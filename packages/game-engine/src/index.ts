import {
  MOVES,
  RECIPES,
  directionsOf,
  energyOf,
  isGroupAttack,
} from "@game/data";
import type { Direction, TurnAction } from "@game/protocol";

export type MoveInstance = {
  id: string;
  moveId: string;
  playedRound: number;
  availableFromRound: number;
  consumed: boolean;
};
export type Effect = {
  defense: number;
  remainingRounds: number;
  shield: number;
};
export type Player = {
  id: string;
  name: string;
  armor: number;
  alive: boolean;
  moves: MoveInstance[];
  effects: Effect[];
};
export type GameState = { id: string; round: number; players: Player[] };
export type Event = { type: string; [key: string]: unknown };
export type Prepared = {
  playerId: string;
  moveId: string;
  instance: MoveInstance;
  targetPlayerId?: string;
  attack: number;
  defense: number;
  dodge?: Direction;
  ingredients: string[];
  kind: string;
};

const counts = (xs: string[]) =>
  xs.reduce<Record<string, number>>(
    (a, x) => ((a[x] = (a[x] ?? 0) + 1), a),
    {},
  );
const same = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const ac = counts(a),
    bc = counts(b);
  const keys = Object.keys(ac);
  return (
    keys.length === Object.keys(bc).length && keys.every((k) => ac[k] === bc[k])
  );
};
export function canSynthesize(product: string, materialMoveIds: string[]) {
  return (RECIPES[product] ?? []).some((r) => same(r, materialMoveIds));
}

export function prepareAction(state: GameState, action: TurnAction): Prepared {
  const player = state.players.find((x) => x.id === action.playerId);
  if (!player || !player.alive) throw Error("玩家不存在或已死亡");
  let moveId: string,
    ingredients: string[] = [];
  if (action.play.type === "direct") {
    moveId = action.play.moveId;
    if (!MOVES[moveId]?.direct) throw Error("该招式不能直接打出");
  } else {
    moveId = action.play.productId;
    ingredients = action.play.ingredientInstanceIds;
    const unique = new Set(ingredients);
    if (unique.size !== ingredients.length) throw Error("材料实例重复");
    const found = ingredients.map((id) =>
      player.moves.find((m) => m.id === id),
    );
    if (
      found.some((x) => !x || x.consumed || x.availableFromRound > state.round)
    )
      throw Error("材料不可用");
    if (
      !canSynthesize(
        moveId,
        found.map((x) => x!.moveId),
      )
    )
      throw Error("配方不匹配");
  }
  const def = MOVES[moveId];
  const kind = def?.kind ?? (energyOf(moveId) > 0 ? "attack" : "attack");
  const rawAttack = kind === "attack" ? energyOf(moveId) : 0;
  const converted = action.attackToDefense ?? 0;
  if (!Number.isInteger(converted) || converted < 0 || converted > rawAttack)
    throw Error("攻转防数值非法");
  if (
    kind === "attack" &&
    !isGroupAttack(moveId) &&
    !state.players.some(
      (x) => x.id === action.targetPlayerId && x.alive && x.id !== player.id,
    )
  )
    throw Error("单体攻击必须选择其他存活玩家");
  return {
    playerId: player.id,
    moveId,
    instance: {
      id: `${state.round}-${action.actionId}`,
      moveId,
      playedRound: state.round,
      availableFromRound: state.round + 1,
      consumed: false,
    },
    targetPlayerId: action.targetPlayerId,
    attack: rawAttack - converted,
    defense: (def?.defense ?? 0) + converted,
    dodge: def?.direction,
    ingredients,
    kind,
  };
}

// 同步回合中，已锁定动作不会因玩家本回合死亡而失效。单体攻击先合计并消耗防御，
// 群攻随后只取最高值，并继续消耗同一个防御池。
export function resolveRound(
  state: GameState,
  prepared: Prepared[],
): { state: GameState; events: Event[] } {
  const next: GameState = structuredClone(state);
  const events: Event[] = [];
  const byId = new Map(prepared.map((x) => [x.playerId, x]));
  for (const p of next.players) {
    const a = byId.get(p.id);
    if (!a) continue;
    for (const id of a.ingredients)
      p.moves.find((m) => m.id === id)!.consumed = true;
    p.moves.push(a.instance);
    events.push({ type: "move-played", playerId: p.id, moveId: a.moveId });
  }
  for (const target of next.players.filter((p) => p.alive)) {
    const own = byId.get(target.id);
    let singles = 0,
      group = 0;
    for (const atk of prepared) {
      if (atk.playerId === target.id || atk.attack <= 0) continue;
      const aimed =
        isGroupAttack(atk.moveId) || atk.targetPlayerId === target.id;
      if (!aimed) continue;
      if (own?.dodge && !directionsOf(atk.moveId).has(own.dodge)) {
        events.push({
          type: "dodged",
          playerId: target.id,
          moveId: atk.moveId,
        });
        continue;
      }
      if (isGroupAttack(atk.moveId)) group = Math.max(group, atk.attack);
      else singles += atk.attack;
    }
    const persistent = target.effects.reduce((s, e) => s + e.defense, 0);
    let defense = (own?.defense ?? 0) + persistent;
    const singleDamage = Math.max(0, singles - defense);
    defense = Math.max(0, defense - singles);
    const damage = singleDamage + Math.max(0, group - defense);
    const shieldMove =
      own && MOVES[own.moveId]?.kind === "shield"
        ? MOVES[own.moveId]
        : undefined;
    let finalDamage = damage;
    // 本回合打出的铜墙铁壁立即提供一次性抵伤。一次性抵伤统一在攻防计算之后、
    // 扣除护甲和死亡判定之前结算。
    const newEffect =
      own && MOVES[own.moveId]?.duration
        ? {
            defense: MOVES[own.moveId].defense!,
            remainingRounds: MOVES[own.moveId].duration!,
            shield: MOVES[own.moveId].shieldGrant ?? 0,
          }
        : undefined;
    if (finalDamage > 0) {
      const buffer = [
        ...target.effects,
        ...(newEffect ? [newEffect] : []),
      ].find((e) => e.shield > 0);
      if (buffer) {
        buffer.shield--;
        finalDamage--;
        events.push({ type: "shield-point-used", playerId: target.id });
      }
    }
    if (shieldMove && damage === 0) {
      target.armor += shieldMove.armorGrant ?? 0;
      events.push({
        type: "shield-succeeded",
        playerId: target.id,
        armorGranted: shieldMove.armorGrant,
      });
    } else {
      target.armor -= finalDamage;
      if (shieldMove && damage > 0)
        events.push({ type: "shield-failed", playerId: target.id });
    }
    if (newEffect) target.effects.push(newEffect);
    target.alive = target.armor >= 0;
    if (finalDamage)
      events.push({
        type: "damaged",
        playerId: target.id,
        damage: finalDamage,
        armor: target.armor,
      });
    if (!target.alive) events.push({ type: "died", playerId: target.id });
  }
  for (const p of next.players) for (const e of p.effects) e.remainingRounds--;
  for (const p of next.players)
    p.effects = p.effects.filter((e) => e.remainingRounds > 0);
  next.round++;
  return { state: next, events };
}
