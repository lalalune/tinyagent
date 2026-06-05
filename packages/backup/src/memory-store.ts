import { createHash } from "node:crypto";
import {
  err,
  ok,
  TinyAgentError,
  type Result,
  type Store,
  type StoreHead,
  type StoreListEntry,
} from "@tinyagent/core";

export class MemoryStore implements Store {
  private readonly objects = new Map<string, Uint8Array>();

  async put(input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<Result<StoreHead>> {
    this.objects.set(input.key, new Uint8Array(input.bytes));
    return ok(this.headFor(input.key, input.bytes));
  }

  async get(key: string): Promise<Result<Uint8Array>> {
    const value = this.objects.get(key);
    if (!value)
      return err(
        new TinyAgentError("STORE_NOT_FOUND", `missing object: ${key}`),
      );
    return ok(new Uint8Array(value));
  }

  async head(key: string): Promise<Result<StoreHead | null>> {
    const value = this.objects.get(key);
    return ok(value ? this.headFor(key, value) : null);
  }

  async list(prefix: string): Promise<Result<StoreListEntry[]>> {
    return ok(
      [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => this.headFor(key, value))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }

  async delete(key: string): Promise<Result<void>> {
    this.objects.delete(key);
    return ok(undefined);
  }

  private headFor(key: string, bytes: Uint8Array): StoreHead {
    return {
      key,
      size: bytes.byteLength,
      etag: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}

/**
 * A Store decorator that injects a put failure on the Nth `put` call
 * (1-indexed). Used by tests to simulate an interrupted upload and verify that
 * the `latest` pointer is only advanced after chunks and manifest commit
 * successfully. All non-failing operations delegate to the wrapped store, so
 * any objects written before the fault remain readable — exactly the partial
 * state a real interrupted upload would leave behind.
 */
export class FaultInjectingStore implements Store {
  putCount = 0;

  constructor(
    private readonly inner: Store,
    private readonly failOnPut: number,
  ) {}

  async put(input: Parameters<Store["put"]>[0]): Promise<Result<StoreHead>> {
    this.putCount += 1;
    if (this.putCount === this.failOnPut) {
      return err(
        new TinyAgentError(
          "STORE_PUT_FAULT",
          `injected put failure on call ${this.putCount} for ${input.key}`,
        ),
      );
    }
    return this.inner.put(input);
  }

  async get(key: string): Promise<Result<Uint8Array>> {
    return this.inner.get(key);
  }

  async head(key: string): Promise<Result<StoreHead | null>> {
    return this.inner.head(key);
  }

  async list(prefix: string): Promise<Result<StoreListEntry[]>> {
    return this.inner.list(prefix);
  }

  async delete(key: string): Promise<Result<void>> {
    return this.inner.delete?.(key) ?? ok(undefined);
  }
}
