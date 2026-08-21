import { z } from "zod";

const identifier = z.string().min(1).max(128);

export const turnActionInputSchema = z
  .object({
    gameId: identifier,
    round: z.number().int().positive(),
    actionId: z.string().uuid(),
    targetPlayerId: identifier.optional(),
    attackToDefense: z.number().int().nonnegative().optional(),
    play: z.discriminatedUnion("type", [
      z.object({ type: z.literal("direct"), moveId: identifier }).strict(),
      z
        .object({
          type: z.literal("synthesis"),
          productId: identifier,
          ingredientInstanceIds: z.array(identifier).max(64),
        })
        .strict(),
    ]),
  })
  .strict();
