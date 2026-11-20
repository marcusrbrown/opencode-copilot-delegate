import { describe, expect, it } from 'bun:test'
import { overrideEnv, setEnv } from './helpers/env'

const KEY = 'OCD_ENV_HELPER_TEST_VAR'

describe('env test helper', () => {
  it('deletes the variable on restore when it was originally unset', () => {
    // Given a variable that is unset
    delete process.env[KEY]

    // When it is overridden and then restored
    const restore = overrideEnv([KEY], { [KEY]: 'temporary' })
    expect(process.env[KEY]).toBe('temporary')
    restore()

    // Then it is absent, not the string "undefined"
    expect(KEY in process.env).toBe(false)
    expect(process.env[KEY]).toBeUndefined()
  })

  it('restores the original value when it was set', () => {
    // Given a variable with a value
    process.env[KEY] = 'original'

    // When it is overridden and then restored
    const restore = overrideEnv([KEY], { [KEY]: 'temporary' })
    restore()

    // Then the original value returns
    expect(process.env[KEY]).toBe('original')
    delete process.env[KEY]
  })

  it('deletes a set variable when overridden with undefined', () => {
    process.env[KEY] = 'original'

    const restore = overrideEnv([KEY], { [KEY]: undefined })
    expect(KEY in process.env).toBe(false)
    restore()

    expect(process.env[KEY]).toBe('original')
    setEnv(KEY, undefined)
  })
})
