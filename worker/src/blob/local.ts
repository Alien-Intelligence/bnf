import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BlobStore } from "./interface.js";

/** Filesystem BlobStore. Useful for fast iteration and debug-by-grep. */
export class LocalFsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private resolveKey(key: string): string {
    if (key.includes("..")) {
      throw new Error(`Refusing blob key with path traversal: ${key}`);
    }
    return join(this.root, key);
  }

  async put(key: string, body: Buffer | string, _contentType?: string): Promise<void> {
    const full = this.resolveKey(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolveKey(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async remove(key: string): Promise<boolean> {
    try {
      await unlink(this.resolveKey(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
