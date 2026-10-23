import { describe, expect, it } from 'vitest';
import { jsonSchemaSources, toJsonSchema, type JsonSchemaName } from './json-schema.js';

describe('JSON Schema export', () => {
  it.each(Object.keys(jsonSchemaSources) as JsonSchemaName[])('exports %s', (name) => {
    const schema = toJsonSchema(name);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  it('includes campaign fields and treats defaulted fields as optional input', () => {
    const schema = toJsonSchema('project') as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const key of ['campaignId', 'scheduledDate', 'platformTargets', 'status']) {
      expect(schema.properties).toHaveProperty(key);
      expect(schema.required).not.toContain(key);
    }
    expect(schema.required).toEqual(expect.arrayContaining(['schemaVersion', 'id', 'brief']));
  });
});
