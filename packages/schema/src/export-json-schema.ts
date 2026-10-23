/** Build step: writes dist/schemas/<name>.schema.json for every exported schema. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemaSources, toJsonSchema, type JsonSchemaName } from './json-schema.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'schemas');
mkdirSync(outDir, { recursive: true });
for (const name of Object.keys(jsonSchemaSources) as JsonSchemaName[]) {
  writeFileSync(
    join(outDir, `${name}.schema.json`),
    JSON.stringify(toJsonSchema(name), null, 2) + '\n',
  );
}
