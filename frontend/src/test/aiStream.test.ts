import { describe, expect, it } from 'vitest'
import { parseSseChunk, type AiEvent } from '../api'

// The chat stream arrives in network-sized pieces that cut lines anywhere;
// the parser has to hand the torn tail back and pick it up on the next call.
describe('parseSseChunk', () => {
  it('reassembles events split across chunks and skips keepalives', () => {
    const chunks = [
      'data: {"type":"tool","na',
      'me":"search_remote"}\n\n: keepalive\ndata: {"type":"delta","text":"Hel',
      'lo"}\ndata: {"type":"do',
      'ne"}\n',
    ]
    const events: AiEvent[] = []
    let rest = ''
    for (const c of chunks) {
      const r = parseSseChunk(rest, c)
      rest = r.rest
      events.push(...r.events)
    }
    expect(rest).toBe('')
    expect(events).toEqual([
      { type: 'tool', name: 'search_remote' },
      { type: 'delta', text: 'Hello' },
      { type: 'done' },
    ])
  })

  it('keeps an unfinished line as rest and drops malformed frames', () => {
    const r = parseSseChunk('', 'data: not json\ndata: {"type":"delta","text":"x"}\ndata: {"type":"del')
    expect(r.events).toEqual([{ type: 'delta', text: 'x' }])
    expect(r.rest).toBe('data: {"type":"del')
  })
})
