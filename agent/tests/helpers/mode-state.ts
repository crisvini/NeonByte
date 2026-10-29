import { DisplayModeController, type DisplayModeStore, type StoredModeState } from "../../src/device/mode-controller.js";
import type { DisplayMode } from "../../src/web/scene.js";

export class MemoryDisplayModeStore implements DisplayModeStore {
  state: StoredModeState | null = null;
  async load(): Promise<StoredModeState | null> { return this.state ? structuredClone(this.state) : null; }
  async save(state: StoredModeState): Promise<void> { this.state = structuredClone(state); }
}

export async function createTestModeController(mode: DisplayMode = "auto", store = new MemoryDisplayModeStore()): Promise<DisplayModeController> {
  const controller = new DisplayModeController(store, mode);
  await controller.initialize();
  return controller;
}
