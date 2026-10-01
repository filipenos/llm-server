import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { providerNames, type Conversation } from "./types.js";
import { ApiError } from "./errors.js";

export class Store {
  constructor(private root: string) {}
  private path(provider: string, id: string) {
    return join(
      this.root,
      "providers",
      provider,
      "conversations",
      `${id}.json`,
    );
  }
  async get(id: string): Promise<Conversation> {
    if (!/^conv_[0-9a-f-]{36}$/.test(id))
      throw new ApiError(
        400,
        "Invalid conversation ID.",
        "invalid_conversation_id",
        "X-Conversation-Id",
      );
    for (const provider of providerNames) {
      try {
        const value = JSON.parse(
          await readFile(this.path(provider, id), "utf8"),
        ) as Conversation;
        if (
          value.id !== id ||
          value.provider !== provider ||
          !Array.isArray(value.messages)
        )
          throw new Error("Invalid conversation record");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new ApiError(
      404,
      "Conversation not found.",
      "conversation_not_found",
    );
  }
  async save(value: Conversation) {
    const destination = this.path(value.provider, value.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
