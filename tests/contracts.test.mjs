import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractRoot = new URL("../contracts/v1/", import.meta.url);
const contractV2Root = new URL("../contracts/v2/", import.meta.url);

async function readJson(relativePath, root = contractRoot) {
  const contents = await readFile(new URL(relativePath, root), "utf8");
  return JSON.parse(contents);
}

function validateContractValue(schema, value, path = "$") {
  if (schema.type === "object") {
    assert.equal(typeof value, "object", path + " must be an object");
    assert.notEqual(value, null, path + " must not be null");
    assert.equal(Array.isArray(value), false, path + " must not be an array");

    for (const requiredKey of schema.required ?? []) {
      assert.ok(requiredKey in value, path + " is missing " + requiredKey);
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(key in schema.properties, path + " has unknown property " + key);
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        validateContractValue(propertySchema, value[key], path + "." + key);
      }
    }
    return;
  }

  if (schema.type === "array") {
    assert.equal(Array.isArray(value), true, path + " must be an array");
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, path + " has too few items");
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, path + " has too many items");
    if (schema.prefixItems) {
      assert.ok(value.length <= schema.prefixItems.length, path + " has too many items");
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) validateContractValue(itemSchema, value[index], path + "[" + index + "]");
      });
    }
    return;
  }

  if (schema.type === "string") {
    assert.equal(typeof value, "string", path + " must be a string");
    if (schema.minLength !== undefined) {
      assert.ok(value.length >= schema.minLength, path + " is too short");
    }
    if (schema.maxLength !== undefined) {
      assert.ok(value.length <= schema.maxLength, path + " is too long");
    }
    if (schema.pattern !== undefined) assert.match(value, new RegExp(schema.pattern), path + " has an invalid format");
  } else if (schema.type === "integer") {
    assert.equal(Number.isInteger(value), true, path + " must be an integer");
    if (schema.minimum !== undefined) {
      assert.ok(value >= schema.minimum, path + " is below its minimum");
    }
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, path + " is above its maximum");
  } else if (schema.type === "boolean") {
    assert.equal(typeof value, "boolean", path + " must be a boolean");
  }

  if (schema.enum !== undefined) {
    assert.ok(schema.enum.includes(value), path + " is not an allowed value");
  }
  if (schema.const !== undefined) {
    assert.equal(value, schema.const, path + " must equal its fixed value");
  }
}

test("all contract schemas use the declared JSON Schema draft and unique ids", async () => {
  const schemaFiles = [
    "mode.schema.json",
    "now-playing.schema.json",
    "status.schema.json",
    "error.schema.json",
  ];
  const schemas = await Promise.all(schemaFiles.map((file) => readJson(file)));

  assert.ok(schemas.every((schema) =>
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
  ));
  assert.equal(new Set(schemas.map((schema) => schema.$id)).size, schemas.length);
});

test("mode examples cover exactly auto, spotify, and gif", async () => {
  const schema = await readJson("mode.schema.json");
  const examples = await Promise.all(
    ["auto", "spotify", "gif"].map((mode) =>
      readJson("examples/mode-" + mode + ".json")
    )
  );

  assert.deepEqual(schema.properties.mode.enum, ["auto", "spotify", "gif"]);
  assert.deepEqual(examples.map((example) => example.mode), schema.properties.mode.enum);
  for (const example of examples) {
    validateContractValue(schema, example);
  }
  assert.throws(() => validateContractValue(schema, { mode: "dashboard" }));
});

test("Now Playing example matches the required metadata and timing contract", async () => {
  const schema = await readJson("now-playing.schema.json");
  const example = await readJson("examples/now-playing.json");

  validateContractValue(schema, example);
  assert.deepEqual(Object.keys(example).sort(), [...schema.required].sort());
  assert.ok(example.progressMs <= example.durationMs);
  assert.throws(() => validateContractValue(schema, { ...example, progressMs: -1 }));
  assert.throws(() => validateContractValue(schema, { ...example, unexpected: true }));
});

test("status exposes only the two planned scenes and protocol v1", async () => {
  const schema = await readJson("status.schema.json");
  const example = await readJson("examples/status.json");

  validateContractValue(schema, example);
  assert.equal(schema.properties.protocolVersion.const, "v1");
  assert.deepEqual(schema.properties.activeScene.enum, ["spotify", "gif"]);
  assert.throws(() => validateContractValue(schema, { ...example, activeScene: "waiting" }));
});

test("error example has a stable code and bounded non-empty message", async () => {
  const schema = await readJson("error.schema.json");
  const example = await readJson("examples/error.json");

  validateContractValue(schema, example);
  assert.throws(() => validateContractValue(schema, { code: "invalid_request" }));
});

test("v2 animation schemas use the declared draft and unique ids", async () => {
  const files = ["media-capabilities.schema.json", "upload-session.schema.json", "upload-status.schema.json", "error.schema.json"];
  const schemas = await Promise.all(files.map((file) => readJson(file, contractV2Root)));
  assert.ok(schemas.every((schema) => schema.$schema === "https://json-schema.org/draft/2020-12/schema"));
  assert.equal(new Set(schemas.map((schema) => schema.$id)).size, schemas.length);
});

test("v2 media capabilities and upload examples match bounded upload contracts", async () => {
  const capabilities = await readJson("media-capabilities.schema.json", contractV2Root);
  const session = await readJson("upload-session.schema.json", contractV2Root);
  const status = await readJson("upload-status.schema.json", contractV2Root);
  const error = await readJson("error.schema.json", contractV2Root);
  const capabilitiesExample = await readJson("examples/media-capabilities.json", contractV2Root);
  const statusExample = await readJson("examples/upload-status.json", contractV2Root);
  validateContractValue(capabilities, capabilitiesExample);
  validateContractValue(session, await readJson("examples/upload-session.json", contractV2Root));
  validateContractValue(status, statusExample);
  validateContractValue(error, await readJson("examples/error-insufficient-storage.json", contractV2Root));
  assert.throws(() => validateContractValue(capabilities, { ...capabilitiesExample, maxChunkBytes: 4096 }));
  assert.throws(() => validateContractValue(status, { ...statusExample, unexpected: true }));
});

