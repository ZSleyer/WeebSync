import { beforeEach, describe, expect, it } from 'vitest'
import { avgSpeed, pushSpeedSample, resetSpeedHistory, SPEED_SPAN, speedSamples } from '../speedHistory'

describe('speedHistory', () => {
  beforeEach(() => resetSpeedHistory())

  it('keeps one sample per second, newest last', () => {
    pushSpeedSample(10, 1000)
    pushSpeedSample(20, 2000)
    expect(speedSamples()).toEqual([10, 20])
  })

  it('ignores a second push within the same second', () => {
    pushSpeedSample(10, 1000)
    pushSpeedSample(99, 1400)
    expect(speedSamples()).toEqual([10])
  })

  it('fills a gap with zeros, so the strip stays a true span', () => {
    pushSpeedSample(10, 1000)
    pushSpeedSample(30, 4000)
    expect(speedSamples()).toEqual([10, 0, 0, 30])
  })

  it('trims to the span, gap included', () => {
    pushSpeedSample(1, 1000)
    pushSpeedSample(2, 1000 + 500 * 1000)
    expect(speedSamples()).toHaveLength(SPEED_SPAN)
    expect(speedSamples().at(-1)).toBe(2)
    expect(speedSamples()[0]).toBe(0)
  })

  it('hands out the same snapshot until something is pushed', () => {
    pushSpeedSample(10, 1000)
    const a = speedSamples()
    expect(speedSamples()).toBe(a)
    pushSpeedSample(10, 2000)
    expect(speedSamples()).not.toBe(a)
  })

  it('averages the newest samples for the ETA, zero before any', () => {
    expect(avgSpeed()).toBe(0)
    for (let i = 0; i < 20; i++) pushSpeedSample(i < 10 ? 100 : 200, 1000 * (i + 1))
    expect(avgSpeed(10)).toBe(200)
    expect(avgSpeed(20)).toBe(150)
  })
})
