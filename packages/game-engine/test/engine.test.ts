import test from "node:test";
import assert from "node:assert/strict";
import {
  canSynthesize,
  resolveRound,
  type GameState,
  type Prepared,
} from "../src/index.ts";
import { MOVES, RECIPES, energyOf } from "@game/data";
const base = (): GameState => ({
  id: "g",
  round: 1,
  players: [
    { id: "a", name: "a", armor: 0, alive: true, moves: [], effects: [] },
    { id: "b", name: "b", armor: 0, alive: true, moves: [], effects: [] },
  ],
});
const move = (
  playerId: string,
  moveId: string,
  attack = 0,
  defense = 0,
  targetPlayerId?: string,
): Prepared => ({
  playerId,
  moveId,
  targetPlayerId,
  attack,
  defense,
  ingredients: [],
  kind: "attack",
  instance: {
    id: playerId + moveId,
    moveId,
    playedRound: 1,
    availableFromRound: 2,
    consumed: false,
  },
});
test("recipe is multiset", () =>
  assert.equal(canSynthesize("中波", ["运", "运"]), true));
test("recipe material order is irrelevant", () =>
  assert.equal(canSynthesize("大波", ["小波", "中波"]), true));
test("dodge avoids uncovered attack", () => {
  const s = base();
  const r = resolveRound(s, [
    move("a", "小波", 1, 0, "b"),
    { ...move("b", "上天"), kind: "dodge", dodge: "上天" },
  ]);
  assert.equal(r.state.players[1].armor, 0);
});
test("attack converts to defense", () => {
  const s = base();
  const r = resolveRound(s, [
    move("a", "小波", 1, 0, "b"),
    move("b", "冲拳", 0, 1, "a"),
  ]);
  assert.equal(r.state.players[1].armor, 0);
});
test("group attacks take maximum and exclude self", () => {
  const s = base();
  s.players.push({
    id: "c",
    name: "c",
    armor: 4,
    alive: true,
    moves: [],
    effects: [],
  });
  s.players[1].armor = 4;
  const r = resolveRound(s, [move("a", "冰龙波", 2), move("c", "黑龙波", 3)]);
  assert.equal(r.state.players[0].armor, -3);
  assert.equal(r.state.players[1].armor, 1);
  assert.equal(r.state.players[2].armor, 2);
});
test("armor exactly zero lives", () => {
  const s = base();
  s.players[1].armor = 1;
  const r = resolveRound(s, [move("a", "小波", 1, 0, "b")]);
  assert.equal(r.state.players[1].alive, true);
});
test("shield succeeds or fails", () => {
  let s = base();
  let r = resolveRound(s, [move("b", "能量盾", 0, 2)]);
  assert.equal(r.state.players[1].armor, 2);
  s = base();
  r = resolveRound(s, [
    move("a", "大波", 3, 0, "b"),
    move("b", "能量盾", 0, 2),
  ]);
  assert.equal(r.state.players[1].armor, -1);
  assert.equal(r.state.players[1].alive, false);
});
test("铜墙铁壁抵挡任意正数最终伤害，然后消失", () => {
  const s = base();
  s.players[1].armor = 3;
  s.players[1].effects = [{ defense: 0, remainingRounds: 2, shield: 1 }];
  let r = resolveRound(s, [move("a", "小波", 1, 0, "b")]);
  assert.equal(r.state.players[1].armor, 3);
  assert.equal(r.state.players[1].effects[0].shield, 0);
  r = resolveRound(r.state, [move("a", "小波", 1, 0, "b")]);
  assert.equal(r.state.players[1].armor, 2);
});
test("complex recipe alternatives are complete", () => {
  assert.equal(RECIPES["六气斩"].length, 8);
  assert.equal(RECIPES["空明斩"].length, 8);
  assert.equal(RECIPES["钻石异能冲"].length, 10);
  assert.equal(RECIPES["十字异能风"].length, 10);
  assert.equal(RECIPES["异能钢铁洪流"].length, 5);
  assert.equal(RECIPES["旋地异能风"].length, 5);
});
test("all recipe names resolve and have finite energy", () => {
  const known = new Set([...Object.keys(MOVES), ...Object.keys(RECIPES)]);
  for (const [product, recipes] of Object.entries(RECIPES)) {
    assert.ok(known.has(product));
    for (const recipe of recipes)
      for (const material of recipe)
        assert.ok(
          known.has(material),
          `${product} references unknown ${material}`,
        );
    assert.ok(Number.isFinite(energyOf(product)), product);
  }
});
