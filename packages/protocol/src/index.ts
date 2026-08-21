export type Direction = "上天" | "下地" | "左右";
export type PlayerId = string;
export type MoveId = string;
export type MoveInstanceId = string;

export type TurnActionInput = {
  gameId: string;
  round: number;
  actionId: string;
  targetPlayerId?: PlayerId;
  attackToDefense?: number;
  play:
    | { type: "direct"; moveId: MoveId }
    | {
        type: "synthesis";
        productId: MoveId;
        ingredientInstanceIds: MoveInstanceId[];
      };
};

export type TurnAction = TurnActionInput & { playerId: PlayerId };

export type PublicPlayer = {
  id: PlayerId;
  name: string;
  armor: number;
  alive: boolean;
};
export type GameSnapshot = {
  id: string;
  round: number;
  deadlineAt: number;
  started: boolean;
  players: PublicPlayer[];
};
