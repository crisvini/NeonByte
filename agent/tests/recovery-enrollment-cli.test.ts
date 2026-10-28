import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readHiddenTerminalValue, type RawTerminalInput, type TerminalOutput } from "../src/device/recovery-enrollment-cli.js";

class FakeInput extends EventEmitter implements RawTerminalInput {
  isTTY = true;
  rawModes: boolean[] = [];
  resumed = false;
  paused = false;
  setRawMode(value: boolean) { this.rawModes.push(value); }
  resume() { this.resumed = true; }
  pause() { this.paused = true; }
}

class FakeOutput implements TerminalOutput {
  writes: string[] = [];
  write(value: string) { this.writes.push(value); return true; }
}

test("hidden terminal input accepts secret characters without echo and restores normal mode", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const pending = readHiddenTerminalValue("Recovery token", input, output);
  input.emit("data", Buffer.from("0123456789abcdef"));
  input.emit("data", Buffer.from([0x08]));
  input.emit("data", Buffer.from("f\r"));
  assert.equal(await pending, "0123456789abcdef");
  assert.deepEqual(output.writes, ["Recovery token: ", "\n"]);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.resumed, true);
  assert.equal(input.paused, true);
});

test("hidden terminal input refuses non-interactive sessions before requesting a secret", async () => {
  const input = new FakeInput(); input.isTTY = false;
  const output = new FakeOutput();
  await assert.rejects(readHiddenTerminalValue("Recovery token", input, output), /foreground interactive terminal/);
  assert.deepEqual(output.writes, []);
  assert.deepEqual(input.rawModes, []);
});
