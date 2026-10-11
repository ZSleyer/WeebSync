import { describe, expect, it } from 'vitest'
import { generate } from './gen-api.mjs'

const spec = (schemas) => ({ components: { schemas } })

describe('gen-api', () => {
  it('maps required, optional, nullable, refs, maps, enums and any', () => {
    const out = generate(
      spec({
        'api.Kind': { type: 'integer', enum: [0, 1] },
        'api.T': {
          type: 'object',
          required: ['id', 'next', 'parent', 'tags', 'counts', 'raw', 'kind'],
          properties: {
            id: { type: 'integer', description: 'the id */' },
            name: { type: 'string' },
            next: { type: ['integer', 'null'] },
            parent: { anyOf: [{ $ref: '#/components/schemas/api.T' }, { type: 'null' }] },
            tags: { type: 'array', items: { type: 'string' }, uniqueItems: false },
            counts: { type: 'object', additionalProperties: { type: 'integer' } },
            raw: {},
            kind: { $ref: '#/components/schemas/api.Kind' },
            'x-y': { type: 'boolean' },
          },
        },
      }),
    )
    expect(out).toContain(`'api.Kind': 0 | 1`)
    expect(out).toContain('     * the id *\\/')
    expect(out).toContain('    id: number\n')
    expect(out).toContain('    name?: string\n')
    expect(out).toContain('    next: number | null\n')
    expect(out).toContain(`    parent: Schemas['api.T'] | null\n`)
    expect(out).toContain('    tags: string[]\n')
    expect(out).toContain('    counts: Partial<Record<string, number>>\n')
    expect(out).toContain('    raw: unknown\n')
    expect(out).toContain(`    kind: Schemas['api.Kind']\n`)
    expect(out).toContain(`    'x-y'?: boolean\n`)
  })

  it('fails on keywords it does not know', () => {
    expect(() => generate(spec({ 'api.T': { allOf: [] } }))).toThrow('api.T: unsupported keyword allOf')
    expect(() => generate(spec({ 'api.T': { $ref: '#/definitions/X' } }))).toThrow('unsupported $ref')
  })
})
